import { pickEveryoneGroupAndContinue } from '../lib/viewer.mjs';
import { seedMultiViewerMovie, seedStaggeredShow } from '../lib/seed-inprogress.mjs';
import { makeJellyfin } from '../lib/jellyfin.mjs';
import { collectAllRailCards, goToFirstRailPage, goToRailPage } from '../lib/rail.mjs';

// movie-least-watched flow: proves "same-movie collisions resume the viewer
// with the least real progress".
//
// Backend rule (src/server/continueWatching.ts mergeContinueWatching ->
// pickRepresentative): when the SAME movie is in-progress for several
// active-group viewers at different positions, they all collide on the same
// movie id (movies have no episode granularity), and the single group card
// resumes from the viewer with the LEAST real progress (ties: prefer an
// actual resume position over a NextUp placeholder, then lower %). That
// viewer becomes the card's sourceViewer / resume point, so nobody's
// progress gets skipped past or spoiled ahead.
//
// Shows are unaffected in kind but different in shape: a series with viewers on
// DIFFERENT episodes no longer collapses to one anchored card — every distinct
// episode candidate now gets its OWN rail card (fan-out). Proven alongside.
export const match = /movie-least-watched|least-watched|resume-least/i;

const rail = (page) => page.locator('.section-block').first();
const cards = (page) => rail(page).locator('.media-card');

// Read a card's % badge as an integer.
async function cardPercent(card) {
  const txt = (await card.locator('.badge').first().innerText().catch(() => '')).trim();
  const m = txt.match(/(\d+)\s*%/);
  return m ? Number(m[1]) : null;
}

// Finds a card by exact <h3> title, walking the WHOLE rail (not just the
// first-rendered page — see collectAllRailCards in e2e/lib/rail.mjs) since the
// rail may share this movie's page with other seeded cards (e.g. the show
// fan-out fixture below) and push it past page 1. Returns { found, pageIndex }
// so the caller can page back to it before interacting; `found` is false (no
// live Locator) if no page had a matching title.
async function findCardPageByExactTitle(page, title) {
  await goToFirstRailPage(page, rail(page));
  const matches = await collectAllRailCards(page, rail(page), async (card, pageIndex) => {
    const h3 = (await card.locator('h3').first().innerText().catch(() => '')).trim();
    return { h3, pageIndex };
  });
  const hit = matches.find((m) => m.h3 === title);
  return hit ? { found: true, pageIndex: hit.pageIndex } : { found: false, pageIndex: -1 };
}

// Re-locate a live card Locator by exact <h3> title on the CURRENT rail page
// only (caller must already be on the right page, e.g. via goToRailPage).
async function resolveCardOnCurrentPageByTitle(page, title) {
  const n = await cards(page).count();
  for (let i = 0; i < n; i += 1) {
    const card = cards(page).nth(i);
    const h3 = (await card.locator('h3').first().innerText().catch(() => '')).trim();
    if (h3 === title) return card;
  }
  return null;
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

  // Locate the movie card by its name (h3 exact), walking the whole rail.
  const movieLocation = await findCardPageByExactTitle(page, movieSeed.name);
  if (!movieLocation.found) {
    await shoot(page, flowName + '-02-no-movie-card');
    fail('movie-least-watched: movie card "' + movieSeed.name + '" not found on the rail.');
  }
  await goToRailPage(page, rail(page), movieLocation.pageIndex);
  const movieCard = await resolveCardOnCurrentPageByTitle(page, movieSeed.name);
  if (!movieCard) {
    await shoot(page, flowName + '-02-no-movie-card');
    fail('movie-least-watched: movie card "' + movieSeed.name + '" disappeared after paging back to it.');
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
    console.log('[proof] movie-least-watched: PASS - movie card resumes from the viewer with the LEAST real progress (' + shownPercent + '% ~= ' + expectLeast + '%).');
  } else if (matchesMost) {
    fail('movie-least-watched: FAIL - movie card shows the MOST-watched viewer (' + shownPercent + '% ~= ' + expectMost + '%). Expected least-watched ' + expectLeast + '%.');
  } else {
    fail('movie-least-watched: FAIL - movie card % (' + shownPercent + '%) matches neither most (' + expectMost + '%) nor least (' + expectLeast + '%).');
  }

  // Shows fan-out check: viewers staggered across DIFFERENT episodes of one
  // series must now produce ONE CARD PER DISTINCT EPISODE (no single anchored
  // card), each showing that candidate's own SxxExx. The rail pages 3 cards at
  // a time (RAIL_PAGE_SIZE in src/client/App.tsx), so with 4 staggered viewers
  // sharing one series name, checking only the first-rendered page can
  // under-count a card that landed on a later page — walk the WHOLE rail via
  // the "›" arrow (collectAllRailCards) instead of reading a single page.
  if (showSeed) {
    const expectedCodes = [...new Set((showSeed.perViewer ?? []).map((p) => p.code))];
    await goToFirstRailPage(page, rail(page));
    const wantSeries = showSeed.seriesName.toLowerCase();
    const foundCodes = [];
    await collectAllRailCards(page, rail(page), async (card) => {
      const meta = (await card.locator('.meta').first().innerText().catch(() => '')).toLowerCase();
      if (meta.includes(wantSeries)) {
        const code = (meta.match(/S\d{2}E\d{2}/i) || [])[0] ?? null;
        if (code) foundCodes.push(code.toUpperCase());
      }
      return null;
    });
    console.log(
      '[proof] movie-least-watched: show "' + showSeed.seriesName + '" fan-out check — expected episode codes ' +
      JSON.stringify(expectedCodes) + ', found on rail (all pages) ' + JSON.stringify(foundCodes),
    );
    const missing = expectedCodes.filter((c) => !foundCodes.includes(c));
    if (missing.length === 0 && foundCodes.length >= expectedCodes.length) {
      console.log('[proof] movie-least-watched: PASS - every staggered viewer\'s episode has its OWN rail card (fan-out), independent of the movie rule.');
    } else {
      await shootView(page, flowName + '-03-show-fanout-missing');
      fail('movie-least-watched: FAIL - expected fan-out cards ' + JSON.stringify(expectedCodes) + ' but rail (all pages) only shows ' + JSON.stringify(foundCodes) + ' (missing ' + JSON.stringify(missing) + ').');
    }
    await goToFirstRailPage(page, rail(page));
    await shootView(page, flowName + '-03-show-fanout');
  } else {
    console.warn('[proof] movie-least-watched: no show seed; skipping show fan-out check.');
  }

  console.log('[proof] movie-least-watched: done.');
}
