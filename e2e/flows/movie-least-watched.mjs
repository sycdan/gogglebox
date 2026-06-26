import { pickEveryoneGroupAndContinue } from '../lib/viewer.mjs';
import { seedMultiViewerMovie, seedStaggeredShow } from '../lib/seed-inprogress.mjs';
import { makeJellyfin } from '../lib/jellyfin.mjs';

// movie-least-watched flow: proves "Movies resume least-watched first".
//
// Backend rule (src/server/continueWatching.ts mergeContinueWatching ->
// preferLeastAdvanced): when the SAME movie is in-progress for several active-group
// viewers at different positions, the single group continue-watching card resumes
// from the LEAST-advanced viewer (LOWEST progressPercent). That viewer is the
// card's sourceViewer / resume point, so the card's % badge + progress bar must
// reflect the LOWEST viewer's position — not the most-watched.
//
// Shows are unaffected: a same-series show card still anchors to the EARLIEST
// not-all-watched episode (preferEarlierShow), proven alongside.
export const match = /movie-least-watched|least-watched|resume-least/i;

const rail = (page) => page.locator('.section-block').first();
const cards = (page) => rail(page).locator('.media-card');

// Read a card's % badge as an integer.
async function cardPercent(card) {
  const txt = (await card.locator('.badge').first().innerText().catch(() => '')).trim();
  const m = txt.match(/(\d+)\s*%/);
  return m ? Number(m[1]) : null;
}

async function findCardByExactTitle(page, title) {
  const n = await cards(page).count();
  for (let i = 0; i < n; i += 1) {
    const card = cards(page).nth(i);
    const h3 = (await card.locator('h3').first().innerText().catch(() => '')).trim();
    if (h3 === title) return card;
  }
  return cards(page).filter({ hasText: '__no_such_title__' });
}

// Find the rail card whose `.meta` line CONTAINS `needle` (case-insensitive).
// Show cards put the EPISODE name in <h3> and the SERIES name in `.meta`
// ("Series Name • SxxExx"), so a show is located by its series name here, not h3.
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

export async function run(page, ctx) {
  const { fail, shoot, shootView, flowName } = ctx;
  const jellyfinEnv = { url: process.env.JELLYFIN_URL, apiKey: process.env.JELLYFIN_API_KEY };

  // Clean slate so only our two fixtures sit on the rail (deterministic read).
  try {
    const jf = makeJellyfin(jellyfinEnv.url, jellyfinEnv.apiKey);
    await jf.resetAllPlayedState(console.log);
  } catch (e) {
    console.warn('[proof] movie-least-watched: reset failed: ' + (e?.message ?? e));
  }

  // Seed the multi-viewer staggered movie (the subject under test).
  let movieSeed = null;
  try {
    movieSeed = await seedMultiViewerMovie(jellyfinEnv, {}, console.log);
  } catch (e) {
    console.warn('[proof] movie-least-watched: movie seed failed: ' + (e?.message ?? e));
  }
  if (!movieSeed) {
    fail('movie-least-watched: could not seed a multi-viewer in-progress movie (DATA GAP).');
  }

  // Seed a staggered SHOW too, so we can confirm shows are unaffected (still
  // earliest not-all-watched episode).
  let showSeed = null;
  try {
    showSeed = await seedStaggeredShow(jellyfinEnv, {}, console.log);
  } catch (e) {
    console.warn('[proof] movie-least-watched: show seed failed: ' + (e?.message ?? e));
  }

  await pickEveryoneGroupAndContinue(page, flowName);

  try {
    await rail(page).waitFor({ state: 'visible', timeout: 30000 });
  } catch (error) {
    await shoot(page, flowName + '-00-no-home');
    fail('movie-least-watched: Continue-watching section never appeared', error);
  }
  await page.waitForLoadState('networkidle');
  try {
    await cards(page).first().waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    await shoot(page, flowName + '-00-empty-rail');
    fail('movie-least-watched: Continue-watching rail is EMPTY; cannot prove. Seed failed?');
  }

  await shoot(page, flowName + '-01-rail');

  // Locate the movie card by its name (h3 exact).
  const movieCard = await findCardByExactTitle(page, movieSeed.name);
  if (await movieCard.count().then((c) => c === 0)) {
    await shoot(page, flowName + '-02-no-movie-card');
    fail('movie-least-watched: movie card "' + movieSeed.name + '" not found on the rail.');
  }

  await movieCard.scrollIntoViewIfNeeded().catch(() => {});
  await shootView(page, flowName + '-02-movie-card');

  const shownPercent = await cardPercent(movieCard);
  const expectLeast = movieSeed.leastWatched.percent;
  const expectMost = movieSeed.mostWatched.percent;
  console.log(
    '[proof] movie-least-watched: movie "' + movieSeed.name + '" card shows ' + shownPercent + '% ' +
    '(expected LEAST-watched ' + expectLeast + '%, NOT most-watched ' + expectMost + '%). ' +
    'Per-viewer seed: ' + movieSeed.perViewer.map((p) => p.userName + ':' + p.percent + '%').join(', '),
  );

  // Allow a small rounding tolerance (ticks->% rounding, watched-threshold scaling).
  const TOL = 4;
  const matchesLeast = shownPercent !== null && Math.abs(shownPercent - expectLeast) <= TOL;
  const matchesMost = shownPercent !== null && Math.abs(shownPercent - expectMost) <= TOL;

  if (matchesLeast && !matchesMost) {
    console.log('[proof] movie-least-watched: PASS - movie card resumes from the LEAST-watched viewer (' + shownPercent + '% ~= ' + expectLeast + '%).');
  } else if (matchesMost) {
    fail('movie-least-watched: FAIL - movie card shows the MOST-watched viewer (' + shownPercent + '% ~= ' + expectMost + '%). Expected least-watched ' + expectLeast + '%.');
  } else {
    fail('movie-least-watched: FAIL - movie card % (' + shownPercent + '%) matches neither least (' + expectLeast + '%) nor most (' + expectMost + '%).');
  }

  // Shows-unaffected check: find the show card by its .meta (series name lives in
  // .meta, NOT h3 which holds the episode name) and confirm its SxxExx is the
  // expected ANCHOR (earliest not-all-watched episode).
  if (showSeed) {
    const showCard = await findCardByMeta(page, showSeed.seriesName);
    if (await showCard.count().then((c) => c > 0)) {
      await showCard.scrollIntoViewIfNeeded().catch(() => {});
      await shootView(page, flowName + '-03-show-card');
      const meta = (await showCard.locator('.meta').first().innerText().catch(() => '')).trim();
      const code = (meta.match(/S\d{2}E\d{2}/) || [])[0] ?? null;
      console.log('[proof] movie-least-watched: show "' + showSeed.seriesName + '" card meta="' + meta + '" -> code ' + code + ' (expected anchor ' + showSeed.anchor.code + ').');
      if (code === showSeed.anchor.code) {
        console.log('[proof] movie-least-watched: PASS - show card unaffected; anchored to earliest not-all-watched episode ' + code + '.');
      } else {
        console.error('[proof] movie-least-watched: NOTE - show card code ' + code + ' != expected anchor ' + showSeed.anchor.code + ' (shows-unaffected check).');
      }
    } else {
      console.warn('[proof] movie-least-watched: show card "' + showSeed.seriesName + '" not found for the unaffected-check.');
    }
  } else {
    console.warn('[proof] movie-least-watched: no show seed; skipping shows-unaffected check.');
  }

  console.log('[proof] movie-least-watched: done.');
}
