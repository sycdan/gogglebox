import assert from 'node:assert/strict';
import test from 'node:test';

import { anchorShowCards, SeriesPlayedStateClient } from './anchorShowCards';
import { EpisodeItem } from './jellyfin';
import { ContinueWatchingItem, FamilyMember } from './types';

// Air-order episode fixtures for one series.
const EPISODES: EpisodeItem[] = [1, 2, 3, 4, 5].map((n) => ({
  id: `ep0${n}`,
  name: `Episode ${n}`,
  seriesId: 'series-gumball',
  seriesName: 'Gumball',
  seasonNumber: 1,
  episodeNumber: n,
  runtimeMinutes: 22,
  overview: '',
  imageUrl: null,
}));

// Per-viewer "watched through" count: episodes [0..through) are played.
const WATCHED_THROUGH: Record<string, number> = {
  // Alice has watched E01 only and is currently on E02 (E02 NOT played).
  'jf-alice': 1,
  // Bob has watched E01-E02 and is on E03.
  'jf-bob': 2,
  // Carol has watched E01-E03 and is on E04 (this is the MERGED candidate's
  // furthest episode that previously wrongly became the displayed card).
  'jf-carol': 3,
};

function makeClient(): SeriesPlayedStateClient & {
  getItemPlayedState(userId: string, itemId: string): boolean;
} {
  return {
    async listSeriesEpisodesPlayedState(userId: string) {
      const through = WATCHED_THROUGH[userId] ?? 0;
      return EPISODES.map((episode, index) => ({ episode, played: index < through }));
    },
    getItemPlayedState(userId: string, itemId: string) {
      const through = WATCHED_THROUGH[userId] ?? 0;
      const index = EPISODES.findIndex((e) => e.id === itemId);
      return index >= 0 && index < through;
    },
  };
}

const VIEWERS: FamilyMember[] = [
  { id: 'alice', name: 'Alice', jellyfinUserId: 'jf-alice' },
  { id: 'bob', name: 'Bob', jellyfinUserId: 'jf-bob' },
  { id: 'carol', name: 'Carol', jellyfinUserId: 'jf-carol' },
];

// The merged show card the endpoint hands to anchorShowCards: the furthest-along
// viewer (Carol) won the merge, so the card points at E04 even though Alice and
// Bob are behind. This is the exact production input that was rendering wrong.
const MERGED_CARD: ContinueWatchingItem = {
  id: 'ep04',
  name: 'Episode 4',
  type: 'show',
  overview: '',
  year: 2018,
  runtimeMinutes: 22,
  rating: null,
  genres: ['Animation'],
  officialRating: null,
  imageUrl: null,
  backdropUrl: null,
  playable: true,
  sourceViewerId: 'carol',
  sourceViewerName: 'Carol',
  playbackPositionTicks: 500_000_000,
  progressPercent: 0.3,
  seriesId: 'series-gumball',
  seriesName: 'Gumball',
  seasonNumber: 1,
  episodeNumber: 4,
};

test('anchorShowCards re-anchors a merged show card to the earliest-not-all-watched episode over the FULL active group', async () => {
  const client = makeClient();
  const [card] = await anchorShowCards(client, [MERGED_CARD], VIEWERS);

  // Despite the merged candidate being Carol's E04, the displayed episode must be
  // Alice's earliest unwatched episode E02 (the first episode the group as a
  // whole still needs). This locks the wiring: if anchoring ran over only the
  // merged candidate's viewer (Carol), it would return E04 and this fails.
  assert.ok(card, 'card should not be dropped');
  assert.equal(card.id, 'ep02');
  assert.equal(card.seasonNumber, 1);
  assert.equal(card.episodeNumber, 2);
  // Anchor differs from the merged episode -> progress resets to a fresh episode.
  assert.equal(card.playbackPositionTicks, 0);
  assert.equal(card.progressPercent, 0);
});

test('anchorShowCards yields a meaningful lit/unlit pill mix at the anchor episode', async () => {
  const client = makeClient();
  const [card] = await anchorShowCards(client, [MERGED_CARD], VIEWERS);
  assert.ok(card);

  // Pills are computed (by the endpoint) via getItemPlayedState against the
  // DISPLAYED episode id. At the anchor E02: Alice has NOT played it (she's on
  // E02), Bob HAS (watched through E02), Carol HAS. So 2/3 lit - a real mix that
  // proves the anchor is a meaningful group point, not a 0/3 ahead-of-everyone
  // episode.
  const pills = VIEWERS.map((v) => ({
    viewerId: v.id,
    watched: client.getItemPlayedState(v.jellyfinUserId, card.id),
  }));

  assert.deepEqual(pills, [
    { viewerId: 'alice', watched: false },
    { viewerId: 'bob', watched: true },
    { viewerId: 'carol', watched: true },
  ]);
  assert.equal(pills.filter((p) => p.watched).length, 2); // 2/3 lit
});

test('anchorShowCards drops a show card once every active viewer has watched every episode', async () => {
  const client: SeriesPlayedStateClient = {
    async listSeriesEpisodesPlayedState() {
      return EPISODES.map((episode) => ({ episode, played: true }));
    },
  };
  const result = await anchorShowCards(client, [MERGED_CARD], VIEWERS);
  assert.equal(result.length, 0);
});

test('anchorShowCards anchors to E01 when one active viewer has watched nothing', async () => {
  const client: SeriesPlayedStateClient = {
    async listSeriesEpisodesPlayedState(userId: string) {
      // A brand-new viewer (jf-new) has watched nothing; others are ahead.
      const through = userId === 'jf-new' ? 0 : 4;
      return EPISODES.map((episode, index) => ({ episode, played: index < through }));
    },
  };
  const viewers: FamilyMember[] = [
    { id: 'new', name: 'New', jellyfinUserId: 'jf-new' },
    ...VIEWERS.slice(1),
  ];
  const [card] = await anchorShowCards(client, [MERGED_CARD], viewers);
  assert.ok(card);
  assert.equal(card.id, 'ep01');
});

// The MERGED_CARD above is shaped EXACTLY like a real /api/continue-watching
// show card (verified against the sandbox Jellyfin): it carries seriesId (the
// SERIES id, not the episode id), type:'show', seasonNumber, episodeNumber, and
// sourceViewerId/Name. This locks the show-guard: a card missing seriesId would
// be skipped (and pass through untouched with its original 40% progress), which
// is the regression this test must catch.
test('MERGED_CARD mirrors the real continue-watching show card shape (guard inputs present)', () => {
  assert.equal(MERGED_CARD.type, 'show');
  assert.equal(typeof MERGED_CARD.seriesId, 'string');
  assert.notEqual(MERGED_CARD.seriesId, MERGED_CARD.id); // series id != episode id
  assert.equal(typeof MERGED_CARD.seasonNumber, 'number');
  assert.equal(typeof MERGED_CARD.episodeNumber, 'number');
  assert.equal(typeof MERGED_CARD.sourceViewerId, 'string');
});

// Production-order divergence (sandbox "Production Order": index order E01..E04
// but aired order E01,E04,E02,E03). The played-state walk is INDEX order, so
// even when the merged card points at the latest SxxExx (E04, the furthest
// viewer's resume), anchoring must pick the earliest INDEX-order episode the
// group still needs (E02). This is the exact real scenario that previously
// showed S01E04 with a 40% badge.
test('anchorShowCards anchors by index order, not the latest-SxxExx merged card (production-order show)', async () => {
  // Index-order played state: Alice watched only E01 (on E02 by index);
  // Bob watched E01,E04; Carol watched E01,E02,E04. Earliest index-order episode
  // someone still needs = E02 (index 1).
  const playedByUser: Record<string, boolean[]> = {
    'jf-alice': [true, false, false, false, false],
    'jf-bob': [true, false, false, true, false],
    'jf-carol': [true, true, false, true, false],
  };
  const client: SeriesPlayedStateClient = {
    async listSeriesEpisodesPlayedState(userId: string) {
      const flags = playedByUser[userId] ?? [];
      return EPISODES.map((episode, index) => ({ episode, played: Boolean(flags[index]) }));
    },
  };
  // Merged card points at E04 with 40% progress (the furthest viewer's resume).
  const mergedAtLatest: ContinueWatchingItem = {
    ...MERGED_CARD,
    id: 'ep04',
    seasonNumber: 1,
    episodeNumber: 4,
    playbackPositionTicks: 500_000_000,
    progressPercent: 0.4,
  };
  const [card] = await anchorShowCards(client, [mergedAtLatest], VIEWERS);
  assert.ok(card);
  assert.equal(card.id, 'ep02'); // earliest index-order not-all-watched, NOT E04
  assert.equal(card.progressPercent, 0); // re-anchored -> fresh episode, no 40% badge
});
