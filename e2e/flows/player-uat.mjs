import { selectExactViewersByName, continueFromPicker, viewerCards } from '../lib/viewer.mjs';

// ── player-uat flow ─────────────────────────────────────────────────────────
// A UAT-safe, player-handoff-style click-through that proves a real Play/Resume
// click opens the player against a REAL Jellyfin library (criterion 6's UAT
// half), without assuming any sandbox-only fixture shape:
//   - `group-alias` hard-codes the sbx two-primary fixture (Alice + Bob); real
//     UAT config may have only ONE primary. This flow selects viewer(s)
//     GENERICALLY: whatever primaries are already preselected (falling back to
//     the first plain viewer card if none are preselected), never a fixed count
//     or fixed pair of names.
//   - `player-focus` locates "a Play/Resume button" with an .or() across the
//     WHOLE page, which is ambiguous (Playwright strict mode) once a larger
//     real library renders more than one media-card with a Play/Resume button.
//     This flow scopes the locator to a SINGLE chosen .media-card (the first
//     one that has a Play or Resume button) rather than matching page-wide.
//
// Works against both sbx and uat (any account/library shape); does not depend
// on continue-watching data, an exact primary count, or a specific title.
//
// Run it with:
//   PROOF_FLOW=player-uat ./scripts/sbx.sh run --rm proof
//   PROOF_FLOW=player-uat ./scripts/uat.sh run --rm proof
export const match = /player-uat|uat-player/i;

async function pickAnyGroupAndContinue(page, label) {
  const pickHeading = page.getByRole('heading', { name: /pick the group/i });
  if (!(await pickHeading.count().then((n) => n > 0))) {
    console.log(`[proof] ${label}: already in main app (no viewer-selection screen)`);
    return;
  }

  // Prefer whatever primaries already arrive preselected (no fixed name/count
  // assumption); fall back to just the first plain viewer card if nothing is
  // preselected.
  const cards = viewerCards(page);
  const count = await cards.count();
  const preselected = [];
  for (let index = 0; index < count; index += 1) {
    const selected = await cards.nth(index).evaluate((el) => el.classList.contains('selected'));
    if (selected) preselected.push(index);
  }

  if (preselected.length > 0) {
    console.log(`[proof] ${label}: keeping ${preselected.length} preselected primary card(s) as-is`);
  } else if (count > 0) {
    console.log(`[proof] ${label}: nothing preselected; selecting the first viewer card`);
    const firstLabel = ((await cards.first().locator('strong').first().textContent()) ?? '').trim();
    await selectExactViewersByName(page, [firstLabel]);
  } else {
    throw new Error(`${label}: no viewer cards found on the picker`);
  }

  await continueFromPicker(page, label);
}

export async function run(page, ctx) {
  const { fail, shoot, shootView, flowName } = ctx;

  // ── Guard: same-origin proxy required (same reasoning as player-handoff) ──
  // The /player route and shared localStorage origin only exist behind the
  // proxy; against the bare Vite client the iframe never reaches a logged-in
  // Jellyfin view, which would otherwise surface as a confusing timeout below.
  const origin = await page.evaluate(() => window.location.origin);
  console.log(`[proof] player-uat: running against origin ${origin}`);
  if (/:5173(\/|$)/.test(origin)) {
    await shootView(page, `${flowName}-00-wrong-origin`);
    fail(
      `player-uat must run against the same-origin proxy (e.g. http://proxy:8080), ` +
        `but the origin is ${origin} (the bare Vite client). Re-run with ` +
        `-e PROOF_URL=http://proxy:8080.`,
    );
  }

  await pickAnyGroupAndContinue(page, 'player-uat');

  try {
    await page.locator('.media-card').first().waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    await shootView(page, `${flowName}-03-no-library`);
    fail('player-uat: no media cards appeared (library empty?)', error);
  }
  await page.waitForLoadState('networkidle');

  // Scope the Play/Resume search to ONE specific card at a time (never a
  // page-wide button locator with .or(), which is ambiguous once several cards
  // each have their own Play/Resume button in a larger real library).
  const cardCount = await page.locator('.media-card').count();
  let chosenCard = null;
  let chosenButton = null;
  let chosenTitle = '';
  for (let index = 0; index < cardCount; index += 1) {
    const card = page.locator('.media-card').nth(index);
    const button = card.locator('button', { hasText: /^(Play|Resume)$/ }).first();
    if (await button.count().then((n) => n > 0)) {
      chosenCard = card;
      chosenButton = button;
      chosenTitle = ((await card.locator('h3').first().textContent().catch(() => '')) ?? '').trim();
      break;
    }
  }

  if (!chosenCard || !chosenButton) {
    await shootView(page, `${flowName}-03-no-play-button`);
    fail('player-uat: found no single media-card with a Play/Resume button to open the modal');
  }

  console.log(`[proof] player-uat: chosen card = ${JSON.stringify(chosenTitle)} (deliberately the first match, scoped to one card)`);
  await chosenButton.scrollIntoViewIfNeeded();
  await shootView(page, `${flowName}-03-before-open`);

  await chosenButton.click();

  const dialog = page.locator('div.modal.player-modal[role="dialog"]');
  try {
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    await dialog.locator('iframe.player-frame').waitFor({ state: 'attached', timeout: 15_000 });
  } catch (error) {
    const appError = await page.locator('.error').first().textContent().catch(() => null);
    await shootView(page, `${flowName}-04-modal-did-not-open`);
    fail(
      'player-uat: player dialog/iframe did not appear after clicking Play/Resume' +
        (appError ? ` — app error: ${appError.trim()}` : ''),
      error,
    );
  }
  await shoot(page, `${flowName}-04-modal-open`);
  console.log(`[proof] player-uat: PASS — player modal opened for "${chosenTitle}" against real library data`);

  // Resolve the Jellyfin child frame and confirm it settles logged-in (no
  // manual login form) — the same handoff guarantee player-handoff proves,
  // reusable against any real UAT library without a fixed-fixture assumption.
  const findJfFrame = () => page.frames().find((f) => /\/player\//.test(f.url())) ?? null;
  const frameDeadline = Date.now() + 15_000;
  let jfFrame = findJfFrame();
  while (!jfFrame && Date.now() < frameDeadline) {
    await page.waitForTimeout(300);
    jfFrame = findJfFrame();
  }
  if (!jfFrame) {
    await shoot(page, `${flowName}-05-no-jf-frame`);
    fail('player-uat: could not resolve the Jellyfin /player child frame');
  }

  const probe = () =>
    jfFrame.evaluate(() => {
      const q = (sel) => document.querySelector(sel);
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const loggedInEl =
        q('.headerUserButton') || q('.skinHeader') || q('.homeSectionsContainer') ||
        q('[is="emby-tabs"]') || q('.itemsContainer') || q('a[href*="#/home"]') ||
        q('.videoPlayerContainer') || q('.detailPagePrimaryContainer') || q('.osdHeader');
      const loginEl = q('#loginPage') || q('.manualLoginForm') || q('form .manualLoginForm');
      return {
        loggedInVisible: visible(loggedInEl),
        loginFormVisible: visible(loginEl),
        hash: location.hash,
      };
    }).catch(() => ({ loggedInVisible: false, loginFormVisible: false, hash: '' }));

  const settleDeadline = Date.now() + 30_000;
  let jf = await probe();
  while (!jf.loggedInVisible && !jf.loginFormVisible && Date.now() < settleDeadline) {
    await page.waitForTimeout(500);
    jf = await probe();
  }
  console.log('[proof] player-uat: jellyfin-web state =', JSON.stringify(jf));
  await shoot(page, `${flowName}-06-jellyfin-frame`);

  if (jf.loginFormVisible) {
    fail('player-uat: the Jellyfin iframe shows the MANUAL LOGIN FORM — auto-login did NOT take against the real UAT server');
  }
  if (!jf.loggedInVisible) {
    fail('player-uat: the Jellyfin iframe never settled into a logged-in view within the timeout');
  }
  console.log('[proof] player-uat: PASS — player click-through completed against real Jellyfin data with no manual login form');
}
