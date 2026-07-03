import { pickEveryoneGroupAndContinue } from '../lib/viewer.mjs';
import { seedStaggeredShow } from '../lib/seed-inprogress.mjs';
import { makeJellyfin } from '../lib/jellyfin.mjs';

// show-cross-episode flow: proves the Ancient-Aliens-style FAN-OUT model.
// Continue-watching no longer collapses a series to one anchored card: every
// distinct episode candidate that an active viewer is currently on gets its
// OWN rail card. Seeded fixture (seedStaggeredShow): 3+ viewers staggered
// across DIFFERENT episodes of one series.
//
// Proof steps:
//   1. The rail shows ONE CARD PER DISTINCT staggered episode (not one merged
//      anchor card) for the seeded series.
//   2. Ignoring ONE of those episode-cards (via the "Ignore this episode"
//      flyout choice) removes ONLY that card — the other staggered episode
//      card(s) for the SAME series remain, and no "replacement" episode
//      appears in its place (there is nothing to advance to; fan-out already
//      gave every candidate its own card).
export const match = /show-cross-episode|cross-episode|dont-spoil|anchor|fan-out|fanout/i;

const rail = (page) => page.locator('.section-block').first();
const cards = (page) => rail(page).locator('.media-card');

// All rail cards whose `.meta` line contains the series name, with their SxxExx
// code and a handle to the card itself. Show cards put the EPISODE name in
// <h3> and "SeriesName • SxxExx" in `.meta`.
async function findSeriesCards(page, seriesName) {
  const n = await cards(page).count();
  const want = seriesName.toLowerCase();
  const found = [];
  for (let i = 0; i < n; i += 1) {
    const card = cards(page).nth(i);
    const meta = (await card.locator('.meta').first().innerText().catch(() => '')).trim();
    if (meta.toLowerCase().includes(want)) {
      const code = (meta.match(/S\d{2}E\d{2}/i) || [])[0]?.toUpperCase() ?? null;
      found.push({ card, meta, code });
    }
  }
  return found;
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
    seed = await seedStaggeredShow(jellyfinEnv, {}, console.log);
  } catch (e) {
    console.warn('[proof] show-cross-episode: seed failed: ' + (e?.message ?? e));
  }
  if (!seed) {
    fail('show-cross-episode: could not seed a staggered (fan-out) show fixture (DATA GAP).');
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

  // ── Step 1: fan-out — one card per distinct staggered episode ────────────
  const expectedCodes = [...new Set(seed.perViewer.map((p) => p.code))];
  let seriesCards = await findSeriesCards(page, seed.seriesName);
  const foundCodes = seriesCards.map((c) => c.code).filter(Boolean);
  console.log(
    '[proof] show-cross-episode: "' + seed.seriesName + '" staggered viewers at ' +
    seed.perViewer.map((p) => p.userName + ':' + p.code).join(', ') +
    ' | expected fan-out codes ' + JSON.stringify(expectedCodes) + ', found ' + JSON.stringify(foundCodes),
  );

  const missing = expectedCodes.filter((code) => !foundCodes.includes(code));
  if (missing.length === 0 && foundCodes.length >= expectedCodes.length) {
    console.log('[proof] show-cross-episode: PASS - every staggered viewer\'s episode has its OWN rail card (fan-out), not one merged anchor.');
  } else {
    await shoot(page, flowName + '-02-fanout-missing');
    fail('show-cross-episode: FAIL - expected one card per episode ' + JSON.stringify(expectedCodes) + ', rail only shows ' + JSON.stringify(foundCodes) + '.');
  }

  if (seriesCards[0]) {
    await seriesCards[0].card.scrollIntoViewIfNeeded().catch(() => {});
    await shootView(page, flowName + '-02-fanout-cards');
  }

  // ── Step 2: ignore ONE episode-card; the OTHER must remain untouched ─────
  // Pick the card whose code is NOT the anchor (earliest) episode, so this also
  // proves ignoring a later episode does not resurrect/replace the earlier one.
  const target = seriesCards.find((c) => c.code && c.code !== seed.anchor.code) ?? seriesCards[0];
  const keep = seriesCards.find((c) => c !== target);
  if (!target || !keep) {
    fail('show-cross-episode: need at least two distinct fan-out cards to prove ignore-one-keeps-other; only found ' + seriesCards.length + '.');
  }
  console.log('[proof] show-cross-episode: ignoring episode ' + target.code + ', expecting ' + keep.code + ' to remain untouched.');

  const ignoreBtn = target.card.locator('.ignore-flyout button', { hasText: /^Ignore$/ }).first();
  await ignoreBtn.scrollIntoViewIfNeeded().catch(() => {});
  await ignoreBtn.click();
  const episodeChoice = target.card.locator('.ignore-flyout-menu button', { hasText: /^Ignore this episode$/ }).first();
  try {
    await episodeChoice.waitFor({ state: 'visible', timeout: 5000 });
  } catch (error) {
    await shoot(page, flowName + '-03-no-flyout');
    fail('show-cross-episode: "Ignore this episode" flyout choice did not appear on the target card.', error);
  }
  await episodeChoice.click();

  // Poll until the target episode's card is gone.
  let removed = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    const current = await findSeriesCards(page, seed.seriesName);
    const stillHasTarget = current.some((c) => c.code === target.code);
    const stillHasKeep = current.some((c) => c.code === keep.code);
    if (!stillHasTarget && stillHasKeep) {
      removed = true;
      break;
    }
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  await shoot(page, flowName + '-04-after-ignore-episode');

  seriesCards = await findSeriesCards(page, seed.seriesName);
  const codesAfter = seriesCards.map((c) => c.code).filter(Boolean);
  console.log('[proof] show-cross-episode: after ignoring ' + target.code + ', rail shows ' + JSON.stringify(codesAfter) + ' for this series.');

  if (!removed) {
    fail('show-cross-episode: FAIL - ignored episode ' + target.code + ' is still present, or the kept episode ' + keep.code + ' disappeared too. codes=' + JSON.stringify(codesAfter));
  }
  if (codesAfter.includes(target.code)) {
    fail('show-cross-episode: FAIL - ignored episode ' + target.code + ' still on the rail.');
  }
  if (!codesAfter.includes(keep.code)) {
    fail('show-cross-episode: FAIL - the OTHER episode ' + keep.code + ' disappeared too (ignore must not cascade to the whole series).');
  }
  // No "replacement" episode should appear for the ignored one: exactly the
  // remaining expected codes (minus the ignored one), nothing new.
  const stillExpected = expectedCodes.filter((code) => code !== target.code);
  const unexpectedNew = codesAfter.filter((code) => !stillExpected.includes(code));
  if (unexpectedNew.length > 0) {
    fail('show-cross-episode: FAIL - unexpected replacement episode(s) appeared after ignoring ' + target.code + ': ' + JSON.stringify(unexpectedNew));
  }

  console.log('[proof] show-cross-episode: PASS - ignoring one episode-card removed ONLY that card; the other stayed, and no replacement episode appeared.');
  console.log('[proof] show-cross-episode: ALL PASS - fan-out + scoped episode-ignore both verified.');
}
