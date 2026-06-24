import { pickEveryoneGroupAndContinue } from '../lib/viewer.mjs';

// ── search flow ────────────────────────────────────────────────────────────
// Proves the Phase-3 search experience: the full-library "Browse" grid is gone,
// and the toolbar search input drives a debounced "Search results" section that
// appears for a query and disappears when the box is cleared.
export const match = /search/i;

export async function run(page, ctx) {
  const { fail, shootView, flowName } = ctx;

  console.log('[proof] search: locating viewer-selection screen');

  // We may be on the viewer-selection screen ("Pick the group"). Pick the
  // "Everyone" preset (same approach as the other flows), then Continue.
  await pickEveryoneGroupAndContinue(page, 'search');

  // Wait for the main app to render (the toolbar holds the search input).
  try {
    await page.locator('.toolbar').first().waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    await shootView(page, `${flowName}-01-no-toolbar`);
    fail('search: main app toolbar never appeared', error);
  }
  await page.waitForLoadState('networkidle');

  // ── Assertion 1: no full-library "Browse" section on load ─────────────────
  // Look at every section-block header heading (h2/h3) and confirm none start
  // with "Browse".
  const headingTexts = await page
    .locator('.section-block')
    .locator('h2, h3')
    .allInnerTexts()
    .then((arr) => arr.map((t) => t.trim()).filter(Boolean))
    .catch(() => []);
  const browseHeadings = headingTexts.filter((t) => /^Browse/i.test(t));
  console.log(`[proof] search: section-block headings on load =`, JSON.stringify(headingTexts));
  if (browseHeadings.length === 0) {
    console.log('[proof] search: PASS — no full library grid on load (no "Browse" section header)');
  } else {
    console.error(
      `[proof] search: FAIL — no full library grid on load: found "Browse" header(s) ${JSON.stringify(browseHeadings)}`,
    );
  }

  // Screenshot the home near the top so the toolbar is visible.
  await page.evaluate(() => window.scrollTo(0, 0));
  await shootView(page, `${flowName}-01-home`);

  // ── Ensure kind is "Shows" ────────────────────────────────────────────────
  const showsBtn = page.locator('.toolbar .toggle-row button', { hasText: /^Shows$/ }).first();
  if (await showsBtn.count().then((n) => n > 0)) {
    const alreadySelected = await showsBtn
      .evaluate((el) => el.classList.contains('selected'))
      .catch(() => false);
    if (!alreadySelected) {
      console.log('[proof] search: clicking the Shows toggle');
      await showsBtn.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(300);
    } else {
      console.log('[proof] search: Shows toggle already selected');
    }
  } else {
    console.warn('[proof] search: Shows toggle button not found (.toolbar .toggle-row button "Shows")');
  }

  // Locate the toolbar search input (placeholder "Search shows…"; also a
  // `.search-field input` / `input[type="search"]`).
  const searchInput = page
    .locator('.toolbar .search-field input')
    .first()
    .or(page.locator('.toolbar input[type="search"]').first())
    .or(page.locator('input[placeholder*="Search"]').first());
  try {
    await searchInput.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    await shootView(page, `${flowName}-02-no-search-input`);
    fail('search: could not find the toolbar search input', error);
  }

  // The "Search results" section: the .section-block whose <h2> is
  // "Search results".
  const resultsSection = page
    .locator('.section-block')
    .filter({ has: page.locator('h2', { hasText: /^Search results$/ }) })
    .first();

  async function resultTitles() {
    return resultsSection
      .locator('.media-card h3')
      .allInnerTexts()
      .then((arr) => arr.map((t) => t.trim()).filter(Boolean))
      .catch(() => []);
  }

  // ── Type the query and wait for debounced results ─────────────────────────
  console.log('[proof] search: typing "planet" into the search input');
  await searchInput.click();
  await searchInput.fill('planet');

  // Debounce is ~1s; give it the debounce + the server round-trip.
  await page.waitForTimeout(1_300);

  let resultsShown = false;
  try {
    await resultsSection.waitFor({ state: 'visible', timeout: 15_000 });
    await resultsSection
      .locator('.media-card')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
    resultsShown = true;
  } catch (error) {
    console.error('[proof] search: results section/cards did not appear within timeout', error?.message ?? error);
  }

  const titles = await resultTitles();
  console.log(`[proof] search: result titles for q="planet" [${titles.length}] =`, JSON.stringify(titles));

  await page.evaluate(() => {
    const h = [...document.querySelectorAll('.section-block h2')].find(
      (el) => el.textContent?.trim() === 'Search results',
    );
    h?.scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(300);
  await shootView(page, `${flowName}-02-results`);

  if (resultsShown && titles.length > 0) {
    const allMatch = titles.every((t) => /planet/i.test(t));
    if (allMatch) {
      console.log('[proof] search: PASS — results shown on query (every visible title contains "planet")');
    } else {
      const nonMatching = titles.filter((t) => !/planet/i.test(t));
      console.log(
        `[proof] search: PASS — results shown on query (${titles.length} card(s)); ` +
          `note: ${nonMatching.length} title(s) do not contain "planet": ${JSON.stringify(nonMatching)}`,
      );
    }
  } else {
    console.error('[proof] search: FAIL — results shown on query (no Search results cards appeared for q="planet")');
  }

  // ── Clear the search and confirm results disappear ────────────────────────
  console.log('[proof] search: clearing the search input');
  await searchInput.fill('');
  await page.waitForTimeout(1_300);

  let cleared = false;
  try {
    // The whole section unmounts when the query is empty (App.tsx renders it
    // only when searchQuery.trim() is truthy).
    await resultsSection.waitFor({ state: 'detached', timeout: 8_000 });
    cleared = true;
  } catch {
    // Fallback: section node may persist but show no cards.
    const remaining = await resultTitles();
    cleared = remaining.length === 0;
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await shootView(page, `${flowName}-03-cleared`);

  if (cleared) {
    console.log('[proof] search: PASS — clearing search clears results (Search results section gone / no cards)');
  } else {
    const remaining = await resultTitles();
    console.error(
      `[proof] search: FAIL — clearing search clears results (Search results still showing ${remaining.length} card(s): ${JSON.stringify(remaining)})`,
    );
  }
}
