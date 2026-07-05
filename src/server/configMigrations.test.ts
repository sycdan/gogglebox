import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_SCHEMA_VERSION,
  MigrationContext,
  SchemaV1Config,
  deepMergeConfig,
  detectSchemaVersion,
  hashRawConfig,
  migrate0to1,
  migrate1to2,
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
  assert.ok(warnings.some((w) => /groups\[\]\/parties\[\] presets/.test(w)));
  assert.equal('groups' in result, false);
});

// ── Party terminology alias (AC3: parties[] is accepted wherever groups[] was) ──

test('migrate0to1 accepts parties[] as an alias for the legacy groups[] preset list', () => {
  const legacy = {
    household: { username: 'house', password: 'pw' },
    parties: [{ id: 'all', name: 'Everyone', memberIds: ['uuid-a', 'uuid-b'] }],
  };

  const result = migrate0to1(legacy, ctx());

  assert.deepEqual(result.users.map((u) => u.jellyfin_name), ['Alice', 'Bob']);
});

test('migrate0to1 prefers parties[] over groups[] when both are present', () => {
  const legacy = {
    household: { username: 'house', password: 'pw' },
    parties: [{ memberIds: ['uuid-a'] }],
    groups: [{ memberIds: ['uuid-b'] }],
  };

  const result = migrate0to1(legacy, ctx());

  assert.deepEqual(result.users.map((u) => u.jellyfin_name), ['Alice']);
});

test('migrate0to1 warns about dropped parties[] presets using party terminology', () => {
  const warnings: string[] = [];
  const legacy = {
    household: { username: 'h', password: 'p' },
    parties: [{ memberIds: ['uuid-a'] }],
  };
  migrate0to1(legacy, ctx({ warn: (m) => warnings.push(m) }));

  assert.ok(warnings.some((w) => /groups\[\]\/parties\[\] presets/.test(w) && /parties are now formed/.test(w)));
});

// ── Migration 1 -> 2 ────────────────────────────────────────────────────────

function v1Config(overrides: Partial<SchemaV1Config> = {}): SchemaV1Config {
  return {
    schemaVersion: 1,
    users: [
      { jellyfin_name: 'Alice', pin: '1234' },
      { jellyfin_name: 'Bob' },
    ],
    accounts: [
      {
        username: 'house1',
        password: 'pw1',
        visible_users: [
          { jellyfin_name: 'Alice', pin_required: true },
          { jellyfin_name: 'Bob' },
        ],
      },
    ],
    ...overrides,
  };
}

test('migrate1to2 maps account_key = username and access token = password', () => {
  const result = migrate1to2(v1Config() as unknown as Record<string, unknown>, ctx());

  assert.equal(result.schemaVersion, 2);
  assert.deepEqual(Object.keys(result.accounts), ['house1']);
  assert.deepEqual(result.access_tokens, { pw1: 'house1' });
});

test('migrate1to2 maps pin_required visible users to tertiary, others to secondary, primaries empty', () => {
  const result = migrate1to2(v1Config() as unknown as Record<string, unknown>, ctx());

  assert.deepEqual(result.accounts.house1, {
    primary_users: [],
    secondary_users: ['Bob'],
    tertiary_users: ['Alice'],
  });
});

test('migrate1to2 writes ALL THREE tier lists explicitly so wildcards cannot widen v1 visibility', () => {
  const config = v1Config({
    accounts: [{ username: 'narrow', password: 'pw', visible_users: [{ jellyfin_name: 'Alice' }] }],
  });
  const result = migrate1to2(config as unknown as Record<string, unknown>, ctx());

  const account = result.accounts.narrow;
  // Explicit arrays (never undefined/null): omitted lists would be WILDCARDS
  // in v2 and let this account see users the v1 config never granted.
  assert.deepEqual(account.primary_users, []);
  assert.deepEqual(account.secondary_users, ['Alice']);
  assert.deepEqual(account.tertiary_users, []);
});

test('migrate1to2 de-duplicates a repeated password into a unique token (warns)', () => {
  const warnings: string[] = [];
  const config = v1Config({
    accounts: [
      { username: 'first', password: 'same-pw', visible_users: [{ jellyfin_name: 'Alice' }] },
      { username: 'second', password: 'same-pw', visible_users: [{ jellyfin_name: 'Bob' }] },
    ],
  });
  const result = migrate1to2(
    config as unknown as Record<string, unknown>,
    ctx({ warn: (m) => warnings.push(m) }),
  );

  assert.deepEqual(result.access_tokens, {
    'same-pw': 'first',
    'same-pw-second': 'second',
  });
  assert.ok(warnings.some((w) => /same-pw-second/.test(w)));
});

test('migrate1to2 rechecks duplicate-password fallback tokens before assigning them', () => {
  const warnings: string[] = [];
  const config = v1Config({
    accounts: [
      { username: 'first', password: 'same-pw', visible_users: [{ jellyfin_name: 'Alice' }] },
      { username: 'second', password: 'same-pw-third', visible_users: [{ jellyfin_name: 'Bob' }] },
      { username: 'third', password: 'same-pw', visible_users: [{ jellyfin_name: 'Carol' }] },
    ],
  });
  const result = migrate1to2(
    config as unknown as Record<string, unknown>,
    ctx({ warn: (m) => warnings.push(m) }),
  );

  assert.deepEqual(result.access_tokens, {
    'same-pw': 'first',
    'same-pw-third': 'second',
    'same-pw-third-2': 'third',
  });
  assert.equal(result.access_tokens['same-pw'], 'first');
  assert.equal(result.access_tokens['same-pw-third'], 'second');
  assert.equal(result.access_tokens['same-pw-third-2'], 'third');
  assert.ok(
    warnings.some(
      (w) =>
        /account "third"/.test(w) &&
        /same-pw-third-2/.test(w) &&
        /fallback "same-pw-third"/.test(w),
    ),
  );
});

test('migrate1to2 carries users/playback/recommendations through unchanged', () => {
  const config = v1Config({
    playback: { watchedThreshold: 0.8 },
    recommendations: { count: 12 },
  });
  const result = migrate1to2(config as unknown as Record<string, unknown>, ctx());

  assert.deepEqual(result.users, [
    { jellyfin_name: 'Alice', pin: '1234' },
    { jellyfin_name: 'Bob' },
  ]);
  assert.equal(result.playback?.watchedThreshold, 0.8);
  assert.equal(result.recommendations?.count, 12);
});

// ── Chain ───────────────────────────────────────────────────────────────────

test('runMigrationChain walks a 0-source config through 0 -> 1 -> 2', () => {
  const legacy = { household: { username: 'h', password: 'p' }, groups: [{ memberIds: ['uuid-a'] }] };
  const result = runMigrationChain(legacy, ctx());

  assert.equal(result.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(result.users.map((u) => u.jellyfin_name), ['Alice']);
  // The synthesized v1 household account becomes a v2 account keyed by its
  // username, reachable via its password-as-token.
  assert.deepEqual(result.accounts.h, {
    primary_users: [],
    secondary_users: ['Alice'],
    tertiary_users: [],
  });
  assert.deepEqual(result.access_tokens, { p: 'h' });
});

test('runMigrationChain leaves an already-current config unchanged', () => {
  const current = {
    schemaVersion: 2,
    users: [{ jellyfin_name: 'Alice' }],
    accounts: { house1: { primary_users: ['Alice'] } },
    access_tokens: { 'token-1': 'house1' },
  };
  const result = runMigrationChain(current, ctx());

  assert.equal(result.schemaVersion, 2);
  assert.deepEqual(result.users, [{ jellyfin_name: 'Alice' }]);
  assert.deepEqual(result.accounts, { house1: { primary_users: ['Alice'] } });
  assert.deepEqual(result.access_tokens, { 'token-1': 'house1' });
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
