// Single source of truth for the deterministic sandbox Jellyfin library.
//
// This spec is consumed by THREE scripts so they never drift:
//   - generate-fixtures.mjs : writes tiny .webm stubs (VP9+Opus, DirectPlay) + .nfo sidecars to disk
//   - provision.mjs         : creates users, adds the library, waits for scan
//   - reset.mjs             : clears every user's played-state between flows
//
// Design goals:
//   - Tiny + offline: each video is a short 32x32 ffmpeg encode (default 12s) so
//     Jellyfin probes a REAL (short) RunTimeTicks. Resume %/setPlaybackPosition
//     math needs real ticks, so zero-byte files are NOT acceptable.
//   - Deterministic GUIDs: Jellyfin derives item GUIDs from the on-disk path, so
//     the folder/filename structure here is FIXED. Rebuilding the library against
//     the same paths reproduces the same GUIDs.
//   - Reproduces real-Jellyfin quirks: notably a show whose episode PremiereDate
//     (air) order diverges from its SxxExx (IndexNumber) order — see PROD_DIVERGENT.

// Household users created in the sandbox. These map by NAME to config.sbx.json's
// Config v2 users[] / accounts[].visible_users[] (emitted by the provisioner) so
// the server resolves them via fetchUsers at startup. Names are fixed; GUIDs are
// minted by Jellyfin at creation (diagnostic only — v2 config holds no UUIDs).
export const SANDBOX_USERS = ['Alice', 'Bob', 'Carol', 'Dave'];

// The library's display name and its in-container path (bind-mounted media root).
export const LIBRARY_NAME = 'Sandbox';
export const SHOWS_LIBRARY_NAME = 'Shows';
export const MOVIES_LIBRARY_NAME = 'Movies';

// ISO date helper keeps PremiereDate strings terse and explicit below.
const d = (s) => s;

// --- Shows -----------------------------------------------------------------
//
// Each show: { title, year, seasons: [{ season, episodes: [{ ep, title, premiere }] }] }
// premiere is the on-air date written into the .nfo <aired>. IndexNumber comes
// from `ep`; ParentIndexNumber from `season`.

export const SHOWS = [
  // 1) A normal multi-season show. Air order == SxxExx order. The "happy path".
  {
    title: 'Normal Show',
    year: 2018,
    seasons: [
      {
        season: 1,
        episodes: [
          { ep: 1, title: 'Pilot', premiere: d('2018-01-07') },
          { ep: 2, title: 'Second Wind', premiere: d('2018-01-14') },
          { ep: 3, title: 'Third Time', premiere: d('2018-01-21') },
          { ep: 4, title: 'Four Square', premiere: d('2018-01-28') },
        ],
      },
      {
        season: 2,
        episodes: [
          { ep: 1, title: 'Return', premiere: d('2019-01-06') },
          { ep: 2, title: 'Resettle', premiere: d('2019-01-13') },
          { ep: 3, title: 'Reckoning', premiere: d('2019-01-20') },
        ],
      },
    ],
  },

  // 2) PRODUCTION-ORDER-DIVERGENT show. In Season 1 the PremiereDate (air) order
  //    does NOT match the IndexNumber/SxxExx order: S01E04 aired BEFORE S01E02
  //    and S01E03. This reproduces the real-Jellyfin quirk our anchor logic hit,
  //    where sorting episodes by PremiereDate yields a different sequence than
  //    sorting by season/episode number.
  //
  //    Aired order : E01 (Jan 07) -> E04 (Jan 14) -> E02 (Jan 21) -> E03 (Jan 28)
  //    Number order: E01 -> E02 -> E03 -> E04
  {
    title: 'Production Order',
    year: 2020,
    seasons: [
      {
        season: 1,
        episodes: [
          { ep: 1, title: 'Genesis', premiere: d('2020-01-07') },
          // E04 aired SECOND (earlier than E02/E03) -> divergence.
          { ep: 2, title: 'Aftermath', premiere: d('2020-01-21') },
          { ep: 3, title: 'Fallout', premiere: d('2020-01-28') },
          { ep: 4, title: 'Origins', premiere: d('2020-01-14') },
        ],
      },
    ],
  },

  // 3) A show WITH Season 0 specials interleaved among regular seasons.
  {
    title: 'Specials Show',
    year: 2017,
    seasons: [
      {
        season: 0,
        episodes: [
          { ep: 1, title: 'Behind the Scenes', premiere: d('2017-12-20') },
          { ep: 2, title: 'Holiday Special', premiere: d('2018-12-22') },
        ],
      },
      {
        season: 1,
        episodes: [
          { ep: 1, title: 'Arrival', premiere: d('2018-01-05') },
          { ep: 2, title: 'Settling In', premiere: d('2018-01-12') },
          { ep: 3, title: 'Departure', premiere: d('2018-01-19') },
        ],
      },
    ],
  },

  // 4) A single-episode series (one season, one episode).
  {
    title: 'Single Episode',
    year: 2021,
    seasons: [
      {
        season: 1,
        episodes: [{ ep: 1, title: 'The Only One', premiere: d('2021-06-01') }],
      },
    ],
  },

  // 5) A near-finale case: a short series so a viewer can sit on the last or
  //    second-to-last episode and exercise the "no next episode" branch.
  {
    title: 'Near Finale',
    year: 2022,
    seasons: [
      {
        season: 1,
        episodes: [
          { ep: 1, title: 'Beginning of the End', premiere: d('2022-03-01') },
          { ep: 2, title: 'Penultimate', premiere: d('2022-03-08') },
          { ep: 3, title: 'Finale', premiere: d('2022-03-15') },
        ],
      },
    ],
  },
];

// --- Movies ----------------------------------------------------------------
//
// Several standalone movies, each with a real (short) RunTimeTicks once probed.

export const MOVIES = [
  { title: 'Alpha Movie', year: 2015 },
  { title: 'Beta Movie', year: 2016 },
  { title: 'Gamma Movie', year: 2017 },
  { title: 'Delta Movie', year: 2019 },
];

// --- Path helpers ----------------------------------------------------------
//
// FIXED on-disk layout. Jellyfin derives item GUIDs from these paths, so do not
// reorganise them casually — a path change re-mints the GUIDs.
//
//   <root>/shows/<Title> (<Year>)/Season 0N/<Title> SxxEyy ....webm  (+ .nfo)
//   <root>/movies/<Title> (<Year>)/<Title> (<Year>).webm             (+ .nfo)

export const sanitize = (s) => s.replace(/[\\/:*?"<>|]/g, '').trim();

export function showFolder(show) {
  return `${sanitize(show.title)} (${show.year})`;
}

export function seasonFolder(season) {
  return `Season ${String(season).padStart(2, '0')}`;
}

export function episodeBaseName(show, season, ep) {
  const code = `S${String(season).padStart(2, '0')}E${String(ep.ep).padStart(2, '0')}`;
  return `${sanitize(show.title)} ${code} ${sanitize(ep.title)}`;
}

export function movieFolder(movie) {
  return `${sanitize(movie.title)} (${movie.year})`;
}

export function movieBaseName(movie) {
  return `${sanitize(movie.title)} (${movie.year})`;
}
