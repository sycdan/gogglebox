// Seed a self-contained "in-progress mid-series episode" fixture so the
// mark-all-watched proof can demonstrate the SHOW card advancing to the NEXT
// episode without depending on whatever the test Jellyfin happens to contain.
//
// Strategy (per active viewer / Jellyfin user, mirroring the server's own
// played-state + resume model in src/server/jellyfin.ts):
//   - Pick a series with at least 3 REGULAR-SEASON episodes. Season 0 specials
//     are skipped: their continue-watching card renders with no SxxExx token, so
//     the flow's SHOW detector (/S\d{2}E\d{2}/) would miss it and fall into a
//     DATA GAP. Both the target AND its next episode must be regular-season so
//     the live card and the advanced card both show SxxExx.
//   - Mark every regular-season episode BEFORE the target as Played, so Jellyfin
//     treats the series as progressing up to the target and NextUp lands on it.
//   - Set a PARTIAL PlaybackPositionTicks on the target (Played:false) so it
//     surfaces on /Users/<id>/Items/Resume -> the app's SHOW continue-watching
//     card with viewer pills.
//   - Mark the target and everything after it UNplayed, so the fixture is
//     idempotent across re-runs (a prior run that marked the target played
//     during the proof gets reset here).
//
// After the proof marks every viewer watched on the target, Jellyfin's NextUp
// advances to target+1, and the app's resolveWatchedCards surfaces that next
// episode -> the card "advances" (same series, next SxxExx, progress reset).

import { makeJellyfin, TICKS_PER_MINUTE } from './jellyfin.mjs';
import { householdUsers } from './household.mjs';
import { resolveJellyfinBase } from '../../tools/sandbox/baseUrl.mjs';

// Build a seed client bound to the normalized sandbox Jellyfin base. Sandbox
// volumes are disposable, so this expects the bare-origin shape provision emits.
async function connect({ url, apiKey }, log = console.log) {
  const base = await resolveJellyfinBase(url, { token: apiKey });
  if (base !== (url ?? '').trim().replace(/\/$/, '')) {
    log(`[seed] jellyfin base resolved to ${base} (from ${url})`);
  }
  return makeJellyfin(base, apiKey);
}

const sxxexx = (e) =>
  `S${String(e.seasonNumber ?? 0).padStart(2, '0')}E${String(e.episodeNumber ?? 0).padStart(2, '0')}`;

// Regular-season episodes only (skip Season 0 / specials), in proper season then
// episode order so "mid-series" and "next" are deterministic regardless of how
// Jellyfin interleaved specials by air date.
function regularSeasonEpisodes(episodes) {
  return episodes
    .filter((e) => typeof e.seasonNumber === 'number' && e.seasonNumber >= 1)
    .filter((e) => typeof e.episodeNumber === 'number')
    .slice()
    .sort((a, b) => (a.seasonNumber - b.seasonNumber) || (a.episodeNumber - b.episodeNumber));
}

// Choose a target index into the regular-season list that is NOT the last (so a
// next episode exists) and ideally not the first (so it reads as genuinely
// "mid-series"). Prefer the second episode when there are >= 3, else the first
// of >= 2. Both target and target+1 are guaranteed regular-season.
function pickTargetIndex(regulars) {
  if (regulars.length >= 3) return 1; // 0-based: the 2nd regular-season episode
  if (regulars.length >= 2) return 0;
  return -1;
}

// Find a series (skipping any in `excludeSeriesIds`) whose regular-season
// episodes yield a usable mid-series target. Prefer the SMALLEST qualifying
// series so the show-advance and interactive fixtures consume short series and
// leave the longest one free for the staggered fixture (which needs the most
// episodes: >= household-size + 2).
async function findSeedableSeries(jf, log, excludeSeriesIds = new Set()) {
  const series = await jf.listSeries(40);
  const candidates = [];
  for (const s of series) {
    if (excludeSeriesIds.has(s.id)) continue;
    const allEpisodes = await jf.listEpisodes(s.id);
    const regulars = regularSeasonEpisodes(allEpisodes);
    const idx = pickTargetIndex(regulars);
    if (idx >= 0 && regulars[idx].runtimeTicks > 0) {
      candidates.push({ series: s, allEpisodes, regulars, idx });
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => a.regulars.length - b.regulars.length);
  const chosen = candidates[0];
  log(`[proof][seed] series "${chosen.series.name}" has ${chosen.regulars.length} regular-season episode(s); target ${sxxexx(chosen.regulars[chosen.idx])}, next ${sxxexx(chosen.regulars[chosen.idx + 1])}`);
  return chosen;
}

// Seed one series as an in-progress mid-series SHOW card. Shared core for both
// the show-advance fixture (no viewers pre-watched) and the interactive
// two-thirds fixture (a subset of viewers pre-watched).
//   users              all Jellyfin users (the card surfaces from any in-progress one)
//   watchedUserIds     users to mark the TARGET episode played for (lit pills)
//   excludeSeriesIds   series to skip so fixtures don't collide
// Returns details of the seeded episode + expected next, or null on DATA GAP.
async function seedSeriesFixture(jf, { users, watchedUserIds = [], excludeSeriesIds = new Set(), label }, log) {
  const found = await findSeedableSeries(jf, log, excludeSeriesIds);
  if (!found) {
    log(`[proof][seed] ${label}: DATA GAP - no spare series with >=2 regular-season episodes; cannot seed.`);
    return null;
  }

  const { series, allEpisodes, regulars, idx } = found;
  const target = regulars[idx];
  const next = regulars[idx + 1] ?? null; // guaranteed regular-season by pickTargetIndex
  // ~40% through the episode (or 5 min if runtime unknown) -> clearly in-progress.
  const partialTicks = target.runtimeTicks > 0
    ? Math.floor(target.runtimeTicks * 0.4)
    : 5 * TICKS_PER_MINUTE;
  const watchedSet = new Set(watchedUserIds);

  for (const user of users) {
    // Reset the WHOLE series (including specials) for this user so re-runs are
    // idempotent and no stale special/episode progress lingers on the rail.
    for (const ep of allEpisodes) {
      await jf.markUnplayed(user.id, ep.id);
    }
    // Mark ALL specials (Season 0) played so they never sit in NextUp between
    // the target and its next regular-season episode -> the advance lands on the
    // regular-season "next" we reported, and the advanced card shows SxxExx.
    for (const ep of allEpisodes) {
      if (typeof ep.seasonNumber === 'number' && ep.seasonNumber === 0) {
        await jf.markPlayed(user.id, ep.id);
      }
    }
    // Mark every regular-season episode before the target as played.
    for (let i = 0; i < idx; i += 1) {
      await jf.markPlayed(user.id, regulars[i].id);
    }
    if (watchedSet.has(user.id)) {
      // This viewer has ALREADY watched the target -> lit pill. Keep an
      // in-progress position so the (in-app) series still resolves to this
      // episode for the unwatched viewers; the played state lights the pill.
      await jf.setPlaybackPosition(user.id, target.id, partialTicks);
      await jf.markPlayed(user.id, target.id);
    } else {
      // Target = partial in-progress (unwatched, unlit pill).
      await jf.setPlaybackPosition(user.id, target.id, partialTicks);
    }
  }

  log(
    `[proof][seed] ${label}: "${target.seriesName}" ${sxxexx(target)} in-progress for ${users.length} user(s), ` +
    `pre-watched by ${watchedSet.size}; expected next = ${next ? sxxexx(next) : '(none)'}`,
  );

  return {
    seriesName: target.seriesName,
    seriesId: series.id,
    target: { name: target.name, code: sxxexx(target), id: target.id },
    next: next ? { name: next.name, code: sxxexx(next), id: next.id } : null,
    userIds: users.map((u) => u.id),
    watchedUserIds: [...watchedSet],
  };
}

// Seed the show-advance fixture: a mid-series episode in-progress for every user,
// NONE pre-watched. Returns the seeded episode details (incl. expected next).
export async function seedInProgressEpisode({ url, apiKey }, log = console.log) {
  const jf = await connect({ url, apiKey }, log);

  const users = await householdUsers(jf, {}, log);
  if (users.length === 0) throw new Error('[seed] no household viewers resolved');

  return seedSeriesFixture(jf, { users, label: 'show-advance' }, log);
}

// Seed a STAGGERED show fixture: the real-world bug scenario where the 3 active
// viewers are each on a DIFFERENT episode of the same series. The party card must
// anchor to the EARLIEST of those episodes and NOT jump when a viewer who is
// AHEAD of the anchor toggles their watched state. Each viewer i is placed on
// regulars[base + i] (earlier viewers behind, later viewers ahead); everything
// before a viewer's episode is marked played, their episode is in-progress.
// Returns the per-viewer episode codes plus the expected anchor (earliest).
export async function seedStaggeredShow({ url, apiKey }, { excludeSeriesIds = [] } = {}, log = console.log) {
  const jf = await connect({ url, apiKey }, log);

  const users = await householdUsers(jf, {}, log);
  if (users.length < 3) {
    log(`[proof][seed] staggered-show: need >=3 household viewers; have ${users.length}. Skipping.`);
    return null;
  }

  const exclude = new Set(excludeSeriesIds);
  const series = await jf.listSeries(40);
  let chosen = null;
  for (const s of series) {
    if (exclude.has(s.id)) continue;
    const allEpisodes = await jf.listEpisodes(s.id);
    const regulars = regularSeasonEpisodes(allEpisodes);
    // Need room for 3 staggered viewers AND a next episode beyond the last one.
    if (regulars.length >= users.length + 2 && regulars.every((e) => e.runtimeTicks >= 0)) {
      chosen = { series: s, allEpisodes, regulars };
      break;
    }
  }
  if (!chosen) {
    log('[proof][seed] staggered-show: DATA GAP - no spare series with enough regular-season episodes.');
    return null;
  }

  const { allEpisodes, regulars } = chosen;
  // Place viewers at episodes [1, 2, 3, ...] (0-based) so the anchor (index 1) is
  // mid-series with a real previous and next, and viewers 2..n are AHEAD of it.
  const base = 1;
  const perViewer = [];

  for (let v = 0; v < users.length; v += 1) {
    const user = users[v];
    const pos = base + v;
    const ep = regulars[pos];
    // Reset whole series for idempotency.
    for (const e of allEpisodes) await jf.markUnplayed(user.id, e.id);
    // Specials played so they don't pollute NextUp.
    for (const e of allEpisodes) {
      if (typeof e.seasonNumber === 'number' && e.seasonNumber === 0) await jf.markPlayed(user.id, e.id);
    }
    // Everything before this viewer's episode = played.
    for (let i = 0; i < pos; i += 1) await jf.markPlayed(user.id, regulars[i].id);
    // This viewer's episode = in-progress (~40%).
    const ticks = ep.runtimeTicks > 0 ? Math.floor(ep.runtimeTicks * 0.4) : 5 * TICKS_PER_MINUTE;
    await jf.setPlaybackPosition(user.id, ep.id, ticks);
    perViewer.push({ userId: user.id, userName: user.name, code: sxxexx(ep), id: ep.id });
  }

  const anchor = regulars[base]; // earliest staggered episode
  const anchorNext = regulars[base + 1];
  log(
    `[proof][seed] staggered-show: "${anchor.seriesName}" viewers at ` +
    perViewer.map((p) => `${p.userName}:${p.code}`).join(', ') +
    ` -> expected ANCHOR ${sxxexx(anchor)} (earliest), ahead viewers must NOT move it.`,
  );

  return {
    seriesName: anchor.seriesName,
    seriesId: chosen.series.id,
    anchor: { code: sxxexx(anchor), id: anchor.id },
    anchorNext: { code: sxxexx(anchorNext), id: anchorNext.id },
    perViewer,
    userIds: users.map((u) => u.id),
  };
}

// Seed the INTERACTIVE two-thirds fixture: a mid-series SHOW seeded as watched
// for exactly ONE active viewer (1/N lit), distinct from the show-advance series
// (pass its seriesId in `excludeSeriesIds`). The flow then clicks the remaining
// pills one at a time to prove the refetch path stays at 2/3 then advances at 3/3.
export async function seedInteractiveShow({ url, apiKey }, { excludeSeriesIds = [] } = {}, log = console.log) {
  const jf = await connect({ url, apiKey }, log);

  const users = await householdUsers(jf, {}, log);
  if (users.length < 3) {
    log(`[proof][seed] interactive-show: need >=3 household viewers for a 1/3 -> 2/3 -> 3/3 proof; have ${users.length}. Skipping.`);
    return null;
  }

  return seedSeriesFixture(
    jf,
    {
      users,
      watchedUserIds: [users[0].id],
      excludeSeriesIds: new Set(excludeSeriesIds),
      label: 'interactive-show',
    },
    log,
  );
}

// Seed a dedicated PARTIAL card: an in-progress movie where exactly ONE viewer
// is marked watched and the rest are left unwatched. Because not everyone has
// watched it, the card MUST stay on the rail with a SUBSET of pills lit -> the
// proof can screenshot one LIT (green-check) pill next to UNLIT pills.
//
// Mechanism (reuses the same helper as the app server):
//   - Pick a movie distinct from `excludeMovieIds` (so it doesn't collide with
//     the MOVIE-removal target) that has a runtime.
//   - Reset that movie's played state for ALL users (idempotent re-runs).
//   - Set a PARTIAL PlaybackPositionTicks for all users so it surfaces on Resume
//     for the still-unwatched viewers (the card stays on the rail).
//   - markPlayed for exactly ONE user -> that viewer's pill lights; the others
//     stay unlit and keep the card present.
export async function seedPartialCard({ url, apiKey }, { excludeMovieIds = [] } = {}, log = console.log) {
  const jf = await connect({ url, apiKey }, log);

  const users = await householdUsers(jf, {}, log);
  if (users.length < 2) {
    log(`[proof][seed] partial: need >=2 household viewers for a partial pill state; have ${users.length}. Skipping.`);
    return null;
  }

  const exclude = new Set(excludeMovieIds);
  const movies = await jf.listMovies(40);
  const movie = movies.find((m) => m.runtimeTicks > 0 && !exclude.has(m.id));
  if (!movie) {
    log('[proof][seed] partial: DATA GAP - no spare movie with runtime to seed a partial card.');
    return null;
  }

  const partialTicks = Math.floor(movie.runtimeTicks * 0.4);
  const watchedUser = users[0];

  for (const user of users) {
    // Reset so re-runs start clean (no lingering played/position state).
    await jf.markUnplayed(user.id, movie.id);
    // Everyone gets in-progress so the card surfaces for the unwatched viewers.
    await jf.setPlaybackPosition(user.id, movie.id, partialTicks);
  }
  // Exactly ONE viewer watched -> one lit pill, rest unlit, card stays.
  await jf.markPlayed(watchedUser.id, movie.id);

  log(
    `[proof][seed] partial: "${movie.name}" seeded in-progress for ${users.length} user(s); ` +
    `marked watched for 1 user (${watchedUser.name}) -> expect 1 lit pill of ${users.length}.`,
  );

  return {
    name: movie.name,
    id: movie.id,
    watchedUserId: watchedUser.id,
    userCount: users.length,
  };
}

// Seed a dedicated REMOVABLE movie card: an in-progress movie for every household
// viewer with NONE pre-watched. The movie-removal step marks every viewer watched
// and asserts the card drops from the rail. Distinct from the partial-card movie
// (pass its id in excludeMovieIds) so the two movie fixtures don't collide - this
// guarantees a second in-progress movie exists even on a small library.
export async function seedRemovableMovie({ url, apiKey }, { excludeMovieIds = [] } = {}, log = console.log) {
  const jf = await connect({ url, apiKey }, log);

  const users = await householdUsers(jf, {}, log);
  if (users.length === 0) {
    log('[proof][seed] removable-movie: no household viewers; skipping.');
    return null;
  }

  const exclude = new Set(excludeMovieIds);
  const movies = await jf.listMovies(40);
  const movie = movies.find((m) => m.runtimeTicks > 0 && !exclude.has(m.id));
  if (!movie) {
    log('[proof][seed] removable-movie: DATA GAP - no spare movie with runtime (distinct from the partial seed).');
    return null;
  }

  const partialTicks = Math.floor(movie.runtimeTicks * 0.4);
  for (const user of users) {
    await jf.markUnplayed(user.id, movie.id);       // idempotent reset
    await jf.setPlaybackPosition(user.id, movie.id, partialTicks); // in-progress, 0 watched
  }

  log(
    `[proof][seed] removable-movie: "${movie.name}" seeded in-progress for ${users.length} user(s), ` +
    `0 pre-watched -> mark all watched to prove removal.`,
  );

  return { name: movie.name, id: movie.id, userCount: users.length };
}

// Seed a MULTI-VIEWER, STAGGERED-POSITION movie: the same movie left in-progress
// for >=3 household viewers at CLEARLY different positions (e.g. ~10% / ~45% /
// ~80%), NONE watched. This exercises the "movies resume least-watched first"
// rule (src/server/continueWatching.ts mergeContinueWatching -> preferLeastAdvanced):
// the single party movie card must resume from the LEAST-advanced viewer (lowest
// progressPercent), so the card's badge/progress bar reflects the LOWEST %, and
// sourceViewer is that least-watched viewer — NOT the most-watched.
//
//   - Pick a movie (distinct from excludeMovieIds) with a real runtime.
//   - Reset that movie's played-state for ALL users (idempotent re-runs).
//   - Assign each household viewer a distinct fraction across a low..high spread
//     and setPlaybackPosition accordingly. All stay unwatched so the card stays.
// Returns the per-viewer fractions + the expected (lowest) resume fraction.
export async function seedMultiViewerMovie({ url, apiKey }, { excludeMovieIds = [] } = {}, log = console.log) {
  const jf = await connect({ url, apiKey }, log);

  const users = await householdUsers(jf, {}, log);
  if (users.length < 2) {
    log(`[proof][seed] multi-viewer-movie: need >=2 household viewers; have ${users.length}. Skipping.`);
    return null;
  }

  const exclude = new Set(excludeMovieIds);
  const movies = await jf.listMovies(40);
  const movie = movies.find((m) => m.runtimeTicks > 0 && !exclude.has(m.id));
  if (!movie) {
    log('[proof][seed] multi-viewer-movie: DATA GAP - no spare movie with runtime to seed.');
    return null;
  }

  // Distinct fractions across a clear low..high spread: 10% .. 80% evenly split
  // over however many viewers we have, so positions are unambiguous on screen.
  const LOW = 0.1;
  const HIGH = 0.8;
  const n = users.length;
  const fractions = users.map((_, i) => (n === 1 ? LOW : LOW + (HIGH - LOW) * (i / (n - 1))));

  // Reset everyone first so re-runs start clean (no lingering played/position).
  for (const user of users) {
    await jf.markUnplayed(user.id, movie.id);
  }

  const perViewer = [];
  for (let i = 0; i < users.length; i += 1) {
    const user = users[i];
    const frac = fractions[i];
    const ticks = Math.floor(movie.runtimeTicks * frac);
    await jf.setPlaybackPosition(user.id, movie.id, ticks);
    perViewer.push({ userId: user.id, userName: user.name, fraction: frac, percent: Math.round(frac * 100), ticks });
  }

  // The least-advanced (lowest fraction) viewer = the expected resume point.
  const least = perViewer.reduce((lo, p) => (p.fraction < lo.fraction ? p : lo), perViewer[0]);
  const most = perViewer.reduce((hi, p) => (p.fraction > hi.fraction ? p : hi), perViewer[0]);

  log(
    `[proof][seed] multi-viewer-movie: "${movie.name}" in-progress for ${users.length} viewer(s) at ` +
    perViewer.map((p) => `${p.userName}:${p.percent}%`).join(', ') +
    ` -> EXPECT card resumes from LEAST-watched ${least.userName} (${least.percent}%), NOT most-watched ${most.userName} (${most.percent}%).`,
  );

  return {
    name: movie.name,
    id: movie.id,
    userCount: users.length,
    perViewer,
    leastWatched: { userName: least.userName, percent: least.percent, fraction: least.fraction },
    mostWatched: { userName: most.userName, percent: most.percent, fraction: most.fraction },
  };
}

// Seed the CROSS-EPISODE + PARTIAL-PROGRESS show case: one series, the active
// party's viewers on DIFFERENT episodes each with mid-episode partial progress.
// This proves SHOWS differ from movies: the party SHOW card anchors on EPISODE
// ORDER FIRST (the earliest not-all-watched episode), then resumes from the
// least-advanced viewer AT that anchor — i.e. "don't spoil the furthest-behind".
//
// Layout (needs >=3 regular-season episodes + >=3 household viewers):
//   viewer[0] (e.g. Alice): finished E2, ~10% into E3  -> candidate E3 @10%
//   viewer[1] (e.g. Bob):   ~20% into E2 (E1 finished) -> candidate E2 @20%
//   viewer[2] (e.g. Carol): ~2% into E1 (unfinished)   -> candidate E1 @2%
// Expected: anchor = E1 (Carol hasn't finished it), resume ~2% (Carol), NOT E3.
//
// Each viewer: reset whole series, specials played, mark earlier regular eps
// played up to their episode, set their episode in-progress at the given fraction.
export async function seedCrossEpisodeShow({ url, apiKey }, { excludeSeriesIds = [] } = {}, log = console.log) {
  const jf = await connect({ url, apiKey }, log);

  const users = await householdUsers(jf, {}, log);
  if (users.length < 3) {
    log(`[proof][seed] cross-episode-show: need >=3 household viewers; have ${users.length}. Skipping.`);
    return null;
  }

  const exclude = new Set(excludeSeriesIds);
  const series = await jf.listSeries(40);
  let chosen = null;
  for (const s of series) {
    if (exclude.has(s.id)) continue;
    const allEpisodes = await jf.listEpisodes(s.id);
    const regulars = regularSeasonEpisodes(allEpisodes);
    if (regulars.length >= 3 && regulars.slice(0, 3).every((e) => e.runtimeTicks > 0)) {
      chosen = { series: s, allEpisodes, regulars };
      break;
    }
  }
  if (!chosen) {
    log('[proof][seed] cross-episode-show: DATA GAP - no spare series with >=3 regular-season episodes (with runtime).');
    return null;
  }

  const { allEpisodes, regulars } = chosen;
  const e1 = regulars[0];
  const e2 = regulars[1];
  const e3 = regulars[2];

  // Per-viewer plan: episode index into `regulars` + the partial fraction.
  // viewer 0 -> E3 @10%, viewer 1 -> E2 @20%, viewer 2 -> E1 @2%.
  const plan = [
    { epIdx: 2, frac: 0.10 },
    { epIdx: 1, frac: 0.20 },
    { epIdx: 0, frac: 0.02 },
  ];

  const perViewer = [];
  for (let v = 0; v < users.length; v += 1) {
    const user = users[v];
    // Viewers beyond the planned 3 just sit fully behind on E1 @2% so they never
    // pull the anchor earlier than E1 (there is nothing earlier) and never ahead.
    const p = plan[v] ?? { epIdx: 0, frac: 0.02 };
    const ep = regulars[p.epIdx];

    // Reset whole series for idempotency.
    for (const e of allEpisodes) await jf.markUnplayed(user.id, e.id);
    // Specials played so they don't pollute NextUp/resume order.
    for (const e of allEpisodes) {
      if (typeof e.seasonNumber === 'number' && e.seasonNumber === 0) await jf.markPlayed(user.id, e.id);
    }
    // Every regular episode BEFORE this viewer's current one = finished.
    for (let i = 0; i < p.epIdx; i += 1) await jf.markPlayed(user.id, regulars[i].id);
    // This viewer's current episode = in-progress at the planned fraction.
    const ticks = Math.max(1, Math.floor(ep.runtimeTicks * p.frac));
    await jf.setPlaybackPosition(user.id, ep.id, ticks);

    perViewer.push({
      userId: user.id, userName: user.name,
      code: sxxexx(ep), epIdx: p.epIdx, percent: Math.round(p.frac * 100), id: ep.id,
    });
  }

  // Anchor = the earliest episode any viewer has NOT finished. By construction the
  // furthest-behind viewer (viewer index 2, or any extra viewers) is in-progress on
  // E1, so the anchor is E1. The least-advanced viewer AT the anchor is whoever is
  // in-progress on E1 with the lowest fraction.
  const anchorEp = e1;
  const atAnchor = perViewer.filter((p) => p.epIdx === 0);
  const leastAtAnchor = atAnchor.reduce((lo, p) => (p.percent < lo.percent ? p : lo), atAnchor[0]);

  log(
    `[proof][seed] cross-episode-show: "${anchorEp.seriesName}" viewers at ` +
    perViewer.map((p) => `${p.userName}:${p.code}@${p.percent}%`).join(', ') +
    ` -> EXPECT anchor ${sxxexx(anchorEp)} (earliest not-all-watched), resume ~${leastAtAnchor.percent}% ` +
    `(least-advanced ${leastAtAnchor.userName} on ${sxxexx(anchorEp)}), NOT the furthest-ahead viewer's episode.`,
  );

  return {
    seriesName: anchorEp.seriesName,
    seriesId: chosen.series.id,
    anchor: { code: sxxexx(anchorEp), id: anchorEp.id, percent: leastAtAnchor.percent, viewerName: leastAtAnchor.userName },
    episodes: { e1: sxxexx(e1), e2: sxxexx(e2), e3: sxxexx(e3) },
    perViewer,
    userIds: users.map((u) => u.id),
  };
}
