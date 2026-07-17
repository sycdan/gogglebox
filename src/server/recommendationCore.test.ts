import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLibraryQualityEvidence,
  rankRecommendationCandidates,
  toRecommendedItems,
} from './recommendationCore';
import { LibraryItem } from './types';

function item(id: string, rating: number | null = null): LibraryItem {
  return {
    id,
    name: id,
    type: 'movie',
    overview: '',
    year: null,
    runtimeMinutes: null,
    rating,
    genres: [],
    officialRating: null,
    imageUrl: null,
    backdropUrl: null,
    playable: true,
  };
}

test('rankRecommendationCandidates merges evidence for the same canonical item id', () => {
  const ranked = rankRecommendationCandidates(
    [item('a'), item('b')],
    [
      { itemId: 'b', channel: 'party-seen', strength: 0.7, reason: 'Someone here has seen this' },
      { itemId: 'b', channel: 'newly-added', strength: 0.5, reason: 'Newly added' },
      { itemId: 'a', channel: 'library-quality', strength: 0.8, reason: 'Highly rated' },
    ],
    { channelWeights: { 'party-seen': 2, 'newly-added': 1, 'library-quality': 1 } },
  );

  assert.equal(ranked[0].item.id, 'b');
  assert.equal(ranked[0].evidence.length, 2);
  assert.deepEqual(ranked[0].reasons, ['Someone here has seen this', 'Newly added']);
  assert.equal(ranked[0].score, 1.9);
});

test('rankRecommendationCandidates can pin party-resume evidence ahead of higher ordinary score', () => {
  const ranked = rankRecommendationCandidates(
    [item('resume'), item('popular')],
    [
      { itemId: 'resume', channel: 'party-resume', strength: 0.1, reason: 'Continue from last time' },
      { itemId: 'popular', channel: 'library-quality', strength: 1, reason: 'Highly rated' },
    ],
    { pinnedChannels: ['party-resume'] },
  );

  assert.equal(ranked[0].item.id, 'resume');
  assert.equal(ranked[0].reasons[0], 'Continue from last time');
});

test('createLibraryQualityEvidence emits safe evidence keyed by item id', () => {
  const evidence = createLibraryQualityEvidence([item('rated', 8.7), item('unrated')]);

  assert.deepEqual(evidence.map((record) => record.itemId), ['rated', 'unrated']);
  assert.equal(evidence[0].channel, 'library-quality');
  assert.equal(evidence[0].strength, 0.87);
  assert.equal(evidence[0].reason, 'Highly rated in your library');
  assert.equal(evidence[1].strength, 0.4);
  assert.equal(evidence[1].reason, 'Recommended from your library');
});

test('toRecommendedItems carries evidence and reasons without changing the base item', () => {
  const ranked = rankRecommendationCandidates(
    [item('a', 9)],
    [{ itemId: 'a', channel: 'library-quality', strength: 0.9, reason: 'Highly rated' }],
  );
  const [recommended] = toRecommendedItems(ranked);

  assert.equal(recommended.id, 'a');
  assert.equal(recommended.recommendationScore, 0.9);
  assert.deepEqual(recommended.recommendationReasons, ['Highly rated']);
  assert.equal(recommended.recommendationEvidence[0].channel, 'library-quality');
});

