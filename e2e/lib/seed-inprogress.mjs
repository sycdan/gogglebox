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
  const jf = makeJellyfin(url, apiKey);

  const users = await householdUsers(jf, {}, log);
  if (users.length === 0) throw new Error('[seed] no household viewers resolved');

  return seedSeriesFixture(jf, { users, label: 'show-advance' }, log);
}

// Seed a STAGGERED show fixture: the real-world bug scenario where the 3 active
// viewers are each on a DIFFERENT episode of the same series. The group card must
// anchor to the EARLIEST of those episodes and NOT jump when a viewer who is
// AHEAD of the anchor toggles their watched state. Each viewer i is placed on
// regulars[base + i] (earlier viewers behind, later viewers ahead); everything
// before a viewer's episode is marked played, their episode is in-progress.
// Returns the per-viewer episode codes plus the expected anchor (earliest).
export async function seedStaggeredShow({ url, apiKey }, { excludeSeriesIds = [] } = {}, log = console.log) {
  const jf = makeJellyfin(url, apiKey);

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
  const jf = makeJellyfin(url, apiKey);

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
  const jf = makeJellyfin(url, apiKey);

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
  const jf = makeJellyfin(url, apiKey);

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
