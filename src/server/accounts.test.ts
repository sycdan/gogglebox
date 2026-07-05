import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accountForToken,
  resolveAccountTiers,
  resolvePartyMemberSelection,
  verifyPartyPins,
  visibleViewersForAccount,
} from './accounts';
import { AccountV2, ConfigUser, FamilyMember } from './types';

// The pin registry. Eve is deliberately absent: wildcards resolve against the
// LIVE Jellyfin list, not users[].
const users: ConfigUser[] = [
  { jellyfin_name: 'Alice', pin: '1234' },
  { jellyfin_name: 'Bob' },
  { jellyfin_name: 'Carol', pin: '5678' },
  { jellyfin_name: 'Dave', pin: '2468' },
];

// The live Jellyfin universe, in Jellyfin list order.
const allNames = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'];

const viewersByName: Record<string, FamilyMember> = {
  Alice: { id: 'a', jellyfinUserId: 'a', name: 'Alice', avatarUrl: null },
  Bob: { id: 'b', jellyfinUserId: 'b', name: 'Bob', avatarUrl: null },
  Carol: { id: 'c', jellyfinUserId: 'c', name: 'Carol', avatarUrl: null },
  Dave: { id: 'd', jellyfinUserId: 'd', name: 'Dave', avatarUrl: null },
  Eve: { id: 'e', jellyfinUserId: 'e', name: 'Eve', avatarUrl: null },
};

const explicitAccount: AccountV2 = {
  primary_users: ['Alice', 'Bob'],
  secondary_users: ['Carol'],
  tertiary_users: ['Dave'],
};

const accounts: Record<string, AccountV2> = {
  house1: explicitAccount,
  house2: { primary_users: ['Dave'] },
};

const accessTokens: Record<string, string> = {
  'token-one': 'house1',
  'token-two': 'house2',
  'token-orphan': 'gone',
};

test('accountForToken matches by exact token only', () => {
  assert.deepEqual(accountForToken(accessTokens, accounts, 'token-one'), {
    accountKey: 'house1',
    account: explicitAccount,
  });
  assert.equal(accountForToken(accessTokens, accounts, 'token-ONE'), null);
  assert.equal(accountForToken(accessTokens, accounts, 'nope'), null);
  assert.equal(accountForToken(accessTokens, accounts, ''), null);
  assert.equal(accountForToken(accessTokens, accounts, undefined), null);
  // A token whose account_key no longer exists never authenticates.
  assert.equal(accountForToken(accessTokens, accounts, 'token-orphan'), null);
});

test('resolveAccountTiers keeps explicit lists in config order', () => {
  const tiers = resolveAccountTiers(
    { primary_users: ['Bob', 'Alice'], secondary_users: ['Carol'], tertiary_users: ['Dave'] },
    allNames,
    users,
  );
  assert.deepEqual(tiers.primary, ['Bob', 'Alice']);
  assert.deepEqual(tiers.secondary, ['Carol']);
  assert.deepEqual(tiers.tertiary, ['Dave']);
});

test('resolveAccountTiers: omitted primary is empty, never a wildcard', () => {
  const tiers = resolveAccountTiers(
    { secondary_users: ['Carol'], tertiary_users: [] },
    allNames,
    users,
  );
  assert.deepEqual(tiers.primary, []);
});

test('resolveAccountTiers: secondary wildcard = all live users minus primaries minus explicit tertiaries, Jellyfin order', () => {
  const tiers = resolveAccountTiers(
    { primary_users: ['Bob'], tertiary_users: ['Dave'] },
    allNames,
    users,
  );
  // Eve is a live Jellyfin user NOT in users[] — wildcards still include her.
  assert.deepEqual(tiers.secondary, ['Alice', 'Carol', 'Eve']);
  // With every live user claimed by primary/secondary/explicit-tertiary,
  // nothing is left over for the tertiary wildcard to add.
  assert.deepEqual(tiers.tertiary, ['Dave']);
});

test('resolveAccountTiers: tertiary wildcard = leftover after primaries + secondaries, pin-filtered', () => {
  const tiers = resolveAccountTiers(
    { primary_users: ['Alice'], secondary_users: ['Bob'] },
    allNames,
    users,
  );
  // Leftover = Carol, Dave, Eve; Eve has no configured pin (not even a users[]
  // entry) so she can never be added as a guest.
  assert.deepEqual(tiers.tertiary, ['Carol', 'Dave']);
});

test('resolveAccountTiers: explicit [] means none (no wildcard)', () => {
  const tiers = resolveAccountTiers(
    { primary_users: ['Alice'], secondary_users: [], tertiary_users: [] },
    allNames,
    users,
  );
  assert.deepEqual(tiers.secondary, []);
  assert.deepEqual(tiers.tertiary, []);
});

test('resolveAccountTiers: precedence primary > secondary > tertiary across explicit lists', () => {
  const tiers = resolveAccountTiers(
    {
      primary_users: ['Alice'],
      secondary_users: ['Alice', 'Carol'],
      tertiary_users: ['Carol', 'Dave'],
    },
    allNames,
    users,
  );
  assert.deepEqual(tiers.primary, ['Alice']);
  assert.deepEqual(tiers.secondary, ['Carol']);
  assert.deepEqual(tiers.tertiary, ['Dave']);
});

test('resolveAccountTiers: explicit tertiary without a configured pin is excluded', () => {
  const tiers = resolveAccountTiers(
    { primary_users: ['Alice'], secondary_users: ['Carol'], tertiary_users: ['Bob', 'Dave', 'Eve'] },
    allNames,
    users,
  );
  // Bob is in users[] but has no pin; Eve has no users[] entry at all.
  assert.deepEqual(tiers.tertiary, ['Dave']);
});

test('resolveAccountTiers skips unknown Jellyfin names in explicit lists', () => {
  const tiers = resolveAccountTiers(
    { primary_users: ['Alice', 'Ghost'], secondary_users: ['Phantom', 'Carol'], tertiary_users: ['Dave'] },
    allNames,
    users,
  );
  assert.deepEqual(tiers.primary, ['Alice']);
  assert.deepEqual(tiers.secondary, ['Carol']);
});

test('visibleViewersForAccount orders primaries, secondaries, then tertiaries with tiers', () => {
  const visible = visibleViewersForAccount(explicitAccount, viewersByName, users);
  assert.deepEqual(
    visible.map((viewer) => [viewer.name, viewer.tier, viewer.pinRequired]),
    [
      ['Alice', 'primary', false],
      ['Bob', 'primary', false],
      ['Carol', 'secondary', false],
      ['Dave', 'tertiary', true],
    ],
  );
});

test('visibleViewersForAccount resolves wildcards against the whole viewer map', () => {
  const visible = visibleViewersForAccount({ primary_users: ['Dave'] }, viewersByName, users);
  // Secondary wildcard picks up everyone else — including the unconfigured Eve.
  assert.deepEqual(
    visible.map((viewer) => [viewer.name, viewer.tier]),
    [
      ['Dave', 'primary'],
      ['Alice', 'secondary'],
      ['Bob', 'secondary'],
      ['Carol', 'secondary'],
      ['Eve', 'secondary'],
    ],
  );
});

test('verifyPartyPins requires the correct pin exactly for tertiary members', () => {
  const carol = viewersByName.Carol;
  const dave = viewersByName.Dave;

  // house1: Dave is a guest (needs pin 2468); Carol is secondary (no pin).
  assert.deepEqual(
    verifyPartyPins(explicitAccount, users, allNames, [carol, dave], { d: '2468' }),
    { ok: true },
  );

  const missing = verifyPartyPins(explicitAccount, users, allNames, [carol, dave], {});
  assert.equal(missing.ok, false);
  assert.match((missing as { error: string }).error, /Dave/);

  const wrong = verifyPartyPins(explicitAccount, users, allNames, [carol, dave], { d: '0000' });
  assert.equal(wrong.ok, false);

  // Carol alone needs nothing — she is secondary for this account even though
  // she has a configured pin.
  assert.deepEqual(verifyPartyPins(explicitAccount, users, allNames, [carol], {}), { ok: true });
});

test('verifyPartyPins gates by the SELECTING account, not globally', () => {
  const dave = viewersByName.Dave;
  // house2: Dave is PRIMARY there, so no pin is needed even though he has one.
  assert.deepEqual(verifyPartyPins(accounts.house2, users, allNames, [dave], {}), { ok: true });
});

// The shared verdict behind /api/party, /api/party/verify-pins and
// /api/player/session (and their /api/group* compatibility aliases). It is
// pure (verify-only by construction): it takes no session or app state, so a
// verdict can never set an active party or persist a managed party — the
// verify-pins route just relays { status, error } / ok.
test('resolvePartyMemberSelection returns the 403 pin verdict for a wrong guest pin', () => {
  // house1: Dave ('d') is a guest whose configured pin is 2468.
  const wrong = resolvePartyMemberSelection(explicitAccount, viewersByName, users, ['a', 'd'], {
    d: '0000',
  });
  assert.equal(wrong.ok, false);
  assert.equal((wrong as { status: number }).status, 403);
  assert.match((wrong as { error: string }).error, /pin/i);

  const missing = resolvePartyMemberSelection(explicitAccount, viewersByName, users, ['a', 'd'], {});
  assert.equal(missing.ok, false);
  assert.equal((missing as { status: number }).status, 403);
});

test('resolvePartyMemberSelection resolves members for a correct guest pin', () => {
  const resolved = resolvePartyMemberSelection(explicitAccount, viewersByName, users, ['a', 'd'], {
    d: '2468',
  });
  assert.equal(resolved.ok, true);
  assert.deepEqual(
    (resolved as { members: { name: string }[] }).members.map((member) => member.name),
    ['Alice', 'Dave'],
  );
});

test('resolvePartyMemberSelection rejects member problems with a 400', () => {
  const empty = resolvePartyMemberSelection(explicitAccount, viewersByName, users, [], {});
  assert.equal(empty.ok, false);
  assert.equal((empty as { status: number }).status, 400);

  // 'z' is not a visible viewer for house1.
  const unknown = resolvePartyMemberSelection(explicitAccount, viewersByName, users, ['a', 'z'], {});
  assert.equal(unknown.ok, false);
  assert.equal((unknown as { status: number }).status, 400);
});
