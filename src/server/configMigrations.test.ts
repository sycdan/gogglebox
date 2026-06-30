import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_SCHEMA_VERSION,
  MigrationContext,
  deepMergeConfig,
  detectSchemaVersion,
  hashRawConfig,
  migrate0to1,
  runMigrationChain,
} from './configMigrations';

function ctx(overrides: Partial<MigrationContext> = {}): MigrationContext {
  return {
    jellyfinUsers: [
      { id: 'uuid-a', name: 'Alice' },
      { id: 'uuid-b', name: 'Bob' },
      { id: 'uuid-c', name: 'Carol' },
    ],
    warn: () => {},
    ...overrides,
  };
}

test('detectSchemaVersion: missing or invalid => 0', () => {
  assert.equal(detectSchemaVersion({}), 0);
  assert.equal(detectSchemaVersion({ schemaVersion: 'x' }), 0);
  assert.equal(detectSchemaVersion({ schemaVersion: -1 }), 0);
  assert.equal(detectSchemaVersion({ schemaVersion: 1 }), 1);
});

test('migrate0to1 maps member UUIDs to Jellyfin names and unions them into users[]', () => {
  const legacy = {
    household: { username: 'house', password: 'pw' },
    groups: [
      { id: 'all', name: 'Everyone', memberIds: ['uuid-a', 'uuid-b'] },
      { id: 'parents', name: 'Parents', memberIds: ['uuid-a'] },
    ],
  };

  const result = migrate0to1(legacy, ctx());

  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.users.map((u) => u.jellyfin_name), ['Alice', 'Bob']);
  assert.equal(result.users.every((u) => u.pin === undefined), true);
});

test('migrate0to1 synthesizes one account from the household creds (all users visible)', () => {
  const legacy = {
    household: { username: 'house', password: 'pw' },
    groups: [{ id: 'all', memberIds: ['uuid-a', 'uuid-b'] }],
  };

  const result = migrate0to1(legacy, ctx());

  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].username, 'house');
  assert.equal(result.accounts[0].password, 'pw');
  assert.deepEqual(
    result.accounts[0].visible_users.map((v) => v.jellyfin_name),
    ['Alice', 'Bob'],
  );
  assert.equal(result.accounts[0].visible_users.every((v) => !v.pin_required), true);
});

test('migrate0to1 falls back to PORTAL_* creds when there is no household', () => {
  const legacy = { groups: [{ memberIds: ['uuid-a'] }] };
  const result = migrate0to1(legacy, ctx({ portalUsername: 'portal', portalPassword: 'ppw' }));

  assert.equal(result.accounts[0].username, 'portal');
  assert.equal(result.accounts[0].password, 'ppw');
});

test('migrate0to1 synthesizes a default account (and warns) with no creds at all', () => {
  const warnings: string[] = [];
  const legacy = { groups: [{ memberIds: ['uuid-a'] }] };
  const result = migrate0to1(legacy, ctx({ warn: (m) => warnings.push(m) }));

  assert.equal(result.accounts[0].username, 'household');
  assert.ok(warnings.some((w) => /default account/.test(w)));
});

test('migrate0to1 skips + warns on an unmapped UUID', () => {
  const warnings: string[] = [];
  const legacy = { household: { username: 'h', password: 'p' }, groups: [{ memberIds: ['uuid-a', 'uuid-zzz'] }] };
  const result = migrate0to1(legacy, ctx({ warn: (m) => warnings.push(m) }));

  assert.deepEqual(result.users.map((u) => u.jellyfin_name), ['Alice']);
  assert.ok(warnings.some((w) => /uuid-zzz/.test(w)));
});

test('migrate0to1 carries over playback/recommendations and drops obsolete groups[] (warns)', () => {
  const warnings: string[] = [];
  const legacy = {
    household: { username: 'h', password: 'p' },
    playback: { watchedThreshold: 0.8 },
    recommendations: { count: 12 },
    groups: [{ memberIds: ['uuid-a'] }],
  };
  const result = migrate0to1(legacy, ctx({ warn: (m) => warnings.push(m) }));

  assert.equal(result.playback?.watchedThreshold, 0.8);
  assert.equal(result.recommendations?.count, 12);
  assert.ok(warnings.some((w) => /groups\[\] presets/.test(w)));
  assert.equal('groups' in result, false);
});

test('runMigrationChain starts at the source version and stops when no next migration', () => {
  const legacy = { household: { username: 'h', password: 'p' }, groups: [{ memberIds: ['uuid-a'] }] };
  const result = runMigrationChain(legacy, ctx());

  assert.equal(result.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(result.users.map((u) => u.jellyfin_name), ['Alice']);
});

test('runMigrationChain leaves an already-current config unchanged', () => {
  const current = {
    schemaVersion: 1,
    users: [{ jellyfin_name: 'Alice' }],
    accounts: [{ username: 'h', password: 'p', visible_users: [{ jellyfin_name: 'Alice' }] }],
  };
  const result = runMigrationChain(current, ctx());

  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.users, [{ jellyfin_name: 'Alice' }]);
});

test('runMigrationChain fails fast when the source schema is newer than the image', () => {
  assert.throws(
    () => runMigrationChain({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }, ctx()),
    /newer than this image supports/,
  );
});

test('hashRawConfig: stable for same input, differs on change (cache invalidation)', () => {
  const a = hashRawConfig('{"schemaVersion":1}');
  const b = hashRawConfig('{"schemaVersion":1}');
  const c = hashRawConfig('{"schemaVersion":1,"x":2}');

  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('deepMergeConfig merges plain objects and replaces arrays wholesale', () => {
  const base = {
    playback: { watchedThreshold: 0.9 },
    recommendations: { count: 8 },
    users: [{ jellyfin_name: 'Default' }],
  };
  const override = {
    playback: { watchedThreshold: 0.7 },
    users: [{ jellyfin_name: 'Alice' }],
  };

  const merged = deepMergeConfig(base, override);
  assert.equal(merged.playback.watchedThreshold, 0.7);
  assert.equal(merged.recommendations.count, 8);
  assert.deepEqual(merged.users, [{ jellyfin_name: 'Alice' }]);
});
