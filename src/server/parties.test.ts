import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPartyAlias,
  isPartyVisibleToAccount,
  resolvePartyForMembers,
  visiblePartiesForAccount,
} from './parties';
import { derivePartyKey } from './partyKey';
import { PartyPlayerUser } from './appState';
import { VisibleViewer } from './accounts';

// Visible viewers for an account, in the account's visible-viewer order
// (primaries, then secondaries, then tertiary guest candidates).
const visible: VisibleViewer[] = [
  { id: 'a', jellyfinUserId: 'a', name: 'Alice', avatarUrl: null, tier: 'primary', pinRequired: false },
  { id: 'b', jellyfinUserId: 'b', name: 'Bob', avatarUrl: null, tier: 'secondary', pinRequired: false },
  { id: 'c', jellyfinUserId: 'c', name: 'Carol', avatarUrl: null, tier: 'tertiary', pinRequired: true },
];

test('buildPartyAlias joins member names with " + " in account visible order', () => {
  // Selection order (b, a) must NOT change the alias order (visible order wins).
  assert.equal(buildPartyAlias(['b', 'a'], visible), 'Alice + Bob');
  assert.equal(buildPartyAlias(['a', 'b', 'c'], visible), 'Alice + Bob + Carol');
  assert.equal(buildPartyAlias(['c'], visible), 'Carol');
});

test('isPartyVisibleToAccount is true iff every member is visible', () => {
  assert.equal(isPartyVisibleToAccount(['a', 'b'], visible), true);
  // Dave ('d') is not visible to this account.
  assert.equal(isPartyVisibleToAccount(['a', 'd'], visible), false);
  // An empty party is never visible.
  assert.equal(isPartyVisibleToAccount([], visible), false);
});

test('visiblePartiesForAccount filters by member-subset and orders names', () => {
  const keyAB = derivePartyKey(['a', 'b']);
  const keyMixed = derivePartyKey(['a', 'd']); // includes a non-visible member
  const players: Record<string, PartyPlayerUser> = {
    [keyAB]: { jellyfinUserId: 'grp-ab', memberIds: ['b', 'a'] },
    [keyMixed]: { jellyfinUserId: 'grp-mixed', memberIds: ['a', 'd'] },
  };

  const parties = visiblePartiesForAccount(players, visible, { [keyAB]: 'Alice + Bob' });
  assert.equal(parties.length, 1);
  assert.equal(parties[0].partyKey, keyAB);
  assert.equal(parties[0].alias, 'Alice + Bob');
  // Member ids/names ordered by the account's visible-user order.
  assert.deepEqual(parties[0].memberIds, ['a', 'b']);
  assert.deepEqual(parties[0].memberNames, ['Alice', 'Bob']);
});

test('visiblePartiesForAccount backfills a derived alias when none is stored', () => {
  const keyAB = derivePartyKey(['a', 'b']);
  const players: Record<string, PartyPlayerUser> = {
    [keyAB]: { jellyfinUserId: 'grp-ab', memberIds: ['a', 'b'] },
  };
  // No stored alias -> fall back to the derived "Alice + Bob" (never a raw hash).
  const parties = visiblePartiesForAccount(players, visible, {});
  assert.equal(parties[0].alias, 'Alice + Bob');
});

test('resolvePartyForMembers reuses an existing key and creates for a new one', () => {
  const keyAB = derivePartyKey(['a', 'b']);
  const players: Record<string, PartyPlayerUser> = {
    [keyAB]: { jellyfinUserId: 'grp-ab', memberIds: ['a', 'b'] },
  };

  // Same set, different order -> same deterministic key -> reuse.
  const reuse = resolvePartyForMembers(['b', 'a'], players);
  assert.equal(reuse.partyKey, keyAB);
  assert.equal(reuse.exists, true);

  // A brand-new combination -> create.
  const create = resolvePartyForMembers(['a', 'c'], players);
  assert.equal(create.partyKey, derivePartyKey(['a', 'c']));
  assert.equal(create.exists, false);
});
