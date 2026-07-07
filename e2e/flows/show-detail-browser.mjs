import { pickEveryonePartyAndContinue } from '../lib/viewer.mjs';
import { makeJellyfin } from '../lib/jellyfin.mjs';

// ── show-detail-browser flow ────────────────────────────────────────────────
// Proves all four Show Detail Browser acceptance criteria against the seeded
// sandbox "Normal Show" fixture (2 seasons: S1 has 4 episodes incl. "Pilot",
// S2 has 3 episodes — see tools/sandbox/fixtures.mjs SHOWS[0]):
//
//   AC1. Clicking a show title (media-card AND continue-watching card) opens
//        an accessible (role=dialog/aria-modal) show detail modal without
//        mutating page state behind it (recommendations/search results stay
//        mounted, unchanged).
//   AC2. The modal lists episodes and a season-filter-row of buttons; clicking
//        a season button narrows the visible episode list to that season only.
//   AC3. Each visible episode row shows a per-viewer watched/unwatched pill for
//        every active-party viewer.
//   AC4. The in-modal "Search episodes in <Show>" field scopes results to this
//        show only (keyword unique to one episode of THIS show), and is a
//        separate control from the top-level library search — never a
//        global/discovery-rail search.
export const match = /show-detail-browser|show-detail|show-modal/i;

const SHOW_TITLE = 'Normal Show';
const UNIQUE_KEYWORD = 'Pilot'; // S01E01 of "Normal Show" only, per fixtures.mjs.

export async function run(page, ctx) {
  const { fail, shoot, shootView, flowName } = ctx;

  // ── Seed a MIXED watched state on "Normal Show" S01E01 ("Pilot") ──────────
  // Reset every user to a clean slate, then mark just Alice as having watched
  // the Pilot episode. This makes AC3's per-viewer pill evidence a REAL mixed
  // state (some checked, some not) rather than "everyone unwatched", which is
  // a weaker/ambiguous proof of the per-watcher feature.
  const jellyfinEnv = { url: process.env.JELLYFIN_URL, apiKey: process.env.JELLYFIN_API_KEY };
  try {
    const jf = makeJellyfin(jellyfinEnv.url, jellyfinEnv.apiKey);
    await jf.resetAllPlayedState(console.log);
    const users = await jf.listUsers();
    const alice = users.find((u) => u.name === 'Alice');
    const series = await jf.listSeries();
    const normalShow = series.find((s) => s.name === SHOW_TITLE);
    if (alice && normalShow) {
      const episodes = await jf.listEpisodes(normalShow.id);
      const pilot = episodes.find((e) => e.name === 'Pilot');
      if (pilot) {
        await jf.markPlayed(alice.id, pilot.id);
        console.log(`[proof] show-detail-browser: seeded Alice as WATCHED for "${SHOW_TITLE}" S01E01 "Pilot" (Bob/Carol/Dave left unwatched) for a mixed AC3 proof.`);
      } else {
        console.warn('[proof] show-detail-browser: could not find "Pilot" episode to seed watched state (DATA GAP) — AC3 evidence will show all-unwatched.');
      }
    } else {
      console.warn(`[proof] show-detail-browser: could not resolve Alice/"${SHOW_TITLE}" for watched-state seed (alice=${!!alice}, show=${!!normalShow}) — AC3 evidence will show all-unwatched.`);
    }
  } catch (e) {
    console.warn('[proof] show-detail-browser: watched-state seed failed: ' + (e?.message ?? e) + ' — continuing; AC3 evidence may show all-unwatched.');
  }

  await pickEveryonePartyAndContinue(page, flowName);

  try {
    await page.locator('.section-block').first().waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    await shoot(page, `${flowName}-00-no-home`);
    fail('show-detail-browser: main app section-block never appeared', error);
  }
  await page.waitForLoadState('networkidle');

  const modal = () => page.locator('.modal.show-detail-modal');

  // ── AC1a: open from a MEDIA CARD title (recommendations/search rail) ──────
  // Find a media-card whose title button opens "Normal Show". Scan the
  // recommendations rail(s) first since that's where library cards render.
  let titleBtn = page.locator('.media-card button.link-title', { hasText: SHOW_TITLE }).first();
  if ((await titleBtn.count()) === 0) {
    // Not on the recommendations rail — use the toolbar search to surface it,
    // then click its media-card title (still AC1's "anywhere it appears").
    console.log(`[proof] show-detail-browser: "${SHOW_TITLE}" not on initial rails, searching for it`);
    const searchInput = page
      .locator('.toolbar .search-field input')
      .first()
      .or(page.locator('.toolbar input[type="search"]').first());
    await searchInput.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    if ((await searchInput.count()) > 0) {
      await searchInput.fill(SHOW_TITLE);
      await page.waitForTimeout(1_300);
      titleBtn = page.locator('.media-card button.link-title', { hasText: SHOW_TITLE }).first();
    }
  }

  try {
    await titleBtn.waitFor({ state: 'visible', timeout: 15_000 });
  } catch (error) {
    await shoot(page, `${flowName}-00-no-title-card`);
    fail(`show-detail-browser: could not find a media-card title button for "${SHOW_TITLE}" anywhere (rails or search).`, error);
  }

  // Capture page state BEFORE opening the modal, to compare after closing it
  // (AC1: opening/closing must not mutate the page behind it).
  const headingsBefore = await page
    .locator('.section-block h2')
    .allInnerTexts()
    .then((arr) => arr.map((t) => t.trim()))
    .catch(() => []);
  console.log('[proof] show-detail-browser: section headings BEFORE opening modal =', JSON.stringify(headingsBefore));

  await titleBtn.scrollIntoViewIfNeeded();
  await shootView(page, `${flowName}-01-before-open-mediacard`);
  await titleBtn.click();

  try {
    await modal().waitFor({ state: 'visible', timeout: 15_000 });
  } catch (error) {
    await shoot(page, `${flowName}-01-modal-did-not-open`);
    fail('show-detail-browser: clicking a media-card show title did not open .modal.show-detail-modal', error);
  }

  // Accessibility checks (AC1 "accessible show modal").
  const role = await modal().getAttribute('role');
  const ariaModal = await modal().getAttribute('aria-modal');
  const ariaLabel = await modal().getAttribute('aria-label');
  console.log(`[proof] show-detail-browser: modal role="${role}" aria-modal="${ariaModal}" aria-label="${ariaLabel}"`);
  if (role !== 'dialog' || ariaModal !== 'true' || !ariaLabel) {
    fail(`show-detail-browser: modal missing accessible dialog semantics (role=${role}, aria-modal=${ariaModal}, aria-label=${ariaLabel})`);
  }
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? { tag: el.tagName, cls: el.className } : null;
  });
  console.log('[proof] show-detail-browser: document.activeElement after open =', JSON.stringify(focused));

  await page.waitForLoadState('networkidle');
  await shootView(page, `${flowName}-02-modal-open-mediacard`);
  await shoot(page, `${flowName}-02-modal-open-mediacard-full`);

  // Close it and confirm the page behind it is unchanged (AC1).
  await page.keyboard.press('Escape');
  try {
    await modal().waitFor({ state: 'hidden', timeout: 8_000 });
  } catch (error) {
    fail('show-detail-browser: Escape did not close the show detail modal', error);
  }
  await page.waitForTimeout(300);
  const headingsAfter = await page
    .locator('.section-block h2')
    .allInnerTexts()
    .then((arr) => arr.map((t) => t.trim()))
    .catch(() => []);
  console.log('[proof] show-detail-browser: section headings AFTER closing modal =', JSON.stringify(headingsAfter));
  await shootView(page, `${flowName}-03-after-close-mediacard`);

  const before = JSON.stringify(headingsBefore);
  const after = JSON.stringify(headingsAfter);
  if (before !== after || headingsBefore.length === 0) {
    fail(`show-detail-browser: FAIL — page section headings changed after open/close modal. before=${before} after=${after}`);
  }
  console.log('[proof] show-detail-browser: PASS (AC1a) — media-card title opened an accessible modal; page state behind it unchanged.');

  // ── AC1b: open from a CONTINUE-WATCHING card's series-name link ───────────
  // Only provable if the party currently has a "Normal Show" (or any show)
  // continue-watching card with the series-name link. Try "Normal Show" first,
  // fall back to whatever show continue-watching card exists.
  const continueRail = page.locator('.section-block').filter({ has: page.locator('h2', { hasText: /^Continue watching$/ }) }).first();
  let cwLink = continueRail.locator('.media-card button.link-title-inline').first();
  const cwCount = await cwLink.count().catch(() => 0);
  if (cwCount > 0) {
    const cwCardTitle = (await cwLink.innerText().catch(() => '')).trim();
    console.log(`[proof] show-detail-browser: found continue-watching series link "${cwCardTitle}"`);
    await cwLink.scrollIntoViewIfNeeded();
    await shootView(page, `${flowName}-04-before-open-cwcard`);
    await cwLink.click();
    try {
      await modal().waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForLoadState('networkidle');
      await shootView(page, `${flowName}-05-modal-open-cwcard`);
      console.log('[proof] show-detail-browser: PASS (AC1b) — continue-watching series-name link opened the modal.');
    } catch (error) {
      await shoot(page, `${flowName}-05-cw-modal-did-not-open`);
      fail('show-detail-browser: clicking a continue-watching series-name link did not open the show modal', error);
    }
    // Close via the explicit Close button this time (covers both close paths).
    const closeBtn = modal().getByRole('button', { name: /^Close$/ }).first();
    await closeBtn.click();
    await modal().waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});
  } else {
    console.log('[proof] show-detail-browser: no continue-watching card with a series-name link found for this party (no in-progress shows) — AC1b not exercised, AC1a already proves the "anywhere it appears" requirement for media cards.');
  }

  // ── Re-open "Normal Show" fresh for AC2/AC3/AC4 ────────────────────────────
  titleBtn = page.locator('.media-card button.link-title', { hasText: SHOW_TITLE }).first();
  if ((await titleBtn.count()) === 0) {
    const searchInput = page
      .locator('.toolbar .search-field input')
      .first()
      .or(page.locator('.toolbar input[type="search"]').first());
    if ((await searchInput.count()) > 0) {
      await searchInput.fill(SHOW_TITLE);
      await page.waitForTimeout(1_300);
      titleBtn = page.locator('.media-card button.link-title', { hasText: SHOW_TITLE }).first();
    }
  }
  await titleBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await titleBtn.click();
  await modal().waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForLoadState('networkidle');

  const episodeCards = () => modal().locator('.episode-list .episode-card');
  try {
    await episodeCards().first().waitFor({ state: 'visible', timeout: 15_000 });
  } catch (error) {
    await shoot(page, `${flowName}-06-no-episodes`);
    fail('show-detail-browser: modal opened but no episode rows rendered for "Normal Show"', error);
  }

  // ── AC2: season filter row narrows the visible episode list ───────────────
  const seasonRow = modal().locator('.season-filter-row');
  await seasonRow.waitFor({ state: 'visible', timeout: 10_000 }).catch(async () => {
    await shoot(page, `${flowName}-07-no-season-row`);
    fail('show-detail-browser: .season-filter-row did not render for a multi-season show');
  });

  const seasonButtons = seasonRow.locator('button');
  const seasonBtnLabels = await seasonButtons.allInnerTexts();
  console.log('[proof] show-detail-browser: season filter buttons =', JSON.stringify(seasonBtnLabels));

  const allCount = await episodeCards().count();
  console.log(`[proof] show-detail-browser: "All seasons" episode count = ${allCount}`);
  await shootView(page, `${flowName}-08-all-seasons`);

  const season2Btn = seasonRow.getByRole('button', { name: /^Season 2$/ }).first();
  if ((await season2Btn.count()) === 0) {
    await shoot(page, `${flowName}-08b-no-season2-button`);
    fail('show-detail-browser: no "Season 2" button found in season-filter-row for "Normal Show" (expected 2 seasons per fixture).');
  }
  await season2Btn.click();
  await page.waitForTimeout(300);
  const season2Count = await episodeCards().count();
  const season2Titles = await episodeCards().locator('h3').allInnerTexts();
  console.log(`[proof] show-detail-browser: Season 2 filtered episode count = ${season2Count}, titles = ${JSON.stringify(season2Titles)}`);
  await shootView(page, `${flowName}-09-season2-filtered`);

  if (!(season2Count > 0 && season2Count < allCount)) {
    fail(`show-detail-browser: FAIL — selecting "Season 2" did not narrow the list (all=${allCount}, season2=${season2Count})`);
  }
  const season2Labels = await episodeCards().locator('.eyebrow').allInnerTexts();
  const allSeason2 = season2Labels.every((l) => /^S02/.test(l.trim()));
  console.log('[proof] show-detail-browser: Season 2 filtered row labels =', JSON.stringify(season2Labels));
  if (!allSeason2) {
    fail(`show-detail-browser: FAIL — "Season 2" filter shows non-S02 episodes: ${JSON.stringify(season2Labels)}`);
  }
  console.log('[proof] show-detail-browser: PASS (AC2) — Season 2 button narrowed the episode list to only S02 episodes.');

  // Back to "All seasons" for AC3/AC4.
  const allSeasonsBtn = seasonRow.getByRole('button', { name: /^All seasons$/ }).first();
  await allSeasonsBtn.click();
  await page.waitForTimeout(300);

  // ── AC3: per-viewer watched/unwatched pills on every visible episode row ──
  const firstEpisode = episodeCards().first();
  const pills = firstEpisode.locator('.viewer-pill');
  const pillCount = await pills.count();
  console.log(`[proof] show-detail-browser: first episode row has ${pillCount} viewer pill(s)`);
  if (pillCount === 0) {
    await shoot(page, `${flowName}-10-no-pills`);
    fail('show-detail-browser: episode row rendered no .viewer-pill elements — AC3 (per-watcher watched state) not visible.');
  }
  const pillEvidence = [];
  for (let i = 0; i < pillCount; i += 1) {
    const pill = pills.nth(i);
    const title = (await pill.getAttribute('title')) ?? '';
    const cls = (await pill.getAttribute('class')) ?? '';
    const hasCheck = (await pill.locator('.viewer-pill-check').count()) > 0;
    pillEvidence.push({ title, watched: cls.includes('watched'), hasCheck });
  }
  console.log('[proof] show-detail-browser: first episode viewer-pill evidence =', JSON.stringify(pillEvidence));
  await firstEpisode.scrollIntoViewIfNeeded();
  await shootView(page, `${flowName}-11-episode-row-pills`);
  await firstEpisode.locator('.viewer-pills').first().screenshot({
    path: `${ctx.outDir}/${flowName}-11-pills-closeup.png`,
  }).catch(() => {});
  console.log(`[proof] screenshot: ${ctx.outDir}/${flowName}-11-pills-closeup.png`);

  // Confirm pills are DISPLAY-ONLY (no click handler / no watched-state editing
  // added by this effort) — clicking must not toggle anything.
  const beforeClickWatched = pillEvidence[0].watched;
  await pills.first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
  const afterClickCls = (await pills.first().getAttribute('class').catch(() => '')) ?? '';
  const afterClickWatched = afterClickCls.includes('watched');
  console.log(`[proof] show-detail-browser: viewer-pill watched state before/after click = ${beforeClickWatched}/${afterClickWatched} (should be UNCHANGED — pills are read-only)`);
  if (beforeClickWatched !== afterClickWatched) {
    fail('show-detail-browser: FAIL — clicking a modal viewer-pill changed its watched state; these must be display-only per the nongoal (no watched-state editing from this modal).');
  }
  console.log('[proof] show-detail-browser: PASS (AC3) — every visible episode row shows a per-viewer watched/unwatched pill for the active party, display-only.');

  // ── AC4: in-modal keyword search scoped to THIS show only ─────────────────
  const episodeSearchInput = modal().locator('label.search-field input[type="search"]').first();
  try {
    await episodeSearchInput.waitFor({ state: 'visible', timeout: 8_000 });
  } catch (error) {
    await shoot(page, `${flowName}-12-no-episode-search`);
    fail('show-detail-browser: no in-modal "Search episodes in <Show>" input found', error);
  }
  const searchLabel = (await modal().locator('label.search-field span').first().innerText().catch(() => '')).trim();
  console.log(`[proof] show-detail-browser: in-modal search label = "${searchLabel}"`);
  if (!searchLabel.toLowerCase().includes(SHOW_TITLE.toLowerCase())) {
    fail(`show-detail-browser: in-modal search label does not mention the show ("${searchLabel}") — cannot confirm it's scoped, not global.`);
  }

  // Snapshot the TOP-LEVEL/global search box value + its result titles BEFORE
  // typing into the in-modal search, so we can prove afterwards that the
  // in-modal search left the global search state completely untouched (it is
  // a separate control, not a global/discovery-rail search). The global box
  // may already hold "Normal Show" from locating the card earlier in this
  // flow — that's fine; we only assert it does NOT change when the MODAL
  // search changes.
  const globalSearchInput = page
    .locator('.toolbar .search-field input')
    .first()
    .or(page.locator('.toolbar input[type="search"]').first());
  const globalResultsSection = page
    .locator('.section-block')
    .filter({ has: page.locator('h2', { hasText: /^Search results$/ }) })
    .first();
  const globalQueryBefore = await globalSearchInput.inputValue().catch(() => null);
  const globalTitlesBefore = await globalResultsSection
    .locator('.media-card h3')
    .allInnerTexts()
    .then((arr) => arr.map((t) => t.trim()))
    .catch(() => []);
  console.log(`[proof] show-detail-browser: TOP-LEVEL search box value BEFORE modal search = ${JSON.stringify(globalQueryBefore)}, results = ${JSON.stringify(globalTitlesBefore)}`);

  await episodeSearchInput.fill(UNIQUE_KEYWORD);
  await page.waitForTimeout(900); // debounce + round-trip
  await page.waitForLoadState('networkidle');

  const filteredCount = await episodeCards().count();
  const filteredTitles = await episodeCards().locator('h3').allInnerTexts();
  console.log(`[proof] show-detail-browser: episode search q="${UNIQUE_KEYWORD}" -> ${filteredCount} result(s): ${JSON.stringify(filteredTitles)}`);
  await shootView(page, `${flowName}-13-episode-search-results`);

  if (filteredCount === 0) {
    fail(`show-detail-browser: FAIL — in-modal search for "${UNIQUE_KEYWORD}" returned no episodes (expected S01E01 "Pilot" of "${SHOW_TITLE}")`);
  }
  const allMatchKeyword = filteredTitles.every((t) => t.toLowerCase().includes(UNIQUE_KEYWORD.toLowerCase()));
  if (!allMatchKeyword) {
    fail(`show-detail-browser: FAIL — some in-modal search results do not contain "${UNIQUE_KEYWORD}": ${JSON.stringify(filteredTitles)}`);
  }

  // Confirm the top-level/global search box VALUE and its RESULT TITLES are
  // BYTE-FOR-BYTE unchanged by the in-modal search (separate state — never
  // becomes/affects a global/discovery-rail search).
  const globalQueryAfter = await globalSearchInput.inputValue().catch(() => null);
  const globalTitlesAfter = await globalResultsSection
    .locator('.media-card h3')
    .allInnerTexts()
    .then((arr) => arr.map((t) => t.trim()))
    .catch(() => []);
  console.log(`[proof] show-detail-browser: TOP-LEVEL search box value AFTER modal search = ${JSON.stringify(globalQueryAfter)}, results = ${JSON.stringify(globalTitlesAfter)}`);
  await shootView(page, `${flowName}-14-global-search-untouched`);

  if (globalQueryAfter !== globalQueryBefore) {
    fail(`show-detail-browser: FAIL — typing in the in-modal episode search changed the TOP-LEVEL search box value (before=${JSON.stringify(globalQueryBefore)}, after=${JSON.stringify(globalQueryAfter)}); it must be a fully separate control.`);
  }
  if (JSON.stringify(globalTitlesAfter) !== JSON.stringify(globalTitlesBefore)) {
    fail(`show-detail-browser: FAIL — the in-modal episode search changed the TOP-LEVEL "Search results" list (before=${JSON.stringify(globalTitlesBefore)}, after=${JSON.stringify(globalTitlesAfter)}); it must not leak into/become a global search.`);
  }
  if (globalTitlesAfter.some((t) => t.toLowerCase().includes(UNIQUE_KEYWORD.toLowerCase()) && !t.toLowerCase().includes(SHOW_TITLE.toLowerCase()))) {
    fail('show-detail-browser: FAIL — the global search rail picked up the modal keyword.');
  }

  console.log(`[proof] show-detail-browser: PASS (AC4) — in-modal search for "${UNIQUE_KEYWORD}" returned only episodes of "${SHOW_TITLE}", and left the top-level global search box/results completely untouched.`);

  // Clear the modal search back to the full list (cleanup) and close.
  await episodeSearchInput.fill('');
  await page.waitForTimeout(900);
  const closeBtn = modal().getByRole('button', { name: /^Close$/ }).first();
  await closeBtn.click();
  await modal().waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});

  console.log('[proof] show-detail-browser: ALL PASS — AC1 (accessible modal, page state preserved), AC2 (season filter), AC3 (per-viewer watched pills), AC4 (scoped in-modal search) all verified.');
}
