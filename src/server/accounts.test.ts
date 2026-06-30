import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authenticateAccount,
  isPinRequiredForAccount,
  verifyGroupPins,
  visibleViewersForAccount,
} from './accounts';
import { ConfigAccount, ConfigUser, FamilyMember } from './types';

const users: ConfigUser[] = [
  { jellyfin_name: 'Alice', pin: '1234' },
  { jellyfin_name: 'Bob' },
  { jellyfin_name: 'Carol', pin: '5678' },
  { jellyfin_name: 'Dave' },
];

const house1: ConfigAccount = {
  username: 'house1',
  password: 'pw1',
  visible_users: [{ jellyfin_name: 'Alice' }, { jellyfin_name: 'Bob' }, { jellyfin_name: 'Carol' }],
};

const house2: ConfigAccount = {
  username: 'house2',
  password: 'pw2',
  visible_users: [{ jellyfin_name: 'Carol', pin_required: true }, { jellyfin_name: 'Dave' }],
};

const accounts = [house1, house2];

const viewersByName: Record<string, FamilyMember> = {
  Alice: { id: 'a', jellyfinUserId: 'a', name: 'Alice', avatarUrl: null },
  Bob: { id: 'b', jellyfinUserId: 'b', name: 'Bob', avatarUrl: null },
  Carol: { id: 'c', jellyfinUserId: 'c', name: 'Carol', avatarUrl: null },
  Dave: { id: 'd', jellyfinUserId: 'd', name: 'Dave', avatarUrl: null },
};

test('authenticateAccount matches by username + password only', () => {
  assert.equal(authenticateAccount(accounts, 'house2', 'pw2'), house2);
  assert.equal(authenticateAccount(accounts, 'house2', 'wrong'), null);
  assert.equal(authenticateAccount(accounts, 'nope', 'pw2'), null);
  assert.equal(authenticateAccount(accounts, undefined, undefined), null);
});

test('isPinRequiredForAccount reflects only the account-scoped flag', () => {
  // Carol is pin_required for house2, NOT for house1.
  assert.equal(isPinRequiredForAccount(house2, 'Carol'), true);
  assert.equal(isPinRequiredForAccount(house1, 'Carol'), false);
  // Dave is visible to house2 but not pin gated.
  assert.equal(isPinRequiredForAccount(house2, 'Dave'), false);
});

test('visibleViewersForAccount returns only visible users with their pin flag', () => {
  const visible = visibleViewersForAccount(house2, viewersByName);
  assert.deepEqual(
    visible.map((viewer) => [viewer.name, viewer.pinRequired]),
    [['Carol', true], ['Dave', false]],
  );

  // No pins or non-visible users leak in.
  const h1 = visibleViewersForAccount(house1, viewersByName);
  assert.deepEqual(h1.map((viewer) => viewer.name), ['Alice', 'Bob', 'Carol']);
  assert.ok(h1.every((viewer) => viewer.pinRequired === false));
});

test('verifyGroupPins requires the correct pin for pin-gated members', () => {
  const carol = viewersByName.Carol;
  const dave = viewersByName.Dave;

  // house2: Carol needs her pin (5678); Dave does not.
  assert.deepEqual(verifyGroupPins(house2, users, [carol, dave], { c: '5678' }), { ok: true });

  const missing = verifyGroupPins(house2, users, [carol, dave], {});
  assert.equal(missing.ok, false);
  assert.match((missing as { error: string }).error, /Carol/);

  const wrong = verifyGroupPins(house2, users, [carol, dave], { c: '0000' });
  assert.equal(wrong.ok, false);

  // house1 does NOT gate Carol -> no pin needed even though she has one.
  assert.deepEqual(verifyGroupPins(house1, users, [carol], {}), { ok: true });
});
