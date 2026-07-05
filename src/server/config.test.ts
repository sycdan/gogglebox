import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveViewers, validateAndResolveConfig } from './config';
import { SchemaV2Config } from './configMigrations';
import { FamilyMember } from './types';

const originalEnv = { ...process.env };
const originalCwd = process.cwd();

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function jellyfin(...names: string[]): FamilyMember[] {
  return names.map((name) => ({ id: `id-${name}`, jellyfinUserId: `id-${name}`, name, avatarUrl: null }));
}

// A minimal valid schemaVersion-2 config object.
function validV2Config(): unknown {
  return {
    schemaVersion: 2,
    playback: { watchedThreshold: 0.9 },
    recommendations: { count: 8 },
    users: [{ jellyfin_name: 'Alice', pin: '1234' }, { jellyfin_name: 'Bob' }],
    accounts: {
      house1: { primary_users: ['Alice'], secondary_users: ['Bob'], tertiary_users: [] },
      house2: { primary_users: ['Bob'] },
    },
    access_tokens: {
      'token-1': 'house1',
      'token-2': 'house2',
    },
  };
}

function setupWorkspace(config: unknown = validV2Config()): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gogglebox-config-test-'));
  writeJson(path.join(tempRoot, 'config.json'), config);
  return tempRoot;
}

test('buildEffectiveConfig reads a valid schemaVersion-2 config and stamps provenance', async () => {
  const workspace = setupWorkspace();

  try {
    process.chdir(workspace);
    process.env = { ...originalEnv, JELLYFIN_URL: 'https://example.test', JELLYFIN_API_KEY: 'key' };

    const { buildEffectiveConfig: build } = await import('./config.js');
    const effective = build({ jellyfinUsers: jellyfin('Alice', 'Bob'), warn: () => {} }, '2026.6.29');

    assert.equal(effective.users.length, 2);
    assert.deepEqual(Object.keys(effective.accounts).sort(), ['house1', 'house2']);
    assert.deepEqual(effective.accessTokens, { 'token-1': 'house1', 'token-2': 'house2' });
    assert.equal(effective.schemaVersion, 2);
    assert.equal(effective.builtForPackage, '2026.6.29');
    assert.equal(typeof effective.sourceHash, 'string');
    assert.equal(effective.recommendationCount, 8);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildEffectiveConfig throws a clear error when config.json is missing', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gogglebox-config-test-'));

  try {
    process.chdir(workspace);
    process.env = { ...originalEnv, JELLYFIN_URL: 'https://example.test', JELLYFIN_API_KEY: 'key' };

    const { buildEffectiveConfig: build } = await import('./config.js');
    assert.throws(
      () => build({ jellyfinUsers: jellyfin('Alice'), warn: () => {} }, '0.0.0'),
      /Missing required config file:.*config\.json/,
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildEffectiveConfig auto-migrates a schemaVersion-1 config forward to v2', async () => {
  const v1 = {
    schemaVersion: 1,
    users: [{ jellyfin_name: 'Alice', pin: '1234' }, { jellyfin_name: 'Bob' }],
    accounts: [
      {
        username: 'house1',
        password: 'pw1',
        visible_users: [{ jellyfin_name: 'Alice', pin_required: true }, { jellyfin_name: 'Bob' }],
      },
    ],
  };
  const workspace = setupWorkspace(v1);

  try {
    process.chdir(workspace);
    process.env = { ...originalEnv, JELLYFIN_URL: 'https://example.test', JELLYFIN_API_KEY: 'key' };

    const { buildEffectiveConfig: build } = await import('./config.js');
    const effective = build({ jellyfinUsers: jellyfin('Alice', 'Bob'), warn: () => {} }, '0.0.0');

    assert.equal(effective.schemaVersion, 2);
    // pin_required Alice -> tertiary; plain Bob -> secondary; explicit lists.
    assert.deepEqual(effective.accounts.house1, {
      primary_users: [],
      secondary_users: ['Bob'],
      tertiary_users: ['Alice'],
    });
    // The v1 password becomes the login token.
    assert.deepEqual(effective.accessTokens, { pw1: 'house1' });
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildEffectiveConfig auto-migrates a legacy (no schemaVersion) config through 0 -> 1 -> 2', async () => {
  const legacy = {
    household: { username: 'house', password: 'pw' },
    groups: [{ id: 'all', name: 'Everyone', memberIds: ['id-Alice', 'id-Bob'] }],
    recommendations: { count: 6 },
  };
  const workspace = setupWorkspace(legacy);

  try {
    process.chdir(workspace);
    process.env = { ...originalEnv, JELLYFIN_URL: 'https://example.test', JELLYFIN_API_KEY: 'key' };

    const { buildEffectiveConfig: build } = await import('./config.js');
    const effective = build({ jellyfinUsers: jellyfin('Alice', 'Bob'), warn: () => {} }, '0.0.0');

    assert.equal(effective.schemaVersion, 2);
    assert.deepEqual(effective.users.map((u) => u.jellyfin_name).sort(), ['Alice', 'Bob']);
    assert.deepEqual(effective.accounts.house, {
      primary_users: [],
      secondary_users: ['Alice', 'Bob'],
      tertiary_users: [],
    });
    assert.deepEqual(effective.accessTokens, { pw: 'house' });
    assert.equal(effective.recommendationCount, 6);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// AC3: a legacy config spelled with the current "party" terminology
// (`parties[]` instead of `groups[]`) auto-migrates identically, with no
// manual migration step.
test('buildEffectiveConfig auto-migrates a legacy config using parties[] (party terminology alias) through 0 -> 1 -> 2', async () => {
  const legacy = {
    household: { username: 'house', password: 'pw' },
    parties: [{ id: 'all', name: 'Everyone', memberIds: ['id-Alice', 'id-Bob'] }],
    recommendations: { count: 6 },
  };
  const workspace = setupWorkspace(legacy);

  try {
    process.chdir(workspace);
    process.env = { ...originalEnv, JELLYFIN_URL: 'https://example.test', JELLYFIN_API_KEY: 'key' };

    const { buildEffectiveConfig: build } = await import('./config.js');
    const effective = build({ jellyfinUsers: jellyfin('Alice', 'Bob'), warn: () => {} }, '0.0.0');

    assert.equal(effective.schemaVersion, 2);
    assert.deepEqual(effective.users.map((u) => u.jellyfin_name).sort(), ['Alice', 'Bob']);
    assert.deepEqual(effective.accounts.house, {
      primary_users: [],
      secondary_users: ['Alice', 'Bob'],
      tertiary_users: [],
    });
    assert.deepEqual(effective.accessTokens, { pw: 'house' });
    assert.equal(effective.recommendationCount, 6);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function v2(config: Partial<SchemaV2Config>): SchemaV2Config {
  return { schemaVersion: 2, users: [], accounts: {}, access_tokens: {}, ...config };
}

test('validateAndResolveConfig drops a user with no Jellyfin match (warn)', () => {
  const warnings: string[] = [];
  const config = v2({
    users: [{ jellyfin_name: 'Alice' }, { jellyfin_name: 'Ghost' }],
    accounts: { h: { primary_users: ['Alice'] } },
    access_tokens: { t: 'h' },
  });

  const { users } = validateAndResolveConfig(config, jellyfin('Alice'), (m) => warnings.push(m));

  assert.deepEqual(users.map((u) => u.jellyfin_name), ['Alice']);
  assert.ok(warnings.some((w) => /Ghost/.test(w)));
});

test('validateAndResolveConfig drops unknown Jellyfin names from explicit tier lists (warn)', () => {
  const warnings: string[] = [];
  const config = v2({
    accounts: {
      h: { primary_users: ['Alice', 'Ghost'], secondary_users: ['Phantom'], tertiary_users: [] },
    },
    access_tokens: { t: 'h' },
  });

  const { accounts } = validateAndResolveConfig(config, jellyfin('Alice'), (m) => warnings.push(m));

  assert.deepEqual(accounts.h.primary_users, ['Alice']);
  assert.deepEqual(accounts.h.secondary_users, []);
  assert.ok(warnings.some((w) => /Ghost/.test(w)));
  assert.ok(warnings.some((w) => /Phantom/.test(w)));
});

test('validateAndResolveConfig keeps the highest tier when a name appears in multiple explicit lists (warn)', () => {
  const warnings: string[] = [];
  const config = v2({
    users: [{ jellyfin_name: 'Bob', pin: '99' }],
    accounts: {
      h: {
        primary_users: ['Alice'],
        secondary_users: ['Alice', 'Bob'],
        tertiary_users: ['Bob'],
      },
    },
    access_tokens: { t: 'h' },
  });

  const { accounts } = validateAndResolveConfig(config, jellyfin('Alice', 'Bob'), (m) => warnings.push(m));

  assert.deepEqual(accounts.h.primary_users, ['Alice']);
  assert.deepEqual(accounts.h.secondary_users, ['Bob']);
  assert.deepEqual(accounts.h.tertiary_users, []);
  assert.ok(warnings.some((w) => /multiple tiers|both primary and secondary/.test(w)));
});

test('validateAndResolveConfig warns about an explicit tertiary with no configured pin', () => {
  const warnings: string[] = [];
  const config = v2({
    users: [{ jellyfin_name: 'Alice' }],
    accounts: { h: { primary_users: ['Alice'], secondary_users: [], tertiary_users: ['Bob'] } },
    access_tokens: { t: 'h' },
  });

  validateAndResolveConfig(config, jellyfin('Alice', 'Bob'), (m) => warnings.push(m));

  assert.ok(warnings.some((w) => /"Bob" has no pin/.test(w)));
});

test('validateAndResolveConfig preserves wildcard (null/omitted) tier lists', () => {
  const config = v2({
    accounts: { h: { primary_users: ['Alice'], secondary_users: null } },
    access_tokens: { t: 'h' },
  });

  const { accounts } = validateAndResolveConfig(config, jellyfin('Alice', 'Bob'), () => {});

  // null/omitted stays null so the WILDCARD resolves live at request time.
  assert.equal(accounts.h.secondary_users, null);
  assert.equal(accounts.h.tertiary_users, null);
});

test('validateAndResolveConfig drops an account whose resolved tiers are all empty (warn)', () => {
  const warnings: string[] = [];
  const config = v2({
    accounts: {
      keep: { primary_users: ['Alice'] },
      empty: { primary_users: ['Ghost'], secondary_users: [], tertiary_users: [] },
    },
    access_tokens: { 'token-keep': 'keep', 'token-empty': 'empty' },
  });

  const { accounts, accessTokens } = validateAndResolveConfig(config, jellyfin('Alice'), (m) => warnings.push(m));

  assert.deepEqual(Object.keys(accounts), ['keep']);
  // The dropped account's token cascades away too.
  assert.deepEqual(accessTokens, { 'token-keep': 'keep' });
  assert.ok(warnings.some((w) => /dropped account "empty"/.test(w)));
});

test('validateAndResolveConfig drops an access token pointing at a missing account (warn)', () => {
  const warnings: string[] = [];
  const config = v2({
    accounts: { h: { primary_users: ['Alice'] } },
    access_tokens: { good: 'h', orphan: 'gone' },
  });

  const { accessTokens } = validateAndResolveConfig(config, jellyfin('Alice'), (m) => warnings.push(m));

  assert.deepEqual(accessTokens, { good: 'h' });
  assert.ok(warnings.some((w) => /unknown account "gone"/.test(w)));
});

test('validateAndResolveConfig warns about an account with no access token (unreachable)', () => {
  const warnings: string[] = [];
  const config = v2({
    accounts: { reachable: { primary_users: ['Alice'] }, lonely: { primary_users: ['Alice'] } },
    access_tokens: { t: 'reachable' },
  });

  const { accounts } = validateAndResolveConfig(config, jellyfin('Alice'), (m) => warnings.push(m));

  // Kept (a token can be added later) but warned about.
  assert.deepEqual(Object.keys(accounts).sort(), ['lonely', 'reachable']);
  assert.ok(warnings.some((w) => /"lonely" has no access token/.test(w)));
});

test('validateAndResolveConfig fails fast only when the result is unusable', () => {
  const noAccounts = v2({
    accounts: { empty: { primary_users: ['Ghost'], secondary_users: [], tertiary_users: [] } },
    access_tokens: { t: 'empty' },
  });
  assert.throws(() => validateAndResolveConfig(noAccounts, jellyfin('Alice'), () => {}), /no accounts remain/);

  const noTokens = v2({
    accounts: { h: { primary_users: ['Alice'] } },
    access_tokens: { t: 'gone' },
  });
  assert.throws(() => validateAndResolveConfig(noTokens, jellyfin('Alice'), () => {}), /no access tokens remain/);
});

test('resolveViewers maps ALL live Jellyfin users, in Jellyfin list order', () => {
  const map = resolveViewers(jellyfin('Alice', 'Bob', 'Eve'));
  // Eve has no users[] entry, but wildcard tiers may include her — the viewer
  // map covers the whole live universe.
  assert.deepEqual(Object.keys(map), ['Alice', 'Bob', 'Eve']);
  assert.equal(map.Alice.jellyfinUserId, 'id-Alice');
  assert.equal(map.Eve.jellyfinUserId, 'id-Eve');
});

test.after(() => {
  process.chdir(originalCwd);
  process.env = originalEnv;
});
