import assert from 'node:assert/strict';
import test from 'node:test';

import { getProgressPropagationTargets, mergeContinueWatching, pickGroupAnchorIndex } from './continueWatching';

// Build one viewer's per-episode played state: episodes 0..n-1, played === true
// for index < watchedThrough (i.e. the viewer has finished that many episodes and
// is currently on episode `watchedThrough`).
function viewerPlayedThrough(episodeCount: number, watchedThrough: number) {
  return Array.from({ length: episodeCount }, (_, index) => ({
    id: `ep-${index}`,
    played: index < watchedThrough,
  }));
}

test('pickGroupAnchorIndex anchors to earliest episode not all active viewers watched (real staggered case)', () => {
  // 7-episode series. Three ACTIVE viewers have FINISHED different numbers of
  // episodes and are now on later ones: Alice finished 1 (on ep1), Bob finished
  // 3 (on ep3), Carol finished 5 (on ep5). The earliest episode someone still
  // hasn't watched is ep1 (Alice's) -> anchor index 1, NOT ep3 or ep5.
  const perViewer = [
    viewerPlayedThrough(7, 1), // Alice on ep1
    viewerPlayedThrough(7, 3), // Bob on ep3
    viewerPlayedThrough(7, 5), // Carol on ep5
  ];
  assert.equal(pickGroupAnchorIndex(perViewer), 1);
});

test('pickGroupAnchorIndex: marking the lagging viewer watched on the anchor keeps it stable until all pass it', () => {
  // Anchor is ep1 (Alice lagging). Alice watches ep1 -> she is now on ep2. The
  // anchor must move only to the next earliest-not-all-watched, which is ep2
  // (still Alice; Bob/Carol already past it). It does NOT jump to ep3/ep5.
  const after = [
    viewerPlayedThrough(7, 2), // Alice now finished ep1, on ep2
    viewerPlayedThrough(7, 3), // Bob on ep3
    viewerPlayedThrough(7, 5), // Carol on ep5
  ];
  assert.equal(pickGroupAnchorIndex(after), 2);
});

test('pickGroupAnchorIndex is stable when a viewer AHEAD of the anchor toggles', () => {
  // Anchor is ep1 (Alice). Carol (ahead, on ep5) un-watches ep4 -> his next
  // unwatched moves to ep4, but the GROUP anchor is still ep1 because Alice still
  // hasn't watched it. Toggling an ahead viewer must NOT move the displayed
  // episode.
  const base = pickGroupAnchorIndex([
    viewerPlayedThrough(7, 1),
    viewerPlayedThrough(7, 3),
    viewerPlayedThrough(7, 5),
  ]);
  const carol = viewerPlayedThrough(7, 5);
  carol[4].played = false; // Carol un-watches ep4 (he is ahead of the ep1 anchor)
  const afterToggle = pickGroupAnchorIndex([
    viewerPlayedThrough(7, 1),
    viewerPlayedThrough(7, 3),
    carol,
  ]);
  assert.equal(base, 1);
  assert.equal(afterToggle, 1);
});

test('pickGroupAnchorIndex returns -1 when every active viewer has watched every episode', () => {
  const perViewer = [
    viewerPlayedThrough(5, 5),
    viewerPlayedThrough(5, 5),
    viewerPlayedThrough(5, 5),
  ];
  assert.equal(pickGroupAnchorIndex(perViewer), -1);
});

test('pickGroupAnchorIndex anchors at index 0 when one viewer has watched nothing', () => {
  const perViewer = [
    viewerPlayedThrough(5, 0), // a brand-new viewer
    viewerPlayedThrough(5, 4),
    viewerPlayedThrough(5, 5),
  ];
  assert.equal(pickGroupAnchorIndex(perViewer), 0);
});

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

test('mergeContinueWatching anchors a show to the EARLIEST not-all-watched episode across viewers', () => {
  // Two viewers at different points in the same series. The group card must
  // anchor to the EARLIEST episode (the one someone still needs), NOT the
  // furthest-along viewer, so the displayed episode is a stable group anchor.
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

  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'episode-schitt-s02e06');
  assert.equal(items[0].sourceViewerId, 'd');
  assert.equal(items[0].seasonNumber, 2);
  assert.equal(items[0].episodeNumber, 6);
});

test('mergeContinueWatching show anchor is order-independent (no jump from candidate ordering)', () => {
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

  const forward = mergeContinueWatching([earlier, later]);
  const reverse = mergeContinueWatching([later, earlier]);

  assert.equal(forward.length, 1);
  assert.equal(reverse.length, 1);
  // The earliest episode wins regardless of input order.
  assert.equal(forward[0].id, 'episode-ac-s01e03');
  assert.equal(reverse[0].id, 'episode-ac-s01e03');
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
  // Same movie in progress for three viewers at different points. The card must
  // resume from the LEAST-advanced viewer (lowest progressPercent), so the group
  // still has the most movie left to watch, and that viewer becomes the source.
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
    assert.equal(items[0].sourceViewerId, 'b'); // least-watched viewer wins
    assert.equal(items[0].progressPercent, 0.12); // resume from the lowest progress
    assert.equal(items[0].playbackPositionTicks, 120_000_000);
  }
});

test('mergeContinueWatching show selection is NOT affected by the least-watched movie rule', () => {
  // Same series, two viewers. The earlier-episode viewer is the MORE-watched one;
  // the later-episode viewer is the LESS-watched one. The show must still anchor
  // to the EARLIEST episode (air order), proving the least-progress movie rule
  // does not bleed into show ordering.
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
    progressPercent: 0.9, // more-watched, but earliest episode
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
    progressPercent: 0.05, // least-watched, but later episode
    seasonNumber: 2,
    episodeNumber: 1,
    sourceViewerId: 'b',
    sourceViewerName: 'B',
  };

  const forward = mergeContinueWatching([earlierHighProgress, laterLowProgress]);
  const reverse = mergeContinueWatching([laterLowProgress, earlierHighProgress]);

  for (const items of [forward, reverse]) {
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'episode-bear-s01e02'); // earliest episode, NOT least-progress
    assert.equal(items[0].sourceViewerId, 'a');
  }
});

test('getProgressPropagationTargets updates everyone except the source viewer', () => {
  const activeViewerIds = ['n', 'd', 'j'];
  const targets = getProgressPropagationTargets(activeViewerIds, 'n');

  assert.deepEqual(targets, ['d', 'j']);
});

test('mergeContinueWatching prefers resumable show progress over next-up placeholder for same series', () => {
  const items = mergeContinueWatching([
    {
      id: 'episode-schitt-s03e06',
      name: 'Motel Review',
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
      episodeNumber: 6,
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
      sourceViewerId: 'n',
      sourceViewerName: 'N',
    },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'episode-schitt-s03e05');
});
