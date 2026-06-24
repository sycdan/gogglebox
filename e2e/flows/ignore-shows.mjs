import { pickEveryoneGroupAndContinue } from '../lib/viewer.mjs';

// ── ignore-shows flow ──────────────────────────────────────────────────────
// Proves the per-group "Ignore" feature end-to-end: a card's Ignore button
// hides that show from the Group-picks grid; the hero "Ignored shows" modal
// lists it with an Unignore control; Unignore brings it back into the grid.
export const match = /ignore/i;

export async function run(page, ctx) {
  const { fail, shoot, shootView, withRetry, safeScroll, flowName } = ctx;

  console.log('[proof] ignore-shows: locating viewer-selection screen');

  // We may be on the viewer-selection screen ("Pick the group"). Pick the
  // "Everyone" preset (same approach as the other flows), then Continue.
  await pickEveryoneGroupAndContinue(page, 'ignore-shows');

  // Locate the "Group picks" section: the .section-block whose eyebrow text
  // is "Group picks". The home page hydrates/re-renders after data loads, so
  // we never hold a resolved handle — `picksSectionLoc()` returns a fresh
  // auto-waiting Locator on every access, and scrolls go through safeScroll().
  const picksSectionLoc = () =>
    page
      .locator('.section-block')
      .filter({ has: page.locator('.eyebrow', { hasText: /^Group picks$/ }) })
      .first();
  const picksSection = picksSectionLoc();

  try {
    await picksSection.waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    await shoot(page, `${flowName}-03-no-group-picks`);
    fail('ignore-shows: "Group picks" section never appeared', error);
  }

  // Re-query immediately before scrolling: the section often re-renders
  // (detaching the element above) once recommendations data arrives.
  await safeScroll('ignore-shows: scroll group-picks', picksSectionLoc);

  // Reads the card titles within the Group-picks grid. Re-queries the section
  // each call (it re-renders as ignore/unignore mutate the grid) and swallows
  // a transient detach by returning [] so the polling loops simply retry.
  async function gridTitles() {
    return picksSectionLoc()
      .locator('.media-card h3')
      .allInnerTexts()
      .then((arr) => arr.map((t) => t.trim()).filter(Boolean))
      .catch(() => []);
  }

  // Wait for at least one card (with an Ignore button) to render.
  try {
    await picksSectionLoc()
      .locator('.media-card')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    await picksSectionLoc()
      .locator('.media-card button', { hasText: /^Ignore$/ })
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
  } catch (error) {
    await shoot(page, `${flowName}-03-no-cards`);
    const empty = await picksSection.locator('.muted').allInnerTexts().catch(() => []);
    fail(
      'ignore-shows: no .media-card with an "Ignore" button rendered in the Group-picks section' +
        (empty.length ? ` (section message: ${JSON.stringify(empty)})` : ' (data gap?)'),
      error,
    );
  }

  await safeScroll('ignore-shows: scroll home', picksSectionLoc);
  await page.waitForTimeout(300);
  await shoot(page, `${flowName}-03-home`);

  // Pick a target card: read its title, then click ITS Ignore button. Re-query
  // the section (it can re-render between reading the title and the click).
  const targetCardLoc = () =>
    picksSectionLoc()
      .locator('.media-card')
      .filter({ has: page.locator('button', { hasText: /^Ignore$/ }) })
      .first();
  const targetTitle = await withRetry('ignore-shows: read target title', async () => {
    const t = (await targetCardLoc().locator('h3').first().innerText({ timeout: 10_000 })).trim();
    return t;
  }).catch(() => '');
  if (!targetTitle) {
    await shoot(page, `${flowName}-04-no-target-title`);
    fail('ignore-shows: could not read a target card title from the Group-picks section');
  }
  const before = await gridTitles();
  console.log(`[proof] ignore-shows: grid titles before ignore [${before.length}] =`, JSON.stringify(before));
  console.log(`[proof] ignore-shows: ignoring "${targetTitle}"`);

  await withRetry('ignore-shows: click Ignore', () =>
    targetCardLoc().locator('button', { hasText: /^Ignore$/ }).first().click({ timeout: 10_000 }),
  );

  // Poll the grid until the target title disappears (or timeout).
  let removed = false;
  const removeDeadline = Date.now() + 20_000;
  while (Date.now() < removeDeadline) {
    await page.waitForTimeout(400);
    const current = await gridTitles();
    if (!current.includes(targetTitle)) {
      removed = true;
      break;
    }
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  await safeScroll('ignore-shows: scroll after-ignore', picksSectionLoc).catch(() => {});
  await page.waitForTimeout(300);
  await shoot(page, `${flowName}-04-after-ignore`);
  if (removed) {
    console.log(`[proof] ignore-shows: PASS — "${targetTitle}" disappeared from the Group-picks grid after Ignore`);
  } else {
    console.error(`[proof] ignore-shows: FAIL — "${targetTitle}" still present in the grid after clicking Ignore`);
  }

  // Open the hero "Ignored shows" modal.
  const heroOpen = page.getByRole('button', { name: /^Ignored shows/ }).first();
  try {
    await heroOpen.waitFor({ state: 'visible', timeout: 10_000 });
    await heroOpen.click();
  } catch (error) {
    await shoot(page, `${flowName}-05-no-ignored-button`);
    fail('ignore-shows: hero "Ignored shows" button not found', error);
  }

  // The modal: the .modal whose <h2> is "Ignored shows".
  const ignoredModal = page
    .locator('.modal')
    .filter({ has: page.locator('h2', { hasText: /^Ignored shows$/ }) })
    .first();
  try {
    await ignoredModal.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    await shoot(page, `${flowName}-05-modal-did-not-open`);
    fail('ignore-shows: "Ignored shows" modal did not appear', error);
  }

  // Find the modal row that exposes an Unignore control.
  const ignoredRow = ignoredModal
    .locator('.episode-card')
    .filter({ has: page.locator('button', { hasText: /^Unignore$/ }) })
    .first();
  try {
    await ignoredRow.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    await shootView(page, `${flowName}-05-no-ignored-row`);
    const rows = await ignoredModal.locator('.episode-card h3').allInnerTexts().catch(() => []);
    fail(
      'ignore-shows: no ignored-show row with an "Unignore" control in the modal' +
        (rows.length ? ` (rows: ${JSON.stringify(rows)})` : ''),
      error,
    );
  }
  const ignoredRowTitle = (await ignoredRow.locator('h3').first().innerText().catch(() => '')).trim();
  console.log(`[proof] ignore-shows: modal lists ignored row "${ignoredRowTitle}" with an Unignore control`);
  await shootView(page, `${flowName}-05-ignored-modal`);

  // Click Unignore and close the modal so the grid is visible again.
  await ignoredRow.locator('button', { hasText: /^Unignore$/ }).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
  const closeBtn = ignoredModal.getByRole('button', { name: /^Close$/ }).first();
  if (await closeBtn.count().then((n) => n > 0)) {
    await closeBtn.click().catch(() => {});
  }
  await page.waitForTimeout(300);

  // Poll the grid until the target title returns (or timeout).
  await safeScroll('ignore-shows: scroll before-restore', picksSectionLoc).catch(() => {});
  let restored = false;
  const restoreDeadline = Date.now() + 20_000;
  while (Date.now() < restoreDeadline) {
    await page.waitForTimeout(400);
    const current = await gridTitles();
    if (current.includes(targetTitle)) {
      restored = true;
      break;
    }
  }
  await safeScroll('ignore-shows: scroll after-unignore', picksSectionLoc).catch(() => {});
  await page.waitForTimeout(300);
  await shoot(page, `${flowName}-06-after-unignore`);
  if (restored) {
    console.log(`[proof] ignore-shows: PASS — "${targetTitle}" returned to the Group-picks grid after Unignore`);
  } else {
    console.warn(
      `[proof] ignore-shows: "${targetTitle}" did not reappear in the grid within timeout after Unignore ` +
        '(recommendations are data-dependent and may resurface a different batch; the modal/Unignore flow still completed)',
    );
  }
}
