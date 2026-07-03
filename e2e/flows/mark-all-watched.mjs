import { pickEveryoneGroupAndContinue } from '../lib/viewer.mjs';
import { seedInProgressEpisode, seedPartialCard, seedInteractiveShow, seedStaggeredShow, seedRemovableMovie } from '../lib/seed-inprogress.mjs';

// mark-all-watched flow: proves the per-viewer fully-watched policy on
// Continue-watching cards. With instant-advance (Part A), toggleViewerWatched
// refetches /api/continue-watching after the server write, so the SHOW card
// advances / the MOVIE card drops LIVE without a page reload.
//
//   0. Seed a mid-series episode as in-progress for every Jellyfin user so the
//      rail has a SHOW card with a real "next episode" (self-contained fixture).
//   1. Baseline rail screenshot before any change.
//   2. SHOW card: mark EVERY active viewer watched. Assert the card ADVANCES to
//      the next episode (same series, different SxxExx, progress reset) WITHOUT
//      a reload (instant). A reload-based re-check follows as a backstop.
//   3. MOVIE / last-episode card: mark EVERY viewer watched, card REMOVED.
//   4. Partial: a seeded movie with one viewer pre-watched stays on the rail
//      with a LIT pill next to UNLIT pills (static subset evidence).
//   5. Interactive mid-transition: a seeded SHOW with a SUBSET of N household
//      viewers watched. CLICK the remaining unwatched pills one at a time; each
//      non-final click STAYS on the same episode (k/N -> k+1/N), and the click
//      that completes N/N ADVANCES the card. Counts derive from the real pill
//      count (household size), not a hardcoded 3.
//   6. Stable group anchor (regression for the "episode jumps" bug): the active
//      household viewers sit on DIFFERENT episodes of one series. The card must
//      show the EARLIEST episode, and toggling a viewer who is AHEAD of the
//      anchor must NOT change the displayed episode.
export const match = /mark-all|all-watched|advance|fully-watched/i;

const BULLET = String.fromCharCode(8226);
const rail = (page) => page.locator('.section-block').first();
const cards = (page) => rail(page).locator('.media-card');
const isShowMeta = (m) => /S\d{2}E\d{2}/i.test(m);
const seriesOf = (meta) => meta.split(BULLET)[0].trim();

async function readCard(card) {
  const name = (await card.locator('h3').first().innerText().catch(() => '')).trim();
  const meta = (await card.locator('.meta').first().innerText().catch(() => '')).trim();
  const badge = (await card.locator('.badge').first().innerText().catch(() => '')).trim();
  const pillCount = await card.locator('.viewer-pill').count();
  const watchedPills = await card.locator('.viewer-pill.watched').count();
  return { name, meta, badge, pillCount, watchedPills };
}

async function snapshotRail(page) {
  const n = await cards(page).count();
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(await readCard(cards(page).nth(i)));
  return out;
}

// Re-resolve a card by a STABLE attribute (its <h3> name / series text), so a
// refetch re-render doesn't leave us holding a detached handle. Returns a fresh
// Locator each call. For shows, match on the series prefix in the meta line; for
// movies, match on the card name. Index into the current rail snapshot.
function cardByPredicate(page, predicate) {
  return async () => {
    const snap = await snapshotRail(page);
    const idx = snap.findIndex(predicate);
    return idx === -1 ? cards(page).nth(9999) /* empty locator */ : cards(page).nth(idx);
  };
}

// Find a card index live, by predicate, returning -1 if absent.
async function findCardIndex(page, predicate) {
  const snap = await snapshotRail(page);
  return snap.findIndex(predicate);
}

// Mark EVERY viewer on a card watched. Because the instant-advance feature
// refetches and RE-RENDERS the rail after each pill click, the card's pill DOM
// nodes detach between clicks. So we re-resolve the card via `findCard()` (a
// fresh Locator each call, e.g. by series name) after every click and click the
// next still-unwatched pill, looping until no unwatched pill remains OR the card
// detaches/advances (both success). `findCard` returns a Locator that may or may
// not currently exist; a count of 0 means the card advanced/was removed = done.
async function markAllViewersWatched(page, findCard, label, fail) {
  for (let guard = 0; guard < 24; guard += 1) {
    const card = await findCard();
    if ((await card.count()) === 0) {
      // Card advanced/removed by a prior click's refetch -> all-watched reached.
      return;
    }
    const pills = card.locator('.viewer-pill');
    const total = await pills.count().catch(() => 0);
    // Find the first NOT-yet-watched pill on the freshly-resolved card.
    let targetIdx = -1;
    for (let i = 0; i < total; i += 1) {
      const cls = await pills.nth(i).getAttribute('class').catch(() => null);
      if (cls === null) { targetIdx = -2; break; } // detaching mid-scan -> re-loop
      if (!cls.includes('watched')) { targetIdx = i; break; }
    }
    if (targetIdx === -2) {
      await page.waitForTimeout(200);
      continue;
    }
    if (targetIdx === -1) {
      // Every pill on the current card is watched. Either it will advance on the
      // next refetch or it is the terminal state; settle and finish.
      await page.waitForTimeout(400);
      await page.waitForLoadState('networkidle').catch(() => {});
      return;
    }

    const pill = pills.nth(targetIdx);
    await pill.scrollIntoViewIfNeeded().catch(() => {});
    await pill.click().catch(() => {});
    // Wait for this pill to flip watched, OR for the card/pill to detach (the
    // refetch replaced/removed it = the click registered and advanced).
    for (let t = 0; t < 40; t += 1) {
      const c = await pill.getAttribute('class').catch(() => null);
      if (c === null) break;                 // detached -> advanced/re-rendered
      if (c.includes('watched')) break;      // flipped
      await page.waitForTimeout(200);
    }
    // Let the post-toggle refetch settle before re-resolving the card.
    await page.waitForTimeout(700);
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  if (fail) fail(label + ': did not reach all-watched within the click budget');
}

async function reloadRail(page) {
  await page.reload({ waitUntil: 'networkidle' });
  await rail(page).waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);
}

// Click the first NOT-yet-watched viewer pill on a card and wait for its
// optimistic flip (or the card to detach if the refetch advanced it). Returns
// true if a pill was clicked, false if none were unwatched.
async function clickFirstUnwatchedPill(page, card, label, fail) {
  const pills = card.locator('.viewer-pill');
  const total = await pills.count();
  for (let i = 0; i < total; i += 1) {
    const pill = pills.nth(i);
    const cls = await pill.getAttribute('class').catch(() => null);
    if (cls === null) return false; // card detached
    if (cls.includes('watched')) continue;
    await pill.scrollIntoViewIfNeeded().catch(() => {});
    await pill.click();
    for (let t = 0; t < 40; t += 1) {
      const c = await pill.getAttribute('class').catch(() => null);
      if (c === null) break; // card replaced by the refetch (advanced)
      if (c.includes('watched')) break;
      await page.waitForTimeout(200);
    }
    // Let the post-toggle refetch settle so the rail reflects the server truth.
    await page.waitForTimeout(800);
    await page.waitForLoadState('networkidle').catch(() => {});
    return true;
  }
  if (fail) fail(label + ': no unwatched viewer pill to click');
  return false;
}

// Wait (no reload) for the rail to no longer contain the given (name, meta)
// card, i.e. the instant refetch replaced/removed it. Returns the new rail.
async function waitForRailChange(page, gone, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let snap = await snapshotRail(page);
  while (Date.now() < deadline) {
    const stillThere = snap.find((c) => c.name === gone.name && c.meta === gone.meta);
    if (!stillThere) return snap;
    await page.waitForTimeout(300);
    snap = await snapshotRail(page);
  }
  return snap;
}

export async function run(page, ctx) {
  const { fail, shoot, flowName } = ctx;

  // Part B: seed a self-contained in-progress mid-series episode so the rail has
  // a SHOW card with a real next episode. Needs Jellyfin admin creds in the
  // proof env (JELLYFIN_URL / JELLYFIN_API_KEY).
  const jellyfinEnv = { url: process.env.JELLYFIN_URL, apiKey: process.env.JELLYFIN_API_KEY };
  let seeded = null;
  try {
    seeded = await seedInProgressEpisode(jellyfinEnv, console.log);
  } catch (error) {
    console.warn('[proof] mark-all-watched: seeding failed (' + (error?.message ?? error) + '); falling back to whatever the rail already has.');
  }

  // Seed a dedicated PARTIAL card (one viewer watched, rest not) so step 4 can
  // screenshot a LIT pill next to UNLIT pills on a card that stays on the rail.
  let partialSeed = null;
  try {
    partialSeed = await seedPartialCard(jellyfinEnv, {}, console.log);
  } catch (error) {
    console.warn('[proof] mark-all-watched: partial-card seeding failed (' + (error?.message ?? error) + '); step 4 will fall back to live rail data.');
  }

  // Seed a dedicated REMOVABLE movie (in-progress, none watched) for step 3, on a
  // movie distinct from the partial-card movie so both fixtures coexist even on a
  // small library.
  let removableMovieSeed = null;
  try {
    removableMovieSeed = await seedRemovableMovie(
      jellyfinEnv,
      { excludeMovieIds: partialSeed?.id ? [partialSeed.id] : [] },
      console.log,
    );
  } catch (error) {
    console.warn('[proof] mark-all-watched: removable-movie seeding failed (' + (error?.message ?? error) + '); step 3 will fall back to live rail data.');
  }

  // Seed a dedicated INTERACTIVE SHOW (one household viewer pre-watched) for step
  // 5, on a series distinct from the show-advance fixture so the two don't collide.
  let interactiveSeed = null;
  try {
    interactiveSeed = await seedInteractiveShow(
      jellyfinEnv,
      { excludeSeriesIds: seeded?.seriesId ? [seeded.seriesId] : [] },
      console.log,
    );
  } catch (error) {
    console.warn('[proof] mark-all-watched: interactive-show seeding failed (' + (error?.message ?? error) + '); step 5 will be skipped.');
  }

  // Seed a STAGGERED show (3 viewers on different episodes) for step 6, on a
  // series distinct from the show-advance and interactive fixtures.
  let staggeredSeed = null;
  try {
    const excl = [seeded?.seriesId, interactiveSeed?.seriesId].filter(Boolean);
    staggeredSeed = await seedStaggeredShow(jellyfinEnv, { excludeSeriesIds: excl }, console.log);
  } catch (error) {
    console.warn('[proof] mark-all-watched: staggered-show seeding failed (' + (error?.message ?? error) + '); step 6 will be skipped.');
  }

  await pickEveryoneGroupAndContinue(page, flowName);

  try {
    await rail(page).waitFor({ state: 'visible', timeout: 30000 });
  } catch (error) {
    await shoot(page, flowName + '-00-no-home');
    fail('mark-all-watched: Continue-watching section never appeared', error);
  }
  await page.waitForLoadState('networkidle');
  try {
    await cards(page).first().waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    await shoot(page, flowName + '-00-empty-rail');
    fail('mark-all-watched: Continue-watching rail is EMPTY for this group. Seed in-progress movies AND shows in Jellyfin.');
  }

  const baseline = await snapshotRail(page);
  console.log('[proof] mark-all-watched: baseline rail [' + baseline.length + '] =', JSON.stringify(baseline));
  await shoot(page, flowName + '-01-baseline');

  // Prefer the series we seeded (so the assertion targets a card we KNOW has a
  // real next episode); otherwise fall back to any SHOW card with pills.
  const seededSeries = seeded?.seriesName ?? null;
  let showIdx = -1;
  if (seededSeries) {
    showIdx = baseline.findIndex((c) => isShowMeta(c.meta) && c.pillCount > 0 && seriesOf(c.meta) === seededSeries);
  }
  if (showIdx === -1) {
    showIdx = baseline.findIndex((c) => isShowMeta(c.meta) && c.pillCount > 0);
  }
  if (showIdx === -1) {
    console.warn('[proof] mark-all-watched: DATA GAP - no SHOW card with viewer pills; cannot prove next-episode advance.');
  } else {
    const before = baseline[showIdx];
    console.log('[proof] mark-all-watched: SHOW target ' + showIdx + ' name=' + JSON.stringify(before.name) + ' meta=' + JSON.stringify(before.meta) + ' badge=' + JSON.stringify(before.badge) + (seeded ? ' (expected next ' + (seeded.next?.code ?? '(none)') + ')' : ''));
    const showCard = cards(page).nth(showIdx);
    await showCard.scrollIntoViewIfNeeded();
    await showCard.locator('.play-row').first().screenshot({ path: ctx.outDir + '/' + flowName + '-02a-show-before.png' });
    console.log('[proof] screenshot: ' + ctx.outDir + '/' + flowName + '-02a-show-before.png');

    // INSTANT advance: mark all viewers watched on the CURRENT episode. Re-resolve
    // the card by the EXACT displayed episode (name+meta) each click so the
    // refetch re-render doesn't detach the pills mid-loop. Once every viewer has
    // watched this episode, the card advances -> the predicate no longer matches
    // -> markAllViewersWatched returns (that is the advance we assert below).
    await markAllViewersWatched(
      page,
      cardByPredicate(page, (c) => c.name === before.name && c.meta === before.meta),
      'mark-all-watched SHOW',
      fail,
    );
    const live = await waitForRailChange(page, before);
    await shoot(page, flowName + '-02b-show-after-instant');

    const seriesPrefix = seriesOf(before.meta);
    const liveAdvanced = live.find((c) => isShowMeta(c.meta) && c.meta !== before.meta && seriesOf(c.meta) === seriesPrefix);
    const liveStill = live.find((c) => c.name === before.name && c.meta === before.meta);
    if (liveAdvanced) {
      console.log('[proof] mark-all-watched: PASS INSTANT show advance (no reload) - ' + JSON.stringify(before.meta) + ' -> ' + JSON.stringify(liveAdvanced.meta));
    } else if (!liveStill) {
      console.log('[proof] mark-all-watched: INSTANT - show ' + JSON.stringify(before.name) + ' removed live (no reload); likely last episode.');
    } else {
      console.error('[proof] mark-all-watched: INSTANT advance FAILED - card unchanged after toggle (was ' + JSON.stringify(before.meta) + '). Part A refetch may not be wired up.');
    }

    // Backstop: reload and re-assert the server-side resolution agrees.
    await reloadRail(page);
    await shoot(page, flowName + '-02c-show-after-reload');
    const after = await snapshotRail(page);
    console.log('[proof] mark-all-watched: rail AFTER reload [' + after.length + '] =', JSON.stringify(after));
    const advancedSame = after.find((c) => isShowMeta(c.meta) && c.meta !== before.meta && seriesOf(c.meta) === seriesPrefix);
    const stillSame = after.find((c) => c.name === before.name && c.meta === before.meta);
    if (advancedSame) {
      console.log('[proof] mark-all-watched: reload confirms advance - ' + JSON.stringify(before.meta) + ' -> ' + JSON.stringify(advancedSame.meta) + ' badge ' + before.badge + ' -> ' + advancedSame.badge);
    } else if (!stillSame) {
      console.log('[proof] mark-all-watched: reload confirms show ' + JSON.stringify(before.name) + ' gone (last episode REMOVE).');
    } else {
      console.error('[proof] mark-all-watched: reload shows SHOW did NOT advance - still ' + JSON.stringify(stillSame.meta) + '.');
    }
  }

  let cur = await snapshotRail(page);
  // Prefer the dedicated removable-movie seed (guaranteed in-progress, 0 watched,
  // distinct from the partial movie). Fall back to any movie card with pills that
  // isn't the partial-card movie.
  const partialName = partialSeed?.name ?? null;
  let movieIdx = -1;
  if (removableMovieSeed?.name) {
    movieIdx = cur.findIndex((c) => !isShowMeta(c.meta) && c.pillCount > 0 && c.name === removableMovieSeed.name);
  }
  if (movieIdx === -1) {
    movieIdx = cur.findIndex((c) => !isShowMeta(c.meta) && c.pillCount > 0 && c.name !== partialName);
  }
  if (movieIdx === -1) {
    console.warn('[proof] mark-all-watched: DATA GAP - no MOVIE card with viewer pills (excluding the partial seed); cannot prove removal.');
  } else {
    const before = cur[movieIdx];
    console.log('[proof] mark-all-watched: MOVIE target ' + movieIdx + ' name=' + JSON.stringify(before.name) + ' meta=' + JSON.stringify(before.meta));
    const movieCard = cards(page).nth(movieIdx);
    await movieCard.scrollIntoViewIfNeeded();
    await movieCard.locator('.play-row').first().screenshot({ path: ctx.outDir + '/' + flowName + '-03a-movie-before.png' });
    console.log('[proof] screenshot: ' + ctx.outDir + '/' + flowName + '-03a-movie-before.png');

    // INSTANT removal: mark all viewers watched, then WITHOUT reloading wait for
    // the live rail to drop the movie (Part A refetch). Re-resolve by name+meta
    // each click so the refetch re-render doesn't detach the pills mid-loop.
    await markAllViewersWatched(
      page,
      cardByPredicate(page, (c) => c.name === before.name && c.meta === before.meta),
      'mark-all-watched MOVIE',
      fail,
    );
    const live = await waitForRailChange(page, before);
    await shoot(page, flowName + '-03b-movie-after-instant');
    const liveThere = live.find((c) => c.name === before.name && c.meta === before.meta);
    if (!liveThere) {
      console.log('[proof] mark-all-watched: PASS INSTANT movie removal (no reload) - ' + JSON.stringify(before.name) + ' gone from rail.');
    } else {
      console.error('[proof] mark-all-watched: INSTANT movie removal FAILED - ' + JSON.stringify(before.name) + ' still in rail after toggle.');
    }

    // Backstop: reload and confirm the server agrees.
    await reloadRail(page);
    await shoot(page, flowName + '-03c-movie-after-reload');
    const after = await snapshotRail(page);
    console.log('[proof] mark-all-watched: rail AFTER reload [' + after.length + '] =', JSON.stringify(after));
    const stillThere = after.find((c) => c.name === before.name && c.meta === before.meta);
    if (!stillThere) {
      console.log('[proof] mark-all-watched: reload confirms movie removed - ' + JSON.stringify(before.name) + ' gone.');
    } else {
      console.error('[proof] mark-all-watched: reload shows MOVIE NOT removed - ' + JSON.stringify(before.name) + ' still in rail.');
    }
  }

  // Step 4 (partial): prefer the dedicated partial-card movie we seeded with
  // exactly ONE viewer watched. It must STILL be on the rail (not everyone has
  // watched) and show a LIT pill next to UNLIT pills. We do NOT click any pill
  // here - the lit/unlit split came from the seed, so the screenshot is the
  // direct evidence.
  cur = await snapshotRail(page);
  let partialIdx = -1;
  if (partialSeed?.name) {
    partialIdx = cur.findIndex((c) => c.name === partialSeed.name && c.pillCount >= 2);
  }
  let needPillClick = false;
  if (partialIdx === -1) {
    // Fallback: no seeded partial card on the rail; light one pill on any
    // multi-viewer card so we still capture a subset state.
    partialIdx = cur.findIndex((c) => c.pillCount >= 2);
    needPillClick = true;
  }

  if (partialIdx === -1) {
    console.warn('[proof] mark-all-watched: no card with >=2 viewer pills for partial check; skipping step 4.');
  } else {
    const card = cards(page).nth(partialIdx);
    if (needPillClick) {
      const first = card.locator('.viewer-pill').first();
      const firstCls = (await first.getAttribute('class')) ?? '';
      if (!firstCls.includes('watched')) {
        await first.scrollIntoViewIfNeeded();
        await first.click();
        for (let t = 0; t < 40; t += 1) {
          const c = (await first.getAttribute('class').catch(() => '')) ?? '';
          if (c.includes('watched')) break;
          await page.waitForTimeout(200);
        }
      }
      await page.waitForTimeout(600);
    }
    const partial = await readCard(card);
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await card.locator('.play-row').first().screenshot({ path: ctx.outDir + '/' + flowName + '-04-partial-pills.png' });
    console.log('[proof] screenshot: ' + ctx.outDir + '/' + flowName + '-04-partial-pills.png');
    await shoot(page, flowName + '-04-partial-full');
    console.log('[proof] mark-all-watched: partial card ' + JSON.stringify(partial.name) + ' pills=' + partial.pillCount + ' watched=' + partial.watchedPills + (needPillClick ? ' (fallback: clicked one pill)' : ' (seeded one-viewer-watched)'));
    // Require some-but-not-all watched: a LIT pill alongside UNLIT pills, on a
    // card that stayed on the rail.
    if (partial.watchedPills >= 1 && partial.watchedPills < partial.pillCount) {
      console.log('[proof] mark-all-watched: PASS partial - card stays on the rail with ' + partial.watchedPills + '/' + partial.pillCount + ' pills LIT (subset watched).');
    } else {
      console.error('[proof] mark-all-watched: partial FAILED - need 1<=watched<' + partial.pillCount + ' for a lit/unlit split, got watched=' + partial.watchedPills + '.');
    }
  }

  // Step 5 (interactive mid-transition): the seeded SHOW starts with a SUBSET of
  // the N household viewers watched. CLICK the remaining unwatched pills ONE AT A
  // TIME: each click before the last keeps the SAME episode (k/N -> k+1/N, not
  // advanced); the click that completes N/N ADVANCES the card. Counts derive from
  // the ACTUAL pill count on the anchored card (household size), not a hardcoded
  // 3, and the start state is read from the real anchored episode.
  if (!interactiveSeed?.seriesName) {
    console.warn('[proof] mark-all-watched: no interactive-show seed; skipping step 5.');
  } else {
    const seriesName = interactiveSeed.seriesName;
    cur = await snapshotRail(page);
    const findIdx = (snap) => snap.findIndex((c) => isShowMeta(c.meta) && seriesOf(c.meta) === seriesName);
    let idx = findIdx(cur);
    if (idx === -1) {
      console.error('[proof] mark-all-watched: step 5 - seeded interactive show ' + JSON.stringify(seriesName) + ' not on the rail; cannot prove mid-transition.');
    } else {
      const before = cur[idx];
      const N = before.pillCount; // household size on the actual anchored card
      let card = cards(page).nth(idx);
      await card.scrollIntoViewIfNeeded();
      await card.locator('.play-row').first().screenshot({ path: ctx.outDir + '/' + flowName + '-05a-start-before.png' });
      console.log('[proof] mark-all-watched: step 5 START name=' + JSON.stringify(before.name) + ' meta=' + JSON.stringify(before.meta) + ' watched=' + before.watchedPills + '/' + N + ' (anchored episode; seed pre-watched ' + (interactiveSeed.watchedUserIds?.length ?? 0) + ')');
      console.log('[proof] screenshot: ' + ctx.outDir + '/' + flowName + '-05a-start-before.png');
      // The fixture should start partially watched (>=1 lit) but NOT all-watched
      // (so there are clicks left to reach N/N). If it desynced to 0 lit, that is
      // still a valid mid-transition start (we just have N clicks instead of N-1).
      if (before.watchedPills >= N) {
        console.error('[proof] mark-all-watched: step 5 - card already all-watched at start (' + before.watchedPills + '/' + N + '); cannot show mid-transition.');
      } else {
        if (before.watchedPills < 1) {
          console.warn('[proof] mark-all-watched: step 5 - expected a pre-watched pill at start, got 0/' + N + ' (anchor likely differs from the seeded episode); proceeding with full N clicks.');
        }

        // Click unwatched pills one at a time, asserting the card stays put until
        // the final click. Re-resolve the card by series each iteration.
        let stayedSame = true;
        let advancedMeta = null;
        let removed = false;
        const clicksToAll = N - before.watchedPills; // remaining unwatched pills
        for (let k = 1; k <= clicksToAll; k += 1) {
          idx = await findCardIndex(page, (c) => c.name === before.name && c.meta === before.meta);
          if (idx === -1) {
            // Card left this episode before the final click -> advanced early.
            const ai = await findCardIndex(page, (c) => isShowMeta(c.meta) && c.meta !== before.meta && seriesOf(c.meta) === seriesName);
            advancedMeta = ai === -1 ? null : (await snapshotRail(page))[ai]?.meta;
            removed = ai === -1;
            stayedSame = false;
            break;
          }
          card = cards(page).nth(idx);
          await clickFirstUnwatchedPill(page, card, 'mark-all-watched step5 click ' + k, fail);

          const isFinalClick = k === clicksToAll;
          cur = await snapshotRail(page);
          const sameIdx = cur.findIndex((c) => c.name === before.name && c.meta === before.meta);
          if (!isFinalClick) {
            // Should STILL be the same episode, with one more pill lit.
            if (sameIdx === -1) {
              console.error('[proof] mark-all-watched: step 5 FAILED at click ' + k + '/' + clicksToAll + ' - card left episode ' + JSON.stringify(before.meta) + ' BEFORE all-watched.');
              stayedSame = false;
              break;
            }
            const now = cur[sameIdx];
            console.log('[proof] mark-all-watched: step 5 click ' + k + ' -> STAYS ' + JSON.stringify(now.meta) + ' ' + now.watchedPills + '/' + now.pillCount + ' lit.');
            if (k === 1) {
              const c2 = cards(page).nth(sameIdx);
              await c2.scrollIntoViewIfNeeded();
              await c2.locator('.play-row').first().screenshot({ path: ctx.outDir + '/' + flowName + '-05b-midway-stays.png' });
              console.log('[proof] screenshot: ' + ctx.outDir + '/' + flowName + '-05b-midway-stays.png');
            }
          } else {
            // Final click: card should ADVANCE (or be removed if last episode).
            const after = await waitForRailChange(page, before);
            const ai = after.findIndex((c) => isShowMeta(c.meta) && c.meta !== before.meta && seriesOf(c.meta) === seriesName);
            advancedMeta = ai === -1 ? null : after[ai].meta;
            removed = !after.find((c) => c.name === before.name && c.meta === before.meta) && ai === -1;
            stayedSame = Boolean(after.find((c) => c.name === before.name && c.meta === before.meta));
            if (ai !== -1) {
              const advCard = cards(page).nth(ai);
              await advCard.scrollIntoViewIfNeeded();
              await advCard.locator('.play-row').first().screenshot({ path: ctx.outDir + '/' + flowName + '-05c-allwatched-advanced.png' });
              console.log('[proof] screenshot: ' + ctx.outDir + '/' + flowName + '-05c-allwatched-advanced.png');
            }
          }
        }
        await shoot(page, flowName + '-05d-final-full');

        if (advancedMeta) {
          console.log('[proof] mark-all-watched: PASS step 5 - stayed put through partial clicks, then ' + N + '/' + N + ' watched ADVANCED ' + JSON.stringify(before.meta) + ' -> ' + JSON.stringify(advancedMeta) + '.');
        } else if (removed) {
          console.log('[proof] mark-all-watched: PASS step 5 - ' + N + '/' + N + ' watched removed the card (last episode); gate fired after staying put on partials.');
        } else if (stayedSame) {
          console.error('[proof] mark-all-watched: step 5 FAILED - card did NOT advance/remove after all ' + N + ' viewers watched (still ' + JSON.stringify(before.meta) + ').');
        } else {
          console.error('[proof] mark-all-watched: step 5 FAILED - card advanced/left BEFORE all viewers watched (premature).');
        }
      }
    }
  }

  // Step 6 (fan-out, not a single stable anchor): the staggered fixture puts 3
  // viewers on DIFFERENT episodes of one series. Continue-watching no longer
  // collapses this to one anchored card — every distinct episode candidate
  // gets its OWN rail card (see show-cross-episode.mjs for the dedicated
  // fan-out + scoped-ignore proof). Here we just confirm toggling a pill on ONE
  // of those episode-cards only ever affects that card (never jumps to a
  // different episode's card, and never bleeds into the other episode-cards
  // for the same series).
  if (!staggeredSeed?.seriesName) {
    console.warn('[proof] mark-all-watched: no staggered-show seed; skipping step 6.');
  } else {
    const seriesName = staggeredSeed.seriesName;
    const findAll = (snap) => snap.filter((c) => isShowMeta(c.meta) && seriesOf(c.meta) === seriesName);
    cur = await snapshotRail(page);
    const seriesCardsBefore = findAll(cur);
    if (seriesCardsBefore.length === 0) {
      console.error('[proof] mark-all-watched: step 6 - staggered show ' + JSON.stringify(seriesName) + ' not on the rail.');
    } else {
      console.log(
        '[proof] mark-all-watched: step 6 fan-out cards for ' + JSON.stringify(seriesName) + ' = ' +
        JSON.stringify(seriesCardsBefore.map((c) => c.meta)),
      );
      const start = seriesCardsBefore[0];
      const idx = cur.findIndex((c) => c.name === start.name && c.meta === start.meta);
      let card = cards(page).nth(idx);
      await card.scrollIntoViewIfNeeded();
      await card.locator('.play-row').first().screenshot({ path: ctx.outDir + '/' + flowName + '-06a-fanout-card.png' });
      console.log('[proof] screenshot: ' + ctx.outDir + '/' + flowName + '-06a-fanout-card.png');

      // Toggle any pill (on/off) on this ONE episode-card, asserting the OTHER
      // fan-out cards for the same series are unaffected (still present,
      // unchanged meta) — proving a pill toggle never bleeds across cards.
      const otherMetasBefore = seriesCardsBefore.filter((c) => c.meta !== start.meta).map((c) => c.meta);
      const pills = card.locator('.viewer-pill');
      const total = await pills.count();
      if (total === 0) {
        console.warn('[proof] mark-all-watched: step 6 - fan-out card has no viewer pills; skipping toggle check.');
      } else {
        for (const phase of ['toggle', 'revert']) {
          const pill = card.locator('.viewer-pill').first();
          await pill.scrollIntoViewIfNeeded().catch(() => {});
          await pill.click();
          await page.waitForTimeout(800);
          await page.waitForLoadState('networkidle').catch(() => {});
          cur = await snapshotRail(page);
          const seriesCardsAfter = findAll(cur);
          const otherMetasAfter = seriesCardsAfter.filter((c) => c.meta !== start.meta).map((c) => c.meta);
          const stillHasOthers = otherMetasBefore.every((m) => otherMetasAfter.includes(m));
          if (stillHasOthers) {
            console.log('[proof] mark-all-watched: PASS fan-out (' + phase + ') - other episode-card(s) for ' + JSON.stringify(seriesName) + ' unaffected: ' + JSON.stringify(otherMetasAfter));
          } else {
            console.error('[proof] mark-all-watched: step 6 FAILED (' + phase + ') - other episode-card(s) changed/disappeared. before=' + JSON.stringify(otherMetasBefore) + ' after=' + JSON.stringify(otherMetasAfter));
          }
          const reIdx = cur.findIndex((c) => c.name === start.name && c.meta === start.meta);
          card = reIdx === -1 ? card : cards(page).nth(reIdx);
        }
      }
      await shoot(page, flowName + '-06b-fanout-after-toggle');
    }
  }

  console.log('[proof] mark-all-watched: flow complete');
}
