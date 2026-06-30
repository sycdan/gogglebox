// Browser launch + navigate + login + assert-authenticated. Returns the live
// { browser, page } so run.mjs can dispatch flows and close the browser in its
// own finally block.
import { chromium } from 'playwright';

// Read the running app's OWN auto-login decision from GET /api/session
// (portalAutoLoginEnabled). The app derives this from whether PORTAL creds are
// set (server.ts: Boolean(config.portalCredentials)), so the harness drives off
// real app state instead of a separate PORTAL_AUTO_LOGIN env var. Best-effort: a
// failed read falls back to false (drive the manual login form), always safe.
async function readAutoLoginEnabled(page) {
  try {
    const session = await page.evaluate(async () => {
      const res = await fetch('/api/session', { credentials: 'same-origin' });
      if (!res.ok) return null;
      return res.json();
    });
    return Boolean(session?.portalAutoLoginEnabled);
  } catch {
    return false;
  }
}

export async function startSession({ url, username, password, flowName, shoot, fail }) {
  const browser = await chromium.launch({
    // New headless ("--headless=new") is far more likely to honour the
    // Fullscreen API than the legacy headless shell. We also allow auto-grant
    // of the fullscreen request without a user-gesture prompt.
    args: [
      "--headless=new",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=FullscreenInsecureOrigin",
    ],
  });

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

  // Determine auto-login from the running app, not an env var: if the app reports
  // portalAutoLoginEnabled the client logs itself in (we just wait for the
  // authenticated state below); otherwise we fill the manual login form.
  const autoLogin = await readAutoLoginEnabled(page);
  console.log(`[proof] app auto-login enabled = ${autoLogin}`);

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

  return { browser, page };
}
