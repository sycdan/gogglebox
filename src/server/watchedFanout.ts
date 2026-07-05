// Stage B: watched fan-out — pure decision logic.
//
// When the per-party Jellyfin PLAYBACK user finishes an item in the /player tab,
// gbx fans the played-state out to each INDIVIDUAL party member id. This module
// is the pure, side-effect-free core: given the previously-marked set, the
// current Jellyfin sessions, the threshold, and the player-user -> member-ids
// map, it returns the marks to perform and the next marked set.
//
// The marker key is `${playerUserId}::${itemId}` so a finished item is marked
// exactly ONCE per party player user, not on every poll tick. When the player
// user switches to a different item, the new (playerUserId, itemId) pair has no
// marker yet, so it can be marked when it crosses the threshold — and stale
// markers for OTHER items naturally drop out of nextMarked (only currently-
// playing pairs are retained), so re-watching a previously-finished item later
// can mark it again.

import { PlayerSessionProgress } from './jellyfin';

// One Jellyfin write the poller should perform.
export interface WatchedMark {
  // The individual member id to mark played (a real household viewer's JF user).
  memberId: string;
  itemId: string;
  // The party player user whose session triggered this (for logging/idempotency).
  playerUserId: string;
}

export interface FanoutResult {
  marks: WatchedMark[];
  // The marked set to carry into the next tick. Only currently-playing
  // (playerUserId, itemId) pairs that have reached the threshold are retained,
  // so it stays bounded and lets a later re-watch re-mark.
  nextMarked: Set<string>;
}

export function markerKey(playerUserId: string, itemId: string): string {
  return `${playerUserId}::${itemId}`;
}

// Decide which member ids to mark played this tick.
//   prevMarked        marker keys already actioned (carried from prior ticks)
//   sessions          normalized active Jellyfin sessions (jellyfin.listSessions)
//   threshold         completion fraction (e.g. config.watchedThreshold = 0.9)
//   playerUserMembers map: party player jellyfinUserId -> member ids to fan out to
export function computeWatchedFanout(
  prevMarked: Set<string>,
  sessions: PlayerSessionProgress[],
  threshold: number,
  playerUserMembers: Map<string, string[]>,
): FanoutResult {
  const marks: WatchedMark[] = [];
  const nextMarked = new Set<string>();

  for (const session of sessions) {
    const members = playerUserMembers.get(session.userId);
    // Only fan out for sessions belonging to a known PARTY PLAYER user.
    if (!members || members.length === 0) {
      continue;
    }

    if (session.runtimeTicks <= 0) {
      continue;
    }

    const progress = session.positionTicks / session.runtimeTicks;
    if (progress < threshold) {
      // Below threshold: nothing to mark, and do NOT retain a marker for this
      // pair (so it can be marked once it later crosses the threshold).
      continue;
    }

    const key = markerKey(session.userId, session.itemId);
    // Retain the marker for currently-playing finished pairs so we don't re-mark
    // every tick while the item stays loaded past the threshold.
    nextMarked.add(key);

    if (prevMarked.has(key)) {
      // Already marked this (player user, item) — idempotent no-op.
      continue;
    }

    for (const memberId of members) {
      marks.push({ memberId, itemId: session.itemId, playerUserId: session.userId });
    }
  }

  return { marks, nextMarked };
}
