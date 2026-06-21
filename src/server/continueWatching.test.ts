import assert from 'node:assert/strict';
import test from 'node:test';

import { getProgressPropagationTargets, mergeContinueWatching } from './continueWatching';

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

test('mergeContinueWatching prefers later show progress for the same series', () => {
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
  assert.equal(items[0].id, 'episode-schitt-s03e01');
  assert.equal(items[0].sourceViewerId, 'n');
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
