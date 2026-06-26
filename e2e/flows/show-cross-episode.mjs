import { pickEveryoneGroupAndContinue } from '../lib/viewer.mjs';
import { seedCrossEpisodeShow } from '../lib/seed-inprogress.mjs';
import { makeJellyfin } from '../lib/jellyfin.mjs';

// show-cross-episode flow: proves the SHOW continue-watching card anchors on
// EPISODE ORDER FIRST, then resumes from the least-advanced viewer AT that
// anchor — the "don't spoil the furthest-behind" rule, and the key way SHOWS
// differ from MOVIES (movies have one episode so they reduce to lowest %).
//
// Seed: one series, single active group, viewers on DIFFERENT episodes with
// mid-episode partial progress:
//   Alice: finished E2, ~10% into E3
//   Bob:   ~20% into E2
//   Carol: ~2% into E1 (unfinished)
// Expected card: anchors to S01E01 (Carol hasn't finished it) at ~2% (Carol),
// NOT Alice's E3 position.
export const match = /show-cross-episode|cross-episode|dont-spoil|anchor/i;

const rail = (page) => page.locator('.section-block').first();
const cards = (page) => rail(page).locator('.media-card');

// Find the rail card whose `.meta` line CONTAINS `needle` (case-insensitive).
// Show cards put the EPISODE name in <h3> and the SERIES name in `.meta`.
async function findCardByMeta(page, needle) {
  const n = await cards(page).count();
  const want = needle.toLowerCase();
  for (let i = 0; i < n; i += 1) {
    const card = cards(page).nth(i);
    const meta = (await card.locator('.meta').first().innerText().catch(() => '')).toLowerCase();
    if (meta.includes(want)) return card;
  }
  return cards(page).filter({ hasText: '__no_such_meta__' });
}

async function cardPercent(card) {
  const txt = (await card.locator('.badge').first().innerText().catch(() => '')).trim();
  const m = txt.match(/(\d+)\s*%/);
  return m ? Number(m[1]) : null;
}

export async function run(page, ctx) {
  const { fail, shoot, shootView, flowName } = ctx;
  const jellyfinEnv = { url: process.env.JELLYFIN_URL, apiKey: process.env.JELLYFIN_API_KEY };

  // Clean slate so only our seeded series sits on the rail (deterministic read).
  try {
    const jf = makeJellyfin(jellyfinEnv.url, jellyfinEnv.apiKey);
    await jf.resetAllPlayedState(console.log);
  } catch (e) {
    console.warn('[proof] show-cross-episode: reset failed: ' + (e?.message ?? e));
  }

  let seed = null;
  try {
    seed = await seedCrossEpisodeShow(jellyfinEnv, {}, console.log);
  } catch (e) {
    console.warn('[proof] show-cross-episode: seed failed: ' + (e?.message ?? e));
  }
  if (!seed) {
    fail('show-cross-episode: could not seed a cross-episode partial-progress show (DATA GAP).');
  }

  await pickEveryoneGroupAndContinue(page, flowName);

  try {
    await rail(page).waitFor({ state: 'visible', timeout: 30000 });
  } catch (error) {
    await shoot(page, flowName + '-00-no-home');
    fail('show-cross-episode: Continue-watching section never appeared', error);
  }
  await page.waitForLoadState('networkidle');
  try {
    await cards(page).first().waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    await shoot(page, flowName + '-00-empty-rail');
    fail('show-cross-episode: Continue-watching rail is EMPTY; cannot prove. Seed failed?');
  }

  await shoot(page, flowName + '-01-rail');

  const showCard = await findCardByMeta(page, seed.seriesName);
  if (await showCard.count().then((c) => c === 0)) {
    await shoot(page, flowName + '-02-no-show-card');
    fail('show-cross-episode: show card for series "' + seed.seriesName + '" not found on the rail.');
  }

  await showCard.scrollIntoViewIfNeeded().catch(() => {});
  await shootView(page, flowName + '-02-show-card');

  const meta = (await showCard.locator('.meta').first().innerText().catch(() => '')).trim();
  const code = (meta.match(/S\d{2}E\d{2}/) || [])[0] ?? null;
  const shownPercent = await cardPercent(showCard);

  console.log(
    '[proof] show-cross-episode: card meta="' + meta + '" code=' + code + ' percent=' + shownPercent + '% ' +
    '| seeded viewers: ' + seed.perViewer.map((p) => p.userName + ':' + p.code + '@' + p.percent + '%').join(', ') +
    ' | EXPECT anchor ' + seed.anchor.code + ' @~' + seed.anchor.percent + '% (' + seed.anchor.viewerName + ').',
  );

  const anchorOk = code === seed.anchor.code;
  // Episode 1 is the anchor; resume must reflect the least-advanced viewer there
  // (~2%), NOT the furthest-ahead viewer's E3 (~10%). Small rounding tolerance.
  const TOL = 4;
  const percentOk = shownPercent !== null && Math.abs(shownPercent - seed.anchor.percent) <= TOL;
  // Guard against the "spoil" regression: card must NOT be on E3 or showing ~10%.
  const isE3 = code === seed.episodes.e3;

  if (anchorOk) {
    console.log('[proof] show-cross-episode: PASS - card anchored to EARLIEST not-all-watched episode ' + code + ' (episode order beats progress).');
  } else {
    fail('show-cross-episode: FAIL - card anchored to ' + code + ', expected earliest ' + seed.anchor.code + (isE3 ? ' (SPOILED to the furthest-ahead viewer E3!)' : '') + '.');
  }

  if (percentOk) {
    console.log('[proof] show-cross-episode: PASS - resume reflects the least-advanced viewer at the anchor (~' + shownPercent + '% ~= ' + seed.anchor.percent + '%), don\'t-spoil-the-furthest-behind.');
  } else {
    fail('show-cross-episode: FAIL - resume % (' + shownPercent + '%) does not match the least-advanced-at-anchor ~' + seed.anchor.percent + '%.');
  }

  console.log('[proof] show-cross-episode: ALL PASS - anchor=' + code + ' @' + shownPercent + '% (don\'t-spoil case).');
}
