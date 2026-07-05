import assert from 'node:assert/strict';
import test from 'node:test';

import { getProgressPropagationTargets, isIgnored, mergeContinueWatching } from './continueWatching';

test('mergeContinueWatching keeps a show resume item when only one viewer has progress', () => {
  const items = mergeContinueWatching([
    {
      id: 'episode-schitt-s03e05',
      name: 'The Hospies',
      type: 'show',
      overview: 'Episode overview',
      year: 2018,
      runtimeMinutes: 22,
      rating: 8.4,
      genres: ['Comedy'],
      officialRating: 'TV-14',
      imageUrl: null,
      backdropUrl: null,
      playable: true,
      playbackPositionTicks: 420_000_000,
      progressPercent: 0.32,
      seriesId: 'series-schitts-creek',
      seriesName: "Schitt's Creek",
      seasonNumber: 3,
      episodeNumber: 5,
      sourceViewerId: 'n',
      sourceViewerName: 'N',
    },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].seriesName, "Schitt's Creek");
  assert.equal(items[0].sourceViewerId, 'n');
});

test('mergeContinueWatching fans out DIFFERENT episodes of the same series into SEPARATE cards', () => {
  // The Ancient-Aliens-style scenario: two viewers on different episodes of one
  // series. The old model collapsed this to ONE anchored card; the new model
  // must produce TWO cards, one per distinct episode candidate, so the party
  // isn't forced through the earliest unwatched episode when both are fine
  // resuming their own episode.
  const items = mergeContinueWatching([
    {
      id: 'episode-schitt-s02e06',
      name: 'Moira vs. Town Council',
      type: 'show',
      overview: '',
      year: 2017,
      runtimeMinutes: 22,
      rating: null,
      genres: ['Comedy'],
      officialRating: null,
      imageUrl: null,
      backdropUrl: null,
      playable: true,
      playbackPositionTicks: 200_000_000,
      progressPercent: 0.18,
      seriesId: 'series-schitts-creek',
      seriesName: "Schitt's Creek",
      seasonNumber: 2,
      episodeNumber: 6,
      sourceViewerId: 'd',
      sourceViewerName: 'D',
    },
    {
      id: 'episode-schitt-s03e01',
      name: 'Opening Night',
      type: 'show',
      overview: '',
      year: 2018,
      runtimeMinutes: 22,
      rating: null,
      genres: ['Comedy'],
      officialRating: null,
      imageUrl: null,
      backdropUrl: null,
      playable: true,
      playbackPositionTicks: 100_000_000,
      progressPercent: 0.08,
      seriesId: 'series-schitts-creek',
      seriesName: "Schitt's Creek",
      seasonNumber: 3,
      episodeNumber: 1,
      sourceViewerId: 'n',
      sourceViewerName: 'N',
    },
  ]);

  assert.equal(items.length, 2);
  const ids = items.map((item) => item.id).sort();
  assert.deepEqual(ids, ['episode-schitt-s02e06', 'episode-schitt-s03e01']);
});

test('mergeContinueWatching fan-out is order-independent (each distinct episode still gets its own card)', () => {
  const earlier = {
    id: 'episode-ac-s01e03',
    name: 'In a Lonely Place',
    type: 'show' as const,
    overview: '',
    year: 2018,
    runtimeMinutes: 50,
    rating: null,
    genres: ['Sci-Fi'],
    officialRating: null,
    imageUrl: null,
    backdropUrl: null,
    playable: true,
    playbackPositionTicks: 300_000_000,
    progressPercent: 0.2,
    seriesId: 'series-altered-carbon',
    seriesName: 'Altered Carbon',
    seasonNumber: 1,
    episodeNumber: 3,
    sourceViewerId: 'a',
    sourceViewerName: 'A',
  };
  const later = {
    ...earlier,
    id: 'episode-ac-s01e05',
    name: 'The Wrong Man',
    playbackPositionTicks: 100_000_000,
    progressPercent: 0.1,
    seasonNumber: 1,
    episodeNumber: 5,
    sourceViewerId: 'b',
    sourceViewerName: 'B',
  };

  const forward = mergeContinueWatching([earlier, later]).map((item) => item.id).sort();
  const reverse = mergeContinueWatching([later, earlier]).map((item) => item.id).sort();

  assert.deepEqual(forward, ['episode-ac-s01e03', 'episode-ac-s01e05']);
  assert.deepEqual(reverse, ['episode-ac-s01e03', 'episode-ac-s01e05']);
});

test('mergeContinueWatching orders the rail alphabetically by name with a stable id tie-break, deterministically', () => {
  // Mixed shows + movies whose progress differs; the rail must order purely by
  // show/movie name (case-insensitive), tie-breaking on id, so repeated merges of
  // the same state never reshuffle the cards.
  const base = {
    overview: '',
    year: 2020,
    runtimeMinutes: 100,
    rating: null,
    genres: [],
    officialRating: null,
    imageUrl: null,
    backdropUrl: null,
    playable: true,
    seasonNumber: null,
    episodeNumber: null,
    sourceViewerName: 'V',
  };
  const movieZodiac = {
    ...base,
    id: 'movie-zodiac',
    name: 'Zodiac',
    type: 'movie' as const,
    playbackPositionTicks: 900_000_000,
    progressPercent: 0.9, // most-watched -> would sort first under the old rank sort
    seriesId: null,
    seriesName: null,
    sourceViewerId: 'a',
  };
  const movieArrival = {
    ...base,
    id: 'movie-arrival',
    name: 'arrival', // lowercase: must still sort case-insensitively before "Brooklyn"
    type: 'movie' as const,
    playbackPositionTicks: 100_000_000,
    progressPercent: 0.1,
    seriesId: null,
    seriesName: null,
    sourceViewerId: 'b',
  };
  // Two distinct shows that share a display name -> id tie-break decides order.
  const showBrooklynTwo = {
    ...base,
    id: 'episode-brooklyn-2',
    name: 'A Later Episode',
    type: 'show' as const,
    playbackPositionTicks: 50_000_000,
    progressPercent: 0.05,
    seriesId: 'series-brooklyn-b',
    seriesName: 'Brooklyn',
    seasonNumber: 1,
    episodeNumber: 4,
    sourceViewerId: 'c',
  };
  const showBrooklynOne = {
    ...base,
    id: 'episode-brooklyn-1',
    name: 'An Earlier Episode',
    type: 'show' as const,
    playbackPositionTicks: 500_000_000,
    progressPercent: 0.5,
    seriesId: 'series-brooklyn-a',
    seriesName: 'Brooklyn',
    seasonNumber: 1,
    episodeNumber: 2,
    sourceViewerId: 'd',
  };

  const input = [movieZodiac, showBrooklynTwo, movieArrival, showBrooklynOne];
  const expectedOrder = [
    'movie-arrival', // "arrival"
    'episode-brooklyn-1', // "Brooklyn", id tie-break: ...-1 before ...-2
    'episode-brooklyn-2', // "Brooklyn"
    'movie-zodiac', // "Zodiac"
  ];

  const first = mergeContinueWatching(input).map((item) => item.id);
  assert.deepEqual(first, expectedOrder);

  // Same input (and a shuffled copy) must always yield the identical order.
  const repeat = mergeContinueWatching(input).map((item) => item.id);
  const shuffled = mergeContinueWatching([showBrooklynOne, movieArrival, showBrooklynTwo, movieZodiac]).map(
    (item) => item.id,
  );
  assert.deepEqual(repeat, expectedOrder);
  assert.deepEqual(shuffled, expectedOrder);
});

test('mergeContinueWatching resumes a shared movie from the LEAST-watched viewer', () => {
  // Same movie in progress for three viewers at different points. A movie
  // id-group collapses to one card (movies have no episode granularity), and
  // pickRepresentative's tie-break (prefer real progress over a placeholder,
  // then LEAST progress wins) means the least-advanced viewer's position
  // becomes the card's resume point and source, so nobody's progress gets
  // skipped past or spoiled ahead.
  const base = {
    name: 'Heat',
    type: 'movie' as const,
    overview: '',
    year: 1995,
    runtimeMinutes: 170,
    rating: 8.3,
    genres: ['Crime'],
    officialRating: 'R',
    imageUrl: null,
    backdropUrl: null,
    playable: true,
    seriesId: null,
    seriesName: null,
    seasonNumber: null,
    episodeNumber: null,
  };
  const mostWatched = {
    ...base,
    id: 'movie-heat',
    playbackPositionTicks: 900_000_000,
    progressPercent: 0.9,
    sourceViewerId: 'a',
    sourceViewerName: 'A',
  };
  const leastWatched = {
    ...base,
    id: 'movie-heat',
    playbackPositionTicks: 120_000_000,
    progressPercent: 0.12,
    sourceViewerId: 'b',
    sourceViewerName: 'B',
  };
  const middle = {
    ...base,
    id: 'movie-heat',
    playbackPositionTicks: 500_000_000,
    progressPercent: 0.5,
    sourceViewerId: 'c',
    sourceViewerName: 'C',
  };

  for (const order of [
    [mostWatched, leastWatched, middle],
    [leastWatched, mostWatched, middle],
    [middle, mostWatched, leastWatched],
  ]) {
    const items = mergeContinueWatching(order);
    assert.equal(items.length, 1);
    assert.equal(items[0].sourceViewerId, 'b'); // least real progress wins
    assert.equal(items[0].progressPercent, 0.12);
    assert.equal(items[0].playbackPositionTicks, 120_000_000);
  }
});

test('mergeContinueWatching keeps shows and movies fanned out/collapsed independently (no cross-bleed)', () => {
  // Same series, two viewers on DIFFERENT episodes: two cards (fan-out).
  // A same movie id from two viewers still collapses to one card resuming the
  // least-advanced viewer's position — proving movie collapsing is unaffected
  // by the show fan-out change.
  const base = {
    type: 'show' as const,
    overview: '',
    year: 2018,
    runtimeMinutes: 50,
    rating: null,
    genres: ['Drama'],
    officialRating: null,
    imageUrl: null,
    backdropUrl: null,
    playable: true,
    seriesId: 'series-the-bear',
    seriesName: 'The Bear',
  };
  const earlierHighProgress = {
    ...base,
    id: 'episode-bear-s01e02',
    name: 'Hands',
    playbackPositionTicks: 900_000_000,
    progressPercent: 0.9,
    seasonNumber: 1,
    episodeNumber: 2,
    sourceViewerId: 'a',
    sourceViewerName: 'A',
  };
  const laterLowProgress = {
    ...base,
    id: 'episode-bear-s02e01',
    name: 'Beef',
    playbackPositionTicks: 100_000_000,
    progressPercent: 0.05,
    seasonNumber: 2,
    episodeNumber: 1,
    sourceViewerId: 'b',
    sourceViewerName: 'B',
  };

  const forward = mergeContinueWatching([earlierHighProgress, laterLowProgress]);
  const reverse = mergeContinueWatching([laterLowProgress, earlierHighProgress]);

  for (const items of [forward, reverse]) {
    assert.equal(items.length, 2);
    const ids = items.map((item) => item.id).sort();
    assert.deepEqual(ids, ['episode-bear-s01e02', 'episode-bear-s02e01']);
  }
});

// Shared show base for the ignore-scope tests: an out-of-order show
// (Ancient Aliens style) where episode order doesn't matter to the party.
const anthologyBase = {
  type: 'show' as const,
  overview: '',
  year: 2010,
  runtimeMinutes: 45,
  rating: null,
  genres: ['Documentary'],
  officialRating: null,
  imageUrl: null,
  backdropUrl: null,
  playable: true,
  seriesId: 'series-ancient-aliens',
  seriesName: 'Ancient Aliens',
};
// A has seen eps 1-20 -> NextUp ep 21. B has seen up to ep 9 -> NextUp ep 10.
const viewerAOnEp21 = {
  ...anthologyBase,
  id: 'episode-aa-s01e21',
  name: 'Episode 21',
  playbackPositionTicks: 0,
  progressPercent: 0,
  seasonNumber: 1,
  episodeNumber: 21,
  sourceViewerId: 'a',
  sourceViewerName: 'A',
};
const viewerBOnEp10 = {
  ...anthologyBase,
  id: 'episode-aa-s01e10',
  name: 'Episode 10',
  playbackPositionTicks: 0,
  progressPercent: 0,
  seasonNumber: 1,
  episodeNumber: 10,
  sourceViewerId: 'b',
  sourceViewerName: 'B',
};

test('mergeContinueWatching produces one card per viewer candidate for an anthology show (no forced earliest-episode)', () => {
  const items = mergeContinueWatching([viewerAOnEp21, viewerBOnEp10]);

  assert.equal(items.length, 2);
  const ids = items.map((item) => item.id).sort();
  assert.deepEqual(ids, ['episode-aa-s01e10', 'episode-aa-s01e21']);
});

test('isIgnored: ignoring one episode-scoped candidate hides only that card, NOT the other episode of the same series', () => {
  // The exact scenario from the brief: ignore ep1 (viewer B's ep10 in this
  // fixture) at episode scope. The OTHER episode-candidate for the same series
  // must remain visible, and no "replacement" episode should appear (there is
  // none to replace it with — fan-out already produced independent cards).
  const items = mergeContinueWatching([viewerAOnEp21, viewerBOnEp10]);
  assert.equal(items.length, 2);

  const entries = [
    { key: 'episode-aa-s01e10', matchSeriesId: false, label: 'Ancient Aliens · S01E10', ignoredAt: Date.now() },
  ];
  const visible = items.filter((item) => !isIgnored(entries, item));

  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, 'episode-aa-s01e21');
});

test('isIgnored: whole-show scope hides every CURRENT candidate for that series', () => {
  const items = mergeContinueWatching([viewerAOnEp21, viewerBOnEp10]);
  const entries = [
    { key: 'series-ancient-aliens', matchSeriesId: true, label: 'Ancient Aliens', ignoredAt: Date.now() },
  ];
  const visible = items.filter((item) => !isIgnored(entries, item));
  assert.equal(visible.length, 0);
});

test('isIgnored: whole-show scope also hides a SUBSEQUENTLY produced candidate for that series', () => {
  // Simulate: the show was ignored earlier; a fresh merge later produces a NEW
  // episode candidate (e.g. viewer B advanced to ep11). It must still be hidden.
  const laterCandidate = {
    ...viewerBOnEp10,
    id: 'episode-aa-s01e11',
    name: 'Episode 11',
    episodeNumber: 11,
  };
  const items = mergeContinueWatching([viewerAOnEp21, laterCandidate]);
  const entries = [
    { key: 'series-ancient-aliens', matchSeriesId: true, label: 'Ancient Aliens', ignoredAt: Date.now() },
  ];
  const visible = items.filter((item) => !isIgnored(entries, item));
  assert.equal(visible.length, 0);
});

test('isIgnored: unignoring (removing the entry) un-hides the card', () => {
  const items = mergeContinueWatching([viewerBOnEp10]);
  const ignored = [
    { key: 'episode-aa-s01e10', matchSeriesId: false, label: 'Ancient Aliens · S01E10', ignoredAt: Date.now() },
  ];
  assert.equal(items.filter((item) => !isIgnored(ignored, item)).length, 0);

  const unignored: typeof ignored = [];
  assert.equal(items.filter((item) => !isIgnored(unignored, item)).length, 1);
});

test('isIgnored: movie scope hides only the exact movie id, unaffected by matchSeriesId', () => {
  const movieItem = { type: 'movie', id: 'movie-heat', seriesId: null };
  const entries = [{ key: 'movie-heat', matchSeriesId: false, label: 'Heat', ignoredAt: Date.now() }];
  assert.equal(isIgnored(entries, movieItem), true);
  assert.equal(isIgnored(entries, { type: 'movie', id: 'movie-other', seriesId: null }), false);
});

test('getProgressPropagationTargets updates everyone except the source viewer', () => {
  const activeViewerIds = ['n', 'd', 'j'];
  const targets = getProgressPropagationTargets(activeViewerIds, 'n');

  assert.deepEqual(targets, ['d', 'j']);
});

test('mergeContinueWatching prefers resumable show progress over next-up placeholder for the SAME exact episode', () => {
  const items = mergeContinueWatching([
    {
      id: 'episode-schitt-s03e05',
      name: 'Rooms by the Hour',
      type: 'show',
      overview: '',
      year: 2018,
      runtimeMinutes: 22,
      rating: null,
      genres: ['Comedy'],
      officialRating: null,
      imageUrl: null,
      backdropUrl: null,
      playable: true,
      playbackPositionTicks: 0,
      progressPercent: 0,
      seriesId: 'series-schitts-creek',
      seriesName: "Schitt's Creek",
      seasonNumber: 3,
      episodeNumber: 5,
      sourceViewerId: 'n',
      sourceViewerName: 'N',
    },
    {
      id: 'episode-schitt-s03e05',
      name: 'Rooms by the Hour',
      type: 'show',
      overview: '',
      year: 2018,
      runtimeMinutes: 22,
      rating: null,
      genres: ['Comedy'],
      officialRating: null,
      imageUrl: null,
      backdropUrl: null,
      playable: true,
      playbackPositionTicks: 320_000_000,
      progressPercent: 0.29,
      seriesId: 'series-schitts-creek',
      seriesName: "Schitt's Creek",
      seasonNumber: 3,
      episodeNumber: 5,
      sourceViewerId: 'd',
      sourceViewerName: 'D',
    },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'episode-schitt-s03e05');
  assert.equal(items[0].sourceViewerId, 'd');
  assert.equal(items[0].progressPercent, 0.29);
});
