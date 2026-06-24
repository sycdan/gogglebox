import { pickEveryoneGroupAndContinue } from '../lib/viewer.mjs';

// ── recommendations (Group picks) flow ─────────────────────────────────────
// Proves the "Show me other picks" button swaps the Group-picks grid to a
// fresh, DISJOINT batch of recommendations. Reads the card titles in the
// "Group picks" section before and after, and logs whether the two batches
// overlap (expected: zero overlap).
export const match = /recommend|picks/i;

export async function run(page, ctx) {
  const { fail, shoot, shootView, flowName } = ctx;

  console.log('[proof] recommendations: locating viewer-selection screen');

  // We may be on the viewer-selection screen ("Pick the group"). Pick the
  // "Everyone" preset (same approach as continue-watching), then Continue.
  await pickEveryoneGroupAndContinue(page, 'recommendations');

  // Locate the "Group picks" section: the .section-block whose eyebrow text
  // is "Group picks".
  const picksSection = page
    .locator('.section-block')
    .filter({ has: page.locator('.eyebrow', { hasText: /^Group picks$/ }) })
    .first();

  try {
    await picksSection.waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    await shoot(page, `${flowName}-03-no-group-picks`);
    fail('recommendations: "Group picks" section never appeared', error);
  }

  await picksSection.scrollIntoViewIfNeeded();

  // Reads the recommendation card titles within the Group-picks section.
  async function pickTitles() {
    return picksSection
      .locator('.media-grid.compact .media-card h3')
      .allInnerTexts()
      .then((arr) => arr.map((t) => t.trim()).filter(Boolean))
      .catch(() => []);
  }

  // Wait for at least one recommendation card to render in this section.
  try {
    await picksSection
      .locator('.media-grid.compact .media-card')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    await shoot(page, `${flowName}-03-no-picks-cards`);
    const empty = await picksSection.locator('.muted').allInnerTexts().catch(() => []);
    fail(
      'recommendations: no .media-card rendered in the Group-picks section' +
        (empty.length ? ` (section message: ${JSON.stringify(empty)})` : ' (data gap?)'),
      error,
    );
  }

  // Scroll the section to the top of the viewport so the windowed screenshot
  // captures it legibly.
  async function scrollSectionToTop() {
    await picksSection.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
  }

  await scrollSectionToTop();

  const batch1 = await pickTitles();
  console.log(`[proof] recommendations: batch-1 titles [${batch1.length}] =`, JSON.stringify(batch1));
  await shootView(page, `${flowName}-01-batch1`);

  // Click "Show me other picks" within this section and wait for the titles
  // to change from batch 1.
  const otherPicksBtn = picksSection
    .locator('button', { hasText: /Show me other picks/i })
    .first();
  if (!(await otherPicksBtn.count().then((n) => n > 0))) {
    await shootView(page, `${flowName}-02-no-button`);
    fail('recommendations: "Show me other picks" button not found in the Group-picks section');
  }

  const disabledBefore = await otherPicksBtn.isDisabled().catch(() => false);
  if (disabledBefore) {
    console.warn('[proof] recommendations: "Show me other picks" button is disabled (e.g. "No more picks") — batch swap may not occur');
  }

  await otherPicksBtn.click();

  // Poll the title array until it differs from batch 1 (or timeout).
  const batch1Key = [...batch1].sort().join('');
  let batch2 = batch1;
  const deadline = Date.now() + 20_000;
  let changed = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    const current = await pickTitles();
    if (current.length > 0 && [...current].sort().join('') !== batch1Key) {
      batch2 = current;
      changed = true;
      break;
    }
    batch2 = current;
  }
  if (!changed) {
    console.warn('[proof] recommendations: batch-2 titles did not change from batch-1 within timeout (data-dependent; continuing)');
  }
  await page.waitForLoadState('networkidle').catch(() => {});

  await scrollSectionToTop();
  console.log(`[proof] recommendations: batch-2 titles [${batch2.length}] =`, JSON.stringify(batch2));
  await shootView(page, `${flowName}-02-batch2`);

  // Compute overlap (by title) between the two batches.
  const set1 = new Set(batch1);
  const overlap = [...new Set(batch2)].filter((t) => set1.has(t));
  console.log(`[proof] recommendations: batch-1 count = ${batch1.length}, batch-2 count = ${batch2.length} (expected ~8 each; data-dependent)`);
  console.log(`[proof] recommendations: overlap [${overlap.length}] =`, JSON.stringify(overlap));
  if (overlap.length === 0) {
    console.log('[proof] recommendations: PASS — batches disjoint (zero overlap between batch-1 and batch-2)');
  } else {
    console.error(`[proof] recommendations: FAIL — batches disjoint: ${overlap.length} title(s) overlap between batch-1 and batch-2: ${JSON.stringify(overlap)}`);
  }
}
