// ── group-pin flow ─────────────────────────────────────────────────────────
// Proves the Config v2 guest (tertiary) PIN-gated group path end-to-end against
// the sbx stack.
//
// The sandbox config (config.sbx.json) defines a second account "visitor"
// (access token "sbx-visitor-token") with no primaries, Dave as a secondary and
// Carol as a TERTIARY (guest; pin "5678" in users[]). Guests never render as
// plain viewer cards — they are only addable via the SELECTION-ONLY "+ Add
// guest" modal (no PIN inputs there). PINs are typed at Continue time in the
// continue-time PIN modal, and the "Confirm PINs" click verifies them with the
// server IMMEDIATELY (POST /api/group/verify-pins): a 403 pin rejection shows
// the server's error inside the STILL-OPEN modal — before any mixed-group
// warning or group POST — for a retype. /api/group stays authoritative for the
// eventual group creation.
// This flow logs in AS visitor — explicitly, filling the token form, NOT the
// auto-login household — then drives:
//   1. login screen (single access-token input)        -> group-pin-login.png
//   2. picker: Dave card only; Carol NOT a plain card;
//      "+ Add guest" card present                       -> group-pin-picker.png
//   3. open "+ Add guest": Carol listed; NO PIN input;
//      confirm adds her without a PIN; Continue opens
//      the PIN modal for her                            -> group-pin-prompt.png
//   4. WRONG pin -> confirm click -> verify-pins 403;
//      the modal NEVER closes, NO mixed warning; the
//      server error shows in the modal, picker kept     -> group-pin-wrong.png
//   5. retype correct pin 5678 in the same modal ->
//      verify ok -> mixed warning -> POST /api/group ->
//      group forms, app proceeds                        -> group-pin-success.png
//
// Run it with:
//   PROOF_FLOW=group-pin ./scripts/sbx.sh run --rm proof
//
// NOTE: run.mjs logs in (auto-login household in sbx) BEFORE dispatching flows.
// To log in as a DIFFERENT account we first log out, then defeat the client's
// implicit auto-login by patching GET /api/session (portalAutoLoginEnabled:
// false) so the login form stays put for us to fill with the visitor token.
export const match = /group-pin|pin/i;

const VISITOR_TOKEN = 'sbx-visitor-token';
const CAROL_PIN = '5678';

export async function run(page, ctx) {
  const { fail, shoot, flowName } = ctx;

  console.log('[proof] group-pin: resetting to a logged-out state for explicit visitor login');

  // Kill the client's auto-login AT THE DECISION POINT. The client auto-logins
  // whenever GET /api/session reports portalAutoLoginEnabled: true (the sbx
  // ACCESS_TOKEN env) and retries on failure — fighting the implicit POST
  // per-request can't win (it storms thousands of retries, and a body-classifier
  // stub can misread the real visitor submit as empty and 401 it). Instead,
  // intercept /api/session, fetch the REAL response, and patch
  // portalAutoLoginEnabled to false. With the flag false the client NEVER
  // attempts auto-login, so the login form renders cleanly on the logged-out
  // page. Installed BEFORE the logout/reload and left in place for the whole
  // flow (the client re-polls session).
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

  // Log out the account run.mjs established (household in sbx), then reload so
  // the app re-evaluates the session. Log out also forgets any localStorage
  // token, and with auto-login disabled via the patched session, the logged-out
  // page renders the login form. Wait on the DOM load event (element waits
  // below are the real gate).
  const logoutBtn = page.getByRole('button', { name: 'Log out' }).first();
  if (await logoutBtn.count().then((n) => n > 0)) {
    await logoutBtn.click().catch(() => {});
  }
  await page.reload({ waitUntil: 'load' });

  // ── 1. Login screen (single access-token input) ──────────────────────────
  const loginForm = page.locator('form.stack');
  try {
    await loginForm.waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    await shoot(page, `${flowName}-login-MISSING`);
    fail('group-pin: login form never appeared (session auto-login patch not applied?)', error);
  }
  await shoot(page, 'group-pin-login');

  // ── 1a. Deliberately invalid access token -> 401 rejection, form persists ──
  // Proves the login form REJECTS a bogus token with a clear error and does
  // NOT persist a token (still on the login form afterwards) before we try the
  // real visitor login below.
  {
    const invalidResponsePromise = page
      .waitForResponse(
        (response) =>
          response.url().includes('/api/auth/login') && response.request().method() === 'POST',
        { timeout: 15_000 },
      )
      .catch(() => null);
    const invalidTokenInput = loginForm.locator('input[type="password"]').first();
    await invalidTokenInput.fill('not-a-real-token');
    await loginForm.locator('button[type="submit"]').click();
    const invalidResponse = await invalidResponsePromise;
    if (!invalidResponse) {
      await shoot(page, `${flowName}-invalid-token-NO-RESPONSE`);
      fail('group-pin: submitting an invalid access token never hit POST /api/auth/login');
    }
    if (invalidResponse.status() < 400 || invalidResponse.status() >= 500) {
      await shoot(page, `${flowName}-invalid-token-WRONG-STATUS`);
      fail(`group-pin: invalid access token should be rejected 4xx (got ${invalidResponse.status()})`);
    }
    // `.error` renders as a SIBLING of form.stack (both under .auth-panel), not
    // nested inside the form — scope to the panel, not the form itself.
    const loginError = page.locator('.auth-panel .error').first();
    try {
      await loginError.waitFor({ state: 'visible', timeout: 10_000 });
    } catch (error) {
      await shoot(page, `${flowName}-invalid-token-NO-ERROR`);
      fail('group-pin: an invalid access token did not surface a visible error on the login form', error);
    }
    const invalidErrorText = ((await loginError.textContent().catch(() => '')) ?? '').trim();
    console.log('[proof] group-pin: invalid-token login error =', JSON.stringify(invalidErrorText));
    if (!invalidErrorText) {
      fail('group-pin: the invalid-token error text was empty');
    }
    // The login form must still be showing (nothing authenticated/persisted).
    if (!(await loginForm.isVisible().catch(() => false))) {
      await shoot(page, `${flowName}-invalid-token-FORM-GONE`);
      fail('group-pin: the login form disappeared after an invalid token — it must persist for retry');
    }
    const storedToken = await page.evaluate(() => window.localStorage.getItem('gogglebox.accessToken'));
    if (storedToken) {
      fail('group-pin: an invalid access token must not be persisted to localStorage');
    }
    await shoot(page, 'group-pin-invalid-token');
    console.log('[proof] group-pin: PASS — invalid access token rejected (4xx + visible error), login form persists, no token stored');
  }

  // ── 1b. Submit the visitor access token (deterministic) ──────────────────
  // Auto-login is disabled via the patched /api/session above, so there is no
  // implicit-login storm to race. We still gate success on the EXPLICIT login
  // RESPONSE (not form-detach): arm waitForResponse for the token POST BEFORE
  // clicking, assert it's 200, THEN wait for the picker heading. A single retry
  // remains as a safety net but should not be needed.
  const pickHeading = page.getByRole('heading', { name: /pick the group/i });
  const tokenInput = loginForm.locator('input[type="password"]').first();
  const submitBtn = loginForm.locator('button[type="submit"]');

  // Matches ONLY our explicit token submit (body carries the visitor token) —
  // never an implicit empty-body auto-login POST.
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
    return body.includes(VISITOR_TOKEN);
  };

  async function attemptVisitorLogin(attempt) {
    console.log(`[proof] group-pin: visitor login attempt ${attempt} with the visitor access token`);
    // Let any in-flight request finish so the button is interactable before we
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

    await tokenInput.fill('');
    await tokenInput.fill(VISITOR_TOKEN);

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
    console.log('[proof] group-pin: explicit visitor token login -> 200; waiting for picker');

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

  // ── 2. Picker: Dave only; Carol NOT a plain card; "+ Add guest" present ───
  try {
    await pickHeading.waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    await shoot(page, `${flowName}-picker-MISSING`);
    fail('group-pin: "Pick the group" screen did not appear after visitor login', error);
  }

  const cards = page.locator('button.viewer-card:not(.saved-group-card):not(.add-guest-card)');
  const names = (await cards.locator('strong').allTextContents()).map((s) => s.trim());
  console.log('[proof] group-pin: plain viewer cards =', JSON.stringify(names));
  await shoot(page, 'group-pin-picker');

  // Visitor: Dave (secondary) is the only plain card; Carol (tertiary/guest)
  // must NOT be one.
  const expected = ['Dave'];
  const sameSet =
    names.length === expected.length && expected.every((n) => names.includes(n));
  if (!sameSet) {
    fail(
      `group-pin: visitor should see exactly [${expected.join(', ')}] as plain cards but saw [${names.join(', ')}]`,
    );
  }
  if (names.includes('Carol')) {
    fail('group-pin: Carol is a GUEST for visitor and must not render as a plain viewer card');
  }

  const addGuestCard = page.locator('button.add-guest-card').first();
  if (!(await addGuestCard.count().then((n) => n > 0))) {
    fail('group-pin: the "+ Add guest" card is missing (visitor has Carol as a guest candidate)');
  }
  console.log('[proof] group-pin: PASS — picker shows only Dave plus the "+ Add guest" card');

  // ── 3. "+ Add guest": Carol listed, selection-only (NO PIN input) ─────────
  // The add-guest modal collects no PINs — confirming adds Carol to the
  // selection, and her PIN is typed later at Continue time.
  const guestModal = page.locator('.guest-modal');
  await addGuestCard.click();
  try {
    await guestModal.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    await shoot(page, `${flowName}-guest-modal-MISSING`);
    fail('group-pin: clicking "+ Add guest" did not open the guest modal', error);
  }
  const carolGuestCard = guestModal.locator('button.guest-card', { hasText: 'Carol' }).first();
  if (!(await carolGuestCard.count().then((n) => n > 0))) {
    await shoot(page, `${flowName}-guest-carol-MISSING`);
    fail('group-pin: Carol is not listed in the guest modal');
  }
  await carolGuestCard.click();
  if (await guestModal.locator('input[type="password"]').count().then((n) => n > 0)) {
    await shoot(page, `${flowName}-add-guest-HAS-PIN`);
    fail('group-pin: the add-guest modal must be selection-only — no PIN input belongs there');
  }
  const addGuestsBtn = guestModal.getByRole('button', { name: /^Add guests$/ });
  if (await addGuestsBtn.isDisabled()) {
    fail('group-pin: add-guest confirm should ENABLE once Carol is selected (no PIN required)');
  }
  await addGuestsBtn.click();
  await guestModal.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
  if (!(await cards.filter({ hasText: 'Carol' }).count().then((n) => n > 0))) {
    await shoot(page, `${flowName}-carol-NOT-ADDED`);
    fail('group-pin: confirming the add-guest modal did not add Carol to the picker selection');
  }
  console.log('[proof] group-pin: PASS — add-guest modal is selection-only and added Carol without a PIN');

  const continueBtn = page.getByRole('button', { name: /^Continue$/ }).first();
  const confirmModal = page.locator('.confirm-modal');
  const pinInput = guestModal.locator('input[type="password"]').first();
  const confirmPinsBtn = guestModal.getByRole('button', { name: /^Confirm PINs$/ });

  // ── 3b. Continue opens the continue-time PIN modal for Carol ──────────────
  await continueBtn.click();
  try {
    await guestModal.waitFor({ state: 'visible', timeout: 10_000 });
    await pinInput.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    await shoot(page, `${flowName}-pin-modal-MISSING`);
    fail('group-pin: Continue with a selected guest did not open the PIN modal', error);
  }
  if (!(await confirmPinsBtn.isDisabled())) {
    fail('group-pin: the PIN-modal confirm must be DISABLED until Carol\'s PIN is typed');
  }
  await shoot(page, 'group-pin-prompt');
  console.log('[proof] group-pin: PASS — Continue routed to the PIN modal; confirm disabled until PIN typed');

  // Confirm the PIN modal (the confirm click verifies the pins with the server
  // via POST /api/group/verify-pins), then the mixed-group (shared watch
  // progress) warning — it always appears on success (a guest is never
  // primary) — so the authoritative group POST fires.
  const confirmPinsAndMixed = async () => {
    await confirmPinsBtn.click();
    try {
      await confirmModal.waitFor({ state: 'visible', timeout: 10_000 });
    } catch (error) {
      await shoot(page, `${flowName}-mixed-modal-MISSING`);
      fail('group-pin: the mixed-group confirmation modal did not appear before the group POST', error);
    }
    // Human-readable proof of the warning ITSELF (not just a DOM assertion) —
    // screenshot before dismissing it.
    await shoot(page, 'group-pin-mixed-warning');
    await confirmModal.getByRole('button', { name: /^Confirm$/ }).click();
  };

  // ── 4. WRONG pin -> verify-pins 403 AT the confirm click ──────────────────
  // "Confirm PINs" must contact the server immediately: arm the wait for the
  // verify-pins response BEFORE clicking, assert the 403, and assert the
  // rejection lands IN the still-open modal — the modal never closes and the
  // mixed-group warning never appears. Never stub pin validation.
  await pinInput.fill('0000');
  if (await confirmPinsBtn.isDisabled()) {
    fail('group-pin: the PIN-modal confirm should ENABLE once a PIN is typed');
  }
  const verifyResponsePromise = page
    .waitForResponse(
      (response) =>
        response.url().includes('/api/group/verify-pins') &&
        response.request().method() === 'POST',
      { timeout: 10_000 },
    )
    .catch(() => null);
  await confirmPinsBtn.click();
  const verifyResponse = await verifyResponsePromise;
  if (!verifyResponse) {
    await shoot(page, `${flowName}-wrong-NO-VERIFY`);
    fail('group-pin: clicking "Confirm PINs" did not hit POST /api/group/verify-pins');
  }
  if (verifyResponse.status() !== 403) {
    fail(`group-pin: verify-pins returned ${verifyResponse.status()} for a wrong PIN (expected 403)`);
  }

  const modalError = guestModal.locator('.error').first();
  try {
    await modalError.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    await shoot(page, `${flowName}-wrong-NO-ERROR`);
    fail('group-pin: a wrong PIN did not surface the server error at the PIN modal', error);
  }
  // The modal must have STAYED open (rejection at the click, not after a
  // reopen), and the mixed-group warning must not have appeared first.
  if (!(await guestModal.isVisible().catch(() => false))) {
    await shoot(page, `${flowName}-wrong-MODAL-CLOSED`);
    fail('group-pin: the PIN modal closed on a wrong PIN — the rejection must show in the still-open modal');
  }
  if (await confirmModal.isVisible().catch(() => false)) {
    await shoot(page, `${flowName}-wrong-MIXED-SHOWN`);
    fail('group-pin: the mixed-group warning appeared for a wrong PIN — verification must happen first');
  }
  const errorText = (await modalError.textContent().catch(() => '')) ?? '';
  const stillOnPicker = await pickHeading.isVisible().catch(() => false);
  console.log('[proof] group-pin: wrong-pin modal error =', JSON.stringify(errorText.trim()));
  console.log('[proof] group-pin: still on picker after wrong pin =', stillOnPicker);
  await shoot(page, 'group-pin-wrong');
  if (!stillOnPicker) {
    fail('group-pin: a wrong PIN should NOT activate the group, but the picker was left');
  }
  if (!/pin/i.test(errorText)) {
    fail(`group-pin: wrong-pin error did not mention the PIN (got: ${JSON.stringify(errorText.trim())})`);
  }
  console.log('[proof] group-pin: PASS — wrong PIN rejected AT the confirm click (verify-pins 403 in the still-open modal, no mixed warning, group not activated)');

  // ── 5. Retype the correct pin in the SAME open modal -> group forms ───────
  // The rejection cleared the typed pin (retype starts clean); type the correct
  // PIN and resubmit — this time verify passes, the modal closes, the mixed
  // warning shows, and the group POST proceeds.
  await pinInput.waitFor({ state: 'visible', timeout: 10_000 });
  await pinInput.fill(CAROL_PIN);
  await confirmPinsAndMixed();

  // Gate on leaving the picker via an element wait (not networkidle —
  // background data fetches keep the network busy after the group forms).
  try {
    await pickHeading.waitFor({ state: 'detached', timeout: 20_000 });
  } catch (error) {
    const err = await page.locator('.error').first().textContent().catch(() => null);
    await shoot(page, `${flowName}-success-STUCK`);
    fail(
      `group-pin: correct PIN did not form the group / leave the picker${err ? ` (app error: ${err.trim()})` : ''}`,
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
  console.log('[proof] group-pin: PASS — correct guest PIN formed the group and the app proceeded');
}
