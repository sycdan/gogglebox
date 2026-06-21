// Visual-proof driver. Runs inside the `proof` service (Playwright image),
// logs into the running client, and writes full-page screenshots to
// ./artifacts/<timestamp>/ so the Prover agent can Read them.
//
// Usage (via dev compose):
//   docker compose -f docker-compose.dev.yml --profile proof run --rm proof
//   docker compose -f docker-compose.dev.yml --profile proof run --rm -e PROOF_FLOW=my-feature proof
//
// Env:
//   PROOF_URL        target client URL (default http://client:5173)
//   PROOF_FLOW       flow name prefixing screenshot files (default "app";
//                    falls back to the first CLI arg if unset)
//   PORTAL_USERNAME  household login username (required)
//   PORTAL_PASSWORD  household login password (required)
//   PORTAL_AUTO_LOGIN  "true"/"1" skips the login form
//
// Exits non-zero on navigation/login failure so agents detect breakage.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const url = process.env.PROOF_URL ?? 'http://client:5173';
const username = process.env.PORTAL_USERNAME ?? '';
const password = process.env.PORTAL_PASSWORD ?? '';
const autoLogin = ['1', 'true', 'yes', 'on'].includes(
  (process.env.PORTAL_AUTO_LOGIN ?? '').trim().toLowerCase(),
);
const flowName = (process.env.PROOF_FLOW || process.argv[2] || 'app').replace(
  /[^a-zA-Z0-9_-]/g,
  '-',
);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve('artifacts', stamp);

function fail(message, error) {
  console.error(`[proof] FAIL: ${message}`);
  if (error) console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
}

async function shoot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`[proof] screenshot: ${file}`);
  return file;
}

const browser = await chromium.launch();
try {
  await mkdir(outDir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  console.log(`[proof] navigating to ${url}`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  } catch (error) {
    fail(`could not load ${url} (is the client service up?)`, error);
  }

  // Wait for the SPA to settle past its "Loading…" state.
  await page.waitForLoadState('networkidle');

  // Vite serves a plain-text "Blocked request. This host is not allowed."
  // page when the Host header isn't in allowedHosts — the SPA never mounts.
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  if (/Blocked request\.\s*This host is not allowed/i.test(bodyText)) {
    await shoot(page, `${flowName}-00-blocked`);
    fail(
      `Vite blocked the request host for ${url}. ` +
        'Add the hostname to server.allowedHosts in vite.config.ts and restart the client service.',
    );
  }

  const loginForm = page.locator('form.stack');
  const needsLogin = await loginForm.count().then((n) => n > 0);

  if (needsLogin && !autoLogin) {
    if (!username || !password) {
      fail('login form present but PORTAL_USERNAME/PORTAL_PASSWORD not set');
    }
    console.log('[proof] logging in');
    await loginForm.locator('input:not([type="password"])').first().fill(username);
    await loginForm.locator('input[type="password"]').first().fill(password);
    await shoot(page, `${flowName}-01-login`);
    await Promise.all([
      page.waitForLoadState('networkidle'),
      loginForm.locator('button[type="submit"]').click(),
    ]);
    // Confirm we left the login screen.
    try {
      await loginForm.waitFor({ state: 'detached', timeout: 15_000 });
    } catch (error) {
      const err = await page.locator('.error').textContent().catch(() => null);
      fail(`login did not complete${err ? ` (app error: ${err.trim()})` : ''}`, error);
    }
  }

  await page.waitForLoadState('networkidle');

  // Assert a REAL authenticated app element rather than treating "no login
  // form" as success. The "Log out" button is rendered on both the
  // viewer-selection screen and the main app (see src/client/App.tsx).
  const loggedIn = page.getByRole('button', { name: 'Log out' });
  try {
    await loggedIn.first().waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    await shoot(page, `${flowName}-02-not-authenticated`);
    const appError = await page.locator('.error').first().textContent().catch(() => null);
    fail(
      'authenticated app never appeared (no "Log out" control)' +
        (appError ? ` — app error: ${appError.trim()}` : ''),
      error,
    );
  }

  await shoot(page, `${flowName}-02-authenticated`);

  console.log('[proof] OK');
} catch (error) {
  fail('unexpected error during proof run', error);
} finally {
  await browser.close();
}
