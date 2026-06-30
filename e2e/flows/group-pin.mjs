// ── group-pin flow ─────────────────────────────────────────────────────────
// Proves the Config v2 PIN-gated group path end-to-end against the sbx stack.
//
// The sandbox config (config.sbx.json) defines a second account "visitor"
// (password "visitor-pass") whose visible_users are Carol (pin_required: true,
// pin "5678") and Dave (no pin). This flow logs in AS visitor — explicitly,
// filling the login form, NOT the auto-login admin — then drives:
//   1. login screen                                  -> group-pin-login.png
//   2. picker shows ONLY Carol (PIN badge) + Dave    -> group-pin-picker.png
//   3. select Carol -> a PIN input appears           -> group-pin-prompt.png
//   4. WRONG pin -> group NOT activated (error shown) -> group-pin-wrong.png
//   5. correct pin 5678 -> group forms, app proceeds  -> group-pin-success.png
//
// Run it with:
//   PROOF_FLOW=group-pin ./scripts/sbx.sh run --rm proof
//
// NOTE: run.mjs logs in (auto-login admin in sbx) BEFORE dispatching flows. To
// log in as a DIFFERENT account we first log out, then BLOCK the client's
// implicit auto-login POST (an empty-body /api/auth/login) so the login form
// stays put for us to fill with the visitor credentials.
export const match = /group-pin|pin/i;

const VISITOR_USERNAME = 'visitor';
const VISITOR_PASSWORD = 'visitor-pass';
const CAROL_PIN = '5678';

export async function run(page, ctx) {
  const { fail, shoot, flowName } = ctx;

  console.log('[proof] group-pin: resetting to a logged-out state for explicit visitor login');

  // Kill the client's auto-login AT THE DECISION POINT. The client auto-logins
  // whenever GET /api/session reports portalAutoLoginEnabled: true (the sbx admin
  // PORTAL_* env) and retries on failure — fighting the implicit POST per-request
  // can't win (it storms thousands of retries, and a body-classifier stub can
  // misread the real visitor submit as empty and 401 it). Instead, intercept
  // /api/session, fetch the REAL response, and patch portalAutoLoginEnabled to
  // false. With the flag false the client NEVER attempts auto-login, so the login
  // form renders cleanly on the logged-out page. Installed BEFORE the logout/
  // reload and left in place for the whole flow (the client re-polls session).
  await page.route('**/api/session', async (route) => {
    try {
      const response = await route.fetch();
      let json;
      try {
        json = await response.json();
      } catch {
        // Non-JSON (shouldn't happen) — pass through untouched.
        await route.fulfill({ response });
        return;
      }
      json.portalAutoLoginEnabled = false;
      await route.fulfill({
        response,
        contentType: 'application/json',
        body: JSON.stringify(json),
      });
    } catch (error) {
      // Never let the patch take down the flow — fall back to the real response.
      console.log(`[proof] group-pin: /api/session patch failed (${error?.message ?? error}); continuing`);
      await route.continue().catch(() => {});
    }
  });

  // Log out the account run.mjs established (admin in sbx), then reload so the
  // app re-evaluates the session. With auto-login disabled via the patched
  // session, the logged-out page renders the login form. Wait on the DOM load
  // event (element waits below are the real gate).
  const logoutBtn = page.getByRole('button', { name: 'Log out' }).first();
  if (await logoutBtn.count().then((n) => n > 0)) {
    await logoutBtn.click().catch(() => {});
  }
  await page.reload({ waitUntil: 'load' });

  // ── 1. Login screen ──────────────────────────────────────────────────────
  const loginForm = page.locator('form.stack');
  try {
    await loginForm.waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    await shoot(page, `${flowName}-login-MISSING`);
    fail('group-pin: login form never appeared (session auto-login patch not applied?)', error);
  }
  await shoot(page, 'group-pin-login');

  // ── 1b. Submit visitor credentials (deterministic) ───────────────────────
  // Auto-login is disabled via the patched /api/session above, so there is no
  // implicit-login storm to race. We still gate success on the EXPLICIT login
  // RESPONSE (not form-detach): arm waitForResponse for the credentialed POST
  // BEFORE clicking, assert it's 200, THEN wait for the picker heading. A single
  // retry remains as a safety net but should not be needed.
  const pickHeading = page.getByRole('heading', { name: /pick the group/i });
  const usernameInput = loginForm.locator('input:not([type="password"])').first();
  const passwordInput = loginForm.locator('input[type="password"]').first();
  const submitBtn = loginForm.locator('button[type="submit"]');

  // Matches ONLY our explicit credentialed submit (body has "username").
  const isExplicitLoginResponse = (response) => {
    const request = response.request();
    if (!response.url().includes('/api/auth/login') || request.method() !== 'POST') {
      return false;
    }
    let body = '';
    try {
      body = request.postData() ?? '';
    } catch {
      body = '';
    }
    return body.includes('"username"');
  };

  async function attemptVisitorLogin(attempt) {
    console.log(`[proof] group-pin: visitor login attempt ${attempt} as "${VISITOR_USERNAME}"`);
    // Let any in-flight auto-login finish so the button is interactable before we
    // type (the click + response wait below is what determines success).
    await submitBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('form.stack button[type="submit"]');
        return btn instanceof HTMLButtonElement && !btn.disabled;
      },
      undefined,
      { timeout: 15_000 },
    ).catch(() => {});

    await usernameInput.fill('');
    await usernameInput.fill(VISITOR_USERNAME);
    await passwordInput.fill('');
    await passwordInput.fill(VISITOR_PASSWORD);

    // Arm the response wait BEFORE clicking so we can't miss a fast response.
    const responsePromise = page
      .waitForResponse(isExplicitLoginResponse, { timeout: 15_000 })
      .catch(() => null);
    await submitBtn.click();
    const response = await responsePromise;

    if (!response) {
      console.log('[proof] group-pin: no explicit login response observed within timeout');
      return false;
    }
    if (response.status() !== 200) {
      console.log(`[proof] group-pin: explicit login returned ${response.status()} (expected 200)`);
      return false;
    }
    console.log('[proof] group-pin: explicit visitor login -> 200; waiting for picker');

    // 200 confirmed; the picker should render next.
    try {
      await pickHeading.waitFor({ state: 'visible', timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  }

  let loggedIn = await attemptVisitorLogin(1);
  if (!loggedIn) {
    const stale = await page.locator('.error').first().textContent().catch(() => null);
    console.log(`[proof] group-pin: first visitor login did not reach the picker (error: ${stale ? stale.trim() : 'none'}); retrying once`);
    loggedIn = await attemptVisitorLogin(2);
  }

  if (!loggedIn) {
    const err = await page.locator('.error').first().textContent().catch(() => null);
    await shoot(page, `${flowName}-login-FAILED`);
    fail(`group-pin: visitor login did not complete after retry${err ? ` (app error: ${err.trim()})` : ''}`);
  }

  // ── 2. Picker shows ONLY Carol (PIN badge) + Dave ────────────────────────
  try {
    await pickHeading.waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    await shoot(page, `${flowName}-picker-MISSING`);
    fail('group-pin: "Pick the group" screen did not appear after visitor login', error);
  }

  const cards = page.locator('button.viewer-card');
  const names = (await cards.locator('strong').allTextContents()).map((s) => s.trim());
  console.log('[proof] group-pin: visible viewer cards =', JSON.stringify(names));
  await shoot(page, 'group-pin-picker');

  const expected = ['Carol', 'Dave'];
  const sameSet =
    names.length === expected.length && expected.every((n) => names.includes(n));
  if (!sameSet) {
    fail(
      `group-pin: visitor should see exactly [${expected.join(', ')}] but saw [${names.join(', ')}]`,
    );
  }

  // Carol's card must carry a PIN badge; Dave's must not.
  const carolCard = cards.filter({ hasText: 'Carol' }).first();
  const daveCard = cards.filter({ hasText: 'Dave' }).first();
  const carolBadge = await carolCard.locator('.badge', { hasText: /PIN/i }).count();
  const daveBadge = await daveCard.locator('.badge', { hasText: /PIN/i }).count();
  console.log(`[proof] group-pin: PIN badge — Carol=${carolBadge} Dave=${daveBadge}`);
  if (carolBadge < 1) {
    fail('group-pin: Carol is pin_required for visitor but has NO PIN badge on her card');
  }
  if (daveBadge !== 0) {
    fail('group-pin: Dave is NOT pin gated for visitor but shows a PIN badge');
  }
  console.log('[proof] group-pin: PASS — picker shows only Carol (PIN) + Dave');

  // ── 3. Select Carol -> a PIN input appears ───────────────────────────────
  await carolCard.click();
  const pinPrompts = page.locator('.pin-prompts');
  try {
    await pinPrompts.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    await shoot(page, `${flowName}-prompt-MISSING`);
    fail('group-pin: selecting Carol did NOT reveal a PIN input', error);
  }
  const pinInput = pinPrompts.locator('input[type="password"]').first();
  await pinInput.waitFor({ state: 'visible', timeout: 10_000 });
  await shoot(page, 'group-pin-prompt');
  console.log('[proof] group-pin: PASS — PIN input appeared for Carol');

  const continueBtn = page.getByRole('button', { name: /^Continue$/ }).first();

  // ── 4. WRONG pin -> group NOT activated (error surfaced, stays on picker) ──
  await pinInput.fill('0000');
  await continueBtn.click();
  // The wrong-pin path returns 403; the client surfaces it in .error and stays
  // on the picker (heading remains).
  const errorBox = page.locator('.error').first();
  try {
    await errorBox.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    await shoot(page, `${flowName}-wrong-NO-ERROR`);
    fail('group-pin: a wrong PIN did not surface an error', error);
  }
  const errorText = (await errorBox.textContent().catch(() => '')) ?? '';
  const stillOnPicker = await pickHeading.isVisible().catch(() => false);
  console.log('[proof] group-pin: wrong-pin error =', JSON.stringify(errorText.trim()));
  console.log('[proof] group-pin: still on picker after wrong pin =', stillOnPicker);
  await shoot(page, 'group-pin-wrong');
  if (!stillOnPicker) {
    fail('group-pin: a wrong PIN should NOT activate the group, but the picker was left');
  }
  if (!/pin/i.test(errorText)) {
    fail(`group-pin: wrong-pin error did not mention the PIN (got: ${JSON.stringify(errorText.trim())})`);
  }
  console.log('[proof] group-pin: PASS — wrong PIN rejected (403 surfaced, group not activated)');

  // ── 5. Correct pin -> group forms, app proceeds ──────────────────────────
  // The error clears on a successful submit; re-fill the (still-present) PIN
  // input with the correct value and continue. Gate on leaving the picker via
  // an element wait (not networkidle — background data fetches keep the network
  // busy after the group forms).
  await pinInput.fill(CAROL_PIN);
  await continueBtn.click();
  try {
    await pickHeading.waitFor({ state: 'detached', timeout: 20_000 });
  } catch (error) {
    const err = await page.locator('.error').first().textContent().catch(() => null);
    await shoot(page, `${flowName}-success-STUCK`);
    fail(
      `group-pin: correct PIN did not form the group / left the picker${err ? ` (app error: ${err.trim()})` : ''}`,
      error,
    );
  }

  // The main app proceeded: the Continue-watching heading AND the "Change
  // viewers" control (only present post-group) render. Wait on each separately —
  // combining them with .or() matches BOTH once home renders, which trips
  // Playwright strict mode and aborts the success assertion.
  const continueHeading = page.getByRole('heading', { name: /continue watching/i }).first();
  const changeViewersBtn = page.getByRole('button', { name: /change viewers/i }).first();
  try {
    await Promise.all([
      continueHeading.waitFor({ state: 'visible', timeout: 20_000 }),
      changeViewersBtn.waitFor({ state: 'visible', timeout: 20_000 }),
    ]);
  } catch (error) {
    await shoot(page, `${flowName}-success-NO-HOME`);
    fail('group-pin: group formed but the main app (continue-watching/home) did not render', error);
  }
  await shoot(page, 'group-pin-success');
  console.log('[proof] group-pin: PASS — correct PIN formed the group and the app proceeded');
}
