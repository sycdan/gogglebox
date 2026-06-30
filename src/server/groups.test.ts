import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGroupAlias,
  isGroupVisibleToAccount,
  resolveGroupForMembers,
  visibleGroupsForAccount,
} from './groups';
import { deriveGroupKey } from './groupKey';
import { GroupPlayerUser } from './appState';
import { VisibleViewer } from './accounts';

// Visible users for an account, in the account's visible-user order.
const visible: VisibleViewer[] = [
  { id: 'a', jellyfinUserId: 'a', name: 'Alice', avatarUrl: null, pinRequired: false },
  { id: 'b', jellyfinUserId: 'b', name: 'Bob', avatarUrl: null, pinRequired: false },
  { id: 'c', jellyfinUserId: 'c', name: 'Carol', avatarUrl: null, pinRequired: true },
];

test('buildGroupAlias joins member names with " + " in account visible order', () => {
  // Selection order (b, a) must NOT change the alias order (visible order wins).
  assert.equal(buildGroupAlias(['b', 'a'], visible), 'Alice + Bob');
  assert.equal(buildGroupAlias(['a', 'b', 'c'], visible), 'Alice + Bob + Carol');
  assert.equal(buildGroupAlias(['c'], visible), 'Carol');
});

test('isGroupVisibleToAccount is true iff every member is visible', () => {
  assert.equal(isGroupVisibleToAccount(['a', 'b'], visible), true);
  // Dave ('d') is not visible to this account.
  assert.equal(isGroupVisibleToAccount(['a', 'd'], visible), false);
  // An empty group is never visible.
  assert.equal(isGroupVisibleToAccount([], visible), false);
});

test('visibleGroupsForAccount filters by member-subset and orders names', () => {
  const keyAB = deriveGroupKey(['a', 'b']);
  const keyMixed = deriveGroupKey(['a', 'd']); // includes a non-visible member
  const players: Record<string, GroupPlayerUser> = {
    [keyAB]: { jellyfinUserId: 'grp-ab', memberIds: ['b', 'a'] },
    [keyMixed]: { jellyfinUserId: 'grp-mixed', memberIds: ['a', 'd'] },
  };

  const groups = visibleGroupsForAccount(players, visible, { [keyAB]: 'Alice + Bob' });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].groupKey, keyAB);
  assert.equal(groups[0].alias, 'Alice + Bob');
  // Member ids/names ordered by the account's visible-user order.
  assert.deepEqual(groups[0].memberIds, ['a', 'b']);
  assert.deepEqual(groups[0].memberNames, ['Alice', 'Bob']);
});

test('visibleGroupsForAccount backfills a derived alias when none is stored', () => {
  const keyAB = deriveGroupKey(['a', 'b']);
  const players: Record<string, GroupPlayerUser> = {
    [keyAB]: { jellyfinUserId: 'grp-ab', memberIds: ['a', 'b'] },
  };
  // No stored alias -> fall back to the derived "Alice + Bob" (never a raw hash).
  const groups = visibleGroupsForAccount(players, visible, {});
  assert.equal(groups[0].alias, 'Alice + Bob');
});

test('resolveGroupForMembers reuses an existing key and creates for a new one', () => {
  const keyAB = deriveGroupKey(['a', 'b']);
  const players: Record<string, GroupPlayerUser> = {
    [keyAB]: { jellyfinUserId: 'grp-ab', memberIds: ['a', 'b'] },
  };

  // Same set, different order -> same deterministic key -> reuse.
  const reuse = resolveGroupForMembers(['b', 'a'], players);
  assert.equal(reuse.groupKey, keyAB);
  assert.equal(reuse.exists, true);

  // A brand-new combination -> create.
  const create = resolveGroupForMembers(['a', 'c'], players);
  assert.equal(create.groupKey, deriveGroupKey(['a', 'c']));
  assert.equal(create.exists, false);
});
