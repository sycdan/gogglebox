import assert from 'node:assert/strict';
import test from 'node:test';

import { computeWatchedFanout, markerKey } from './watchedFanout';
import { PlayerSessionProgress } from './jellyfin';

const THRESHOLD = 0.9;
const RUNTIME = 1_000_000;

// Group player "gp1" fans out to members m1, m2, m3.
function members() {
  return new Map<string, string[]>([['gp1', ['m1', 'm2', 'm3']]]);
}

function session(overrides: Partial<PlayerSessionProgress> = {}): PlayerSessionProgress {
  return {
    userId: 'gp1',
    userName: 'gbx-grp-x',
    itemId: 'item-1',
    positionTicks: 0,
    runtimeTicks: RUNTIME,
    ...overrides,
  };
}

test('below threshold produces no marks and retains no marker', () => {
  const sessions = [session({ positionTicks: Math.floor(RUNTIME * 0.5) })];
  const { marks, nextMarked } = computeWatchedFanout(new Set(), sessions, THRESHOLD, members());

  assert.equal(marks.length, 0);
  assert.equal(nextMarked.size, 0);
});

test('at/above threshold marks every member once', () => {
  const sessions = [session({ positionTicks: Math.floor(RUNTIME * 0.9) })];
  const { marks, nextMarked } = computeWatchedFanout(new Set(), sessions, THRESHOLD, members());

  assert.equal(marks.length, 3);
  const marked = marks.map((m) => m.memberId).sort();
  assert.deepEqual(marked, ['m1', 'm2', 'm3']);
  for (const m of marks) {
    assert.equal(m.itemId, 'item-1');
    assert.equal(m.playerUserId, 'gp1');
  }
  assert.equal(nextMarked.has(markerKey('gp1', 'item-1')), true);
});

test('same item next tick does NOT re-mark (idempotent)', () => {
  const sessions = [session({ positionTicks: Math.floor(RUNTIME * 0.95) })];
  const first = computeWatchedFanout(new Set(), sessions, THRESHOLD, members());
  assert.equal(first.marks.length, 3);

  // Carry the marked set into the next tick with the SAME session.
  const second = computeWatchedFanout(first.nextMarked, sessions, THRESHOLD, members());
  assert.equal(second.marks.length, 0);
  // Marker still retained while the item stays loaded past threshold.
  assert.equal(second.nextMarked.has(markerKey('gp1', 'item-1')), true);
});

test('item change can mark the new item even after a prior item was marked', () => {
  const firstSessions = [session({ positionTicks: Math.floor(RUNTIME * 0.95) })];
  const first = computeWatchedFanout(new Set(), firstSessions, THRESHOLD, members());
  assert.equal(first.marks.length, 3);

  // The player switches to a new item, already past threshold.
  const secondSessions = [session({ itemId: 'item-2', positionTicks: Math.floor(RUNTIME * 0.92) })];
  const second = computeWatchedFanout(first.nextMarked, secondSessions, THRESHOLD, members());

  assert.equal(second.marks.length, 3);
  assert.deepEqual(second.marks.map((m) => m.itemId), ['item-2', 'item-2', 'item-2']);
  // The old item's marker is no longer retained (not currently playing).
  assert.equal(second.nextMarked.has(markerKey('gp1', 'item-1')), false);
  assert.equal(second.nextMarked.has(markerKey('gp1', 'item-2')), true);
});

test('unknown session user (not a group player) is ignored', () => {
  const sessions = [
    session({ userId: 'some-other-user', positionTicks: RUNTIME }),
  ];
  const { marks, nextMarked } = computeWatchedFanout(new Set(), sessions, THRESHOLD, members());

  assert.equal(marks.length, 0);
  assert.equal(nextMarked.size, 0);
});

test('zero/unknown runtime is skipped (no division by zero, no marks)', () => {
  const sessions = [session({ runtimeTicks: 0, positionTicks: 999 })];
  const { marks, nextMarked } = computeWatchedFanout(new Set(), sessions, THRESHOLD, members());

  assert.equal(marks.length, 0);
  assert.equal(nextMarked.size, 0);
});

test('a previously-finished item can be re-marked after re-watching from the start', () => {
  const finished = [session({ positionTicks: RUNTIME })];
  const first = computeWatchedFanout(new Set(), finished, THRESHOLD, members());
  assert.equal(first.marks.length, 3);

  // User scrubs back to the start (below threshold) on a later tick: marker drops.
  const rewound = [session({ positionTicks: Math.floor(RUNTIME * 0.1) })];
  const second = computeWatchedFanout(first.nextMarked, rewound, THRESHOLD, members());
  assert.equal(second.marks.length, 0);
  assert.equal(second.nextMarked.has(markerKey('gp1', 'item-1')), false);

  // Watches to the end again -> can mark once more.
  const third = computeWatchedFanout(second.nextMarked, finished, THRESHOLD, members());
  assert.equal(third.marks.length, 3);
});

test('multiple group players in one tick each fan out to their own members', () => {
  const map = new Map<string, string[]>([
    ['gp1', ['m1', 'm2']],
    ['gp2', ['n1']],
  ]);
  const sessions = [
    session({ userId: 'gp1', itemId: 'a', positionTicks: RUNTIME }),
    session({ userId: 'gp2', itemId: 'b', positionTicks: RUNTIME }),
  ];
  const { marks } = computeWatchedFanout(new Set(), sessions, THRESHOLD, map);

  const byPlayer = marks.reduce<Record<string, string[]>>((acc, m) => {
    (acc[m.playerUserId] ??= []).push(`${m.memberId}:${m.itemId}`);
    return acc;
  }, {});
  assert.deepEqual(byPlayer.gp1.sort(), ['m1:a', 'm2:a']);
  assert.deepEqual(byPlayer.gp2, ['n1:b']);
});
