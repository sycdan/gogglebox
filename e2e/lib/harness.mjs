// Shared proof harness: fail + screenshot + retry helpers. These are bound to a
// run's outDir via createHarness(outDir) so flow modules can call ctx.shoot(...)
// etc. without threading the output directory through every call.
import path from 'node:path';

export function fail(message, error) {
  console.error(`[proof] FAIL: ${message}`);
  if (error) console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
}

// Detached-element guard. Pages that hydrate/re-render after data loads can
// detach an element between a locator's waitFor() and the action that follows
// (classic "Element is not attached to the DOM"). Re-query the locator on each
// attempt and retry the op a few times so a benign re-render doesn't crash.
export async function withRetry(label, op, { attempts = 5, delayMs = 250 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await op();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const detached =
        /not attached to the DOM|detached|Element is not attached|Node is detached/i.test(msg);
      lastError = error;
      if (!detached || i === attempts - 1) throw error;
      console.log(`[proof] ${label}: element detached (re-render), retrying (${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

// Scroll a locator into view, re-resolving it each attempt so a re-render that
// detaches the previously-resolved handle doesn't abort the run. `getLocator`
// returns a fresh Locator (Playwright auto-waits on it) on every call.
export async function safeScroll(label, getLocator, { block = 'start', timeout = 15_000 } = {}) {
  await withRetry(label, async () => {
    const loc = getLocator();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.scrollIntoViewIfNeeded({ timeout });
  });
}

// Build the per-run harness bound to outDir. shoot = full-page; shootView =
// viewport-only (stays under image size limits so the Prover can Read it).
export function createHarness(outDir) {
  async function shoot(page, name) {
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`[proof] screenshot: ${file}`);
    return file;
  }

  async function shootView(page, name) {
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`[proof] screenshot: ${file}`);
    return file;
  }

  return { fail, shoot, shootView, withRetry, safeScroll, outDir };
}
