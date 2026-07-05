import { pickEveryonePartyAndContinue } from '../lib/viewer.mjs';
import {
  seedInProgressEpisode,
  seedPartialCard,
  seedInteractiveShow,
  seedStaggeredShow,
  seedRemovableMovie,
} from '../lib/seed-inprogress.mjs';

// card-order flow: proves "Stabilize continue-watching card order". The rail is
// sorted server-side deterministically by show/movie name (case-insensitive,
// alphabetical) with a stable id tie-break (mergeContinueWatching). A
// viewer-watched pill toggle refetches the rail; the LEFT-TO-RIGHT card order
// must come back IDENTICAL and be alphabetical by name.
export const match = /card-order|order|stable|reshuffle/i;

const rail = (page) => page.locator('.section-block').first();
const cards = (page) => rail(page).locator('.media-card');

async function railOrder(page) {
  return cards(page)
    .locator('h3')
    .allInnerTexts()
    .then((arr) => arr.map((t) => t.trim()).filter(Boolean))
    .catch(() => []);
}

const isAlphabetical = (names) => {
  for (let i = 1; i < names.length; i += 1) {
    if (names[i - 1].localeCompare(names[i], undefined, { sensitivity: 'base' }) > 0) {
      return false;
    }
  }
  return true;
};

const sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export async function run(page, ctx) {
  const { fail, shoot, flowName } = ctx;
  const jellyfinEnv = { url: process.env.JELLYFIN_URL, apiKey: process.env.JELLYFIN_API_KEY };

  let showSeed = null;
  try {
    showSeed = await seedInProgressEpisode(jellyfinEnv, console.log);
  } catch (e) {
    console.warn('[proof] card-order: show-advance seed failed: ' + (e?.message ?? e));
  }
  let partialSeed = null;
  try {
    partialSeed = await seedPartialCard(jellyfinEnv, {}, console.log);
  } catch (e) {
    console.warn('[proof] card-order: partial seed failed: ' + (e?.message ?? e));
  }
  try {
    await seedRemovableMovie(
      jellyfinEnv,
      { excludeMovieIds: partialSeed?.id ? [partialSeed.id] : [] },
      console.log,
    );
  } catch (e) {
    console.warn('[proof] card-order: removable-movie seed failed: ' + (e?.message ?? e));
  }
  try {
    await seedInteractiveShow(
      jellyfinEnv,
      { excludeSeriesIds: showSeed?.seriesId ? [showSeed.seriesId] : [] },
      console.log,
    );
  } catch (e) {
    console.warn('[proof] card-order: interactive-show seed failed: ' + (e?.message ?? e));
  }
  try {
    await seedStaggeredShow(jellyfinEnv, { excludeSeriesIds: [showSeed?.seriesId].filter(Boolean) }, console.log);
  } catch (e) {
    console.warn('[proof] card-order: staggered-show seed failed: ' + (e?.message ?? e));
  }

  await pickEveryonePartyAndContinue(page, flowName);

  try {
    await rail(page).waitFor({ state: 'visible', timeout: 30000 });
  } catch (error) {
    await shoot(page, flowName + '-00-no-home');
    fail('card-order: Continue-watching section never appeared', error);
  }
  await page.waitForLoadState('networkidle');
  try {
    await cards(page).first().waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    await shoot(page, flowName + '-00-empty-rail');
    fail('card-order: Continue-watching rail is EMPTY; cannot prove order. Seed in-progress items.');
  }

  const before = await railOrder(page);
  console.log('[proof] card-order: BASELINE order [' + before.length + '] = ' + JSON.stringify(before));
  await shoot(page, flowName + '-01-order-before');

  if (before.length < 2) {
    console.warn('[proof] card-order: WARNING - only ' + before.length + ' card(s); ordering is trivial.');
  }

  const baseAlpha = isAlphabetical(before);
  if (baseAlpha) {
    console.log('[proof] card-order: PASS - baseline order is alphabetical (case-insensitive) by name.');
  } else {
    console.error('[proof] card-order: FAIL - baseline order is NOT alphabetical: ' + JSON.stringify(before));
  }

  const n = await cards(page).count();
  let pillCardIdx = -1;
  for (let i = 0; i < n; i += 1) {
    if ((await cards(page).nth(i).locator('.viewer-pill').count()) > 0) {
      pillCardIdx = i;
      break;
    }
  }

  let refetchedVia = 'reload';
  if (pillCardIdx !== -1) {
    refetchedVia = 'pill-toggle';
    const card = cards(page).nth(pillCardIdx);
    const pill = card.locator('.viewer-pill').first();
    const beforeCls = (await pill.getAttribute('class')) ?? '';
    console.log('[proof] card-order: toggling a viewer pill on card #' + pillCardIdx + ' to force a refetch');
    await pill.scrollIntoViewIfNeeded();
    await pill.click();
    await page.waitForTimeout(900);
    await page.waitForLoadState('networkidle').catch(() => {});
    const card2 = cards(page).nth(pillCardIdx);
    const pill2 = card2.locator('.viewer-pill').first();
    await pill2.scrollIntoViewIfNeeded().catch(() => {});
    await pill2.click().catch(() => {});
    await page.waitForTimeout(900);
    await page.waitForLoadState('networkidle').catch(() => {});
    console.log('[proof] card-order: pill toggled ON then OFF (net state restored); class was "' + beforeCls + '"');
  } else {
    console.warn('[proof] card-order: no viewer pill found; forcing a refetch via reload instead.');
  }

  await page.reload({ waitUntil: 'networkidle' });
  await rail(page).waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await cards(page).first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});

  const after = await railOrder(page);
  console.log('[proof] card-order: AFTER-refetch order [' + after.length + '] = ' + JSON.stringify(after) + ' (refetch via ' + refetchedVia + ' + reload)');
  await shoot(page, flowName + '-02-order-after');

  const stable = sameOrder(before, after);
  if (stable) {
    console.log('[proof] card-order: PASS - rail order IDENTICAL across the refetch (no reshuffle).');
  } else {
    console.error('[proof] card-order: FAIL - rail order CHANGED across refetch. before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));
  }

  const afterAlpha = isAlphabetical(after);
  if (afterAlpha) {
    console.log('[proof] card-order: PASS - post-refetch order is alphabetical by name.');
  } else {
    console.error('[proof] card-order: FAIL - post-refetch order is NOT alphabetical: ' + JSON.stringify(after));
  }

  if (!stable || !baseAlpha || !afterAlpha) {
    fail('card-order: order-stability/alphabetical assertion failed (see logs above).');
  }
  console.log('[proof] card-order: ALL PASS - order stable AND alphabetical across the refetch.');
}
