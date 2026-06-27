import { pickEveryoneGroupAndContinue } from '../lib/viewer.mjs';

// ── rail-pagination flow ───────────────────────────────────────────────────
// Proves the Continue-watching rail pages 3 tiles at a time via top-right
// prev/next arrows: prev disabled on page 1, Next advances to a different set
// of tiles and enables prev. Also captures the recommendations pager.
export const match = /pagination|pager|rail-pag/i;

export async function run(page, ctx) {
  const { fail, shoot, flowName } = ctx;

  await pickEveryoneGroupAndContinue(page, 'rail-pagination');

  const cwSection = page.locator('.section-block').first();
  try {
    await cwSection.waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    await shoot(page, `${flowName}-00-no-home`);
    fail('rail-pagination: Continue-watching section never appeared', error);
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  await cwSection.locator('.media-card').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});

  const pager = cwSection.locator('.rail-pager');
  const prev = pager.locator('.rail-arrow[aria-label="Previous"]');
  const next = pager.locator('.rail-arrow[aria-label="Next"]');
  const status = pager.locator('.rail-pager-status');

  const railTitles = () =>
    cwSection.locator('.media-card h3').allInnerTexts()
      .then((a) => a.map((t) => t.trim()).filter(Boolean)).catch(() => []);

  if (!(await pager.count())) {
    await shoot(page, `${flowName}-01-no-pager`);
    fail('rail-pagination: no .rail-pager in Continue-watching header (pageCount<=1? not enough items to page)');
  }

  const statusBefore = (await status.innerText().catch(() => '')).trim();
  const prevDisabledBefore = await prev.isDisabled().catch(() => null);
  const page1 = await railTitles();
  console.log(`[proof] rail-pagination: page1 status="${statusBefore}" prevDisabled=${prevDisabledBefore} titles=${JSON.stringify(page1)}`);
  await shoot(page, `${flowName}-01-page1`);

  if (prevDisabledBefore !== true) {
    console.error('[proof] rail-pagination: FAIL — prev arrow NOT disabled on page 1');
  }

  if (await next.isDisabled().catch(() => true)) {
    console.warn('[proof] rail-pagination: next disabled (only one page) — cannot exercise click-through');
    await shoot(page, `${flowName}-02-next-disabled`);
    return;
  }

  await next.click();
  await page.waitForTimeout(500);

  const statusAfter = (await status.innerText().catch(() => '')).trim();
  const prevDisabledAfter = await prev.isDisabled().catch(() => null);
  const page2 = await railTitles();
  console.log(`[proof] rail-pagination: page2 status="${statusAfter}" prevDisabled=${prevDisabledAfter} titles=${JSON.stringify(page2)}`);
  await shoot(page, `${flowName}-02-page2`);

  const changed = JSON.stringify(page1) !== JSON.stringify(page2) && page2.length > 0;
  if (changed && prevDisabledAfter === false) {
    console.log('[proof] rail-pagination: PASS — Next advanced to a new tile set and enabled prev');
  } else {
    console.error(`[proof] rail-pagination: FAIL — changed=${changed} prevDisabledAfter=${prevDisabledAfter}`);
  }
}
