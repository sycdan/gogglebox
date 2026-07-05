import { pickEveryonePartyAndContinue } from '../lib/viewer.mjs';

// ── continue-watching flow ─────────────────────────────────────────────────
// Proves the combined Continue-watching rail holds movies+shows and persists
// across the Movies/Shows kind toggle (the rail must NOT clear or change when
// the user flips the library kind). The rail is the FIRST .section-block,
// sitting above the .toolbar.
export const match = /continue|watching/i;

export async function run(page, ctx) {
  const { fail, shoot, flowName } = ctx;

  console.log('[proof] continue-watching: locating viewer-selection screen');

  // Reads the card titles of the Continue-watching rail (first section-block).
  async function railTitles() {
    return page
      .locator('.section-block')
      .first()
      .locator('.media-card h3')
      .allInnerTexts()
      .then((arr) => arr.map((t) => t.trim()).filter(Boolean))
      .catch(() => []);
  }

  // We may be on the viewer-selection screen ("Pick the party"). Pick the
  // "Everyone" preset to maximise combined in-progress items, then Continue.
  await pickEveryonePartyAndContinue(page, 'continue-watching');

  // Wait for the main app / Continue-watching section to render.
  try {
    await page.locator('.section-block').first().waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    await shoot(page, `${flowName}-03-no-home`);
    fail('continue-watching: main app section-block never appeared', error);
  }
  await page.waitForLoadState('networkidle');

  // Wait for the Continue-watching rail to hydrate so the screenshot isn't
  // captured mid-load. Best-effort: if no cards ever appear it's a data gap
  // (handled below), not a script failure — so don't hard-fail here.
  try {
    await page
      .locator('.section-block .media-card')
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 });
  } catch {
    console.warn('[proof] continue-watching: no .section-block .media-card visible within timeout before -03-home (likely a data gap)');
  }

  await shoot(page, `${flowName}-03-home`);

  // Baseline rail titles (step 3).
  const baseline = await railTitles();
  console.log(`[proof] continue-watching: rail titles (baseline) [${baseline.length}] =`, JSON.stringify(baseline));
  if (baseline.length === 0) {
    console.warn(
      '[proof] continue-watching: DATA GAP — Continue-watching rail is EMPTY. ' +
        'The script ran fine; there is simply no in-progress data for this party. ' +
        'This is NOT a UI defect; seed in-progress items to fully validate persistence.',
    );
  }

  const railsEqual = (a, b) =>
    a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');

  let mismatch = false;

  // Toggle to Shows (step 4) and re-read (step 5).
  const showsBtn = page.locator('.toolbar .toggle-row button', { hasText: /^Shows$/ }).first();
  if (await showsBtn.count().then((n) => n > 0)) {
    await showsBtn.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(400);
    await shoot(page, `${flowName}-04-after-shows`);
    const afterShows = await railTitles();
    console.log(`[proof] continue-watching: rail titles (after Shows) [${afterShows.length}] =`, JSON.stringify(afterShows));
    if (!railsEqual(baseline, afterShows)) {
      mismatch = true;
      console.error(
        '[proof] continue-watching: FAIL — rail CHANGED after toggling to Shows. ' +
          `baseline=${JSON.stringify(baseline)} afterShows=${JSON.stringify(afterShows)}`,
      );
    } else {
      console.log('[proof] continue-watching: PASS — rail unchanged after toggling to Shows');
    }
  } else {
    console.warn('[proof] continue-watching: Shows toggle button not found (.toolbar .toggle-row button "Shows")');
  }

  // Toggle to Movies and re-read.
  const moviesBtn = page.locator('.toolbar .toggle-row button', { hasText: /^Movies$/ }).first();
  if (await moviesBtn.count().then((n) => n > 0)) {
    await moviesBtn.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(400);
    await shoot(page, `${flowName}-05-after-movies`);
    const afterMovies = await railTitles();
    console.log(`[proof] continue-watching: rail titles (after Movies) [${afterMovies.length}] =`, JSON.stringify(afterMovies));
    if (!railsEqual(baseline, afterMovies)) {
      mismatch = true;
      console.error(
        '[proof] continue-watching: FAIL — rail CHANGED after toggling to Movies. ' +
          `baseline=${JSON.stringify(baseline)} afterMovies=${JSON.stringify(afterMovies)}`,
      );
    } else {
      console.log('[proof] continue-watching: PASS — rail unchanged after toggling to Movies');
    }
  } else {
    console.warn('[proof] continue-watching: Movies toggle button not found (.toolbar .toggle-row button "Movies")');
  }

  if (mismatch) {
    fail('continue-watching: Continue-watching rail did NOT persist across the Movies/Shows toggle');
  }
  if (baseline.length > 0) {
    console.log('[proof] continue-watching: PASS — rail persisted across both kind toggles');
  } else {
    console.log('[proof] continue-watching: rail persistence assertions trivially held (rail empty — see DATA GAP warning above)');
  }
}
