import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildEffectiveConfig, resolveViewers, validateAndResolveConfig } from './config';
import { SchemaV1Config } from './configMigrations';
import { ConfigUser, FamilyMember } from './types';

const originalEnv = { ...process.env };
const originalCwd = process.cwd();

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function jellyfin(...names: string[]): FamilyMember[] {
  return names.map((name) => ({ id: `id-${name}`, jellyfinUserId: `id-${name}`, name, avatarUrl: null }));
}

// A minimal valid schemaVersion-1 config object.
function validV1Config(): unknown {
  return {
    schemaVersion: 1,
    playback: { watchedThreshold: 0.9 },
    recommendations: { count: 8 },
    users: [{ jellyfin_name: 'Alice', pin: '1234' }, { jellyfin_name: 'Bob' }],
    accounts: [
      { username: 'house1', password: 'pw1', visible_users: [{ jellyfin_name: 'Alice' }, { jellyfin_name: 'Bob' }] },
      { username: 'house2', password: 'pw2', visible_users: [{ jellyfin_name: 'Alice', pin_required: true }] },
    ],
  };
}

function setupWorkspace(config: unknown = validV1Config()): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gogglebox-config-test-'));
  writeJson(path.join(tempRoot, 'config.json'), config);
  return tempRoot;
}

test('buildEffectiveConfig reads a valid schemaVersion-1 config and stamps provenance', async () => {
  const workspace = setupWorkspace();

  try {
    process.chdir(workspace);
    process.env = { ...originalEnv, JELLYFIN_URL: 'https://example.test', JELLYFIN_API_KEY: 'key' };

    const { buildEffectiveConfig: build } = await import('./config.js');
    const effective = build({ jellyfinUsers: jellyfin('Alice', 'Bob'), warn: () => {} }, '2026.6.29');

    assert.equal(effective.users.length, 2);
    assert.equal(effective.accounts.length, 2);
    assert.equal(effective.schemaVersion, 1);
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

test('buildEffectiveConfig auto-migrates a legacy (no schemaVersion) config forward', async () => {
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

    assert.equal(effective.schemaVersion, 1);
    assert.deepEqual(effective.users.map((u) => u.jellyfin_name).sort(), ['Alice', 'Bob']);
    assert.equal(effective.accounts.length, 1);
    assert.equal(effective.accounts[0].username, 'house');
    assert.equal(effective.recommendationCount, 6);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function v1(config: Partial<SchemaV1Config>): SchemaV1Config {
  return { schemaVersion: 1, users: [], accounts: [], ...config };
}

test('validateAndResolveConfig drops a user with no Jellyfin match and cascades', () => {
  const warnings: string[] = [];
  const config = v1({
    users: [{ jellyfin_name: 'Alice' }, { jellyfin_name: 'Ghost' }],
    accounts: [
      { username: 'h', password: 'p', visible_users: [{ jellyfin_name: 'Alice' }, { jellyfin_name: 'Ghost' }] },
    ],
  });

  const { users, accounts } = validateAndResolveConfig(config, jellyfin('Alice'), (m) => warnings.push(m));

  assert.deepEqual(users.map((u) => u.jellyfin_name), ['Alice']);
  assert.deepEqual(accounts[0].visible_users.map((v) => v.jellyfin_name), ['Alice']);
  assert.ok(warnings.some((w) => /Ghost/.test(w)));
});

test('validateAndResolveConfig drops an account left with no visible users', () => {
  const warnings: string[] = [];
  const config = v1({
    users: [{ jellyfin_name: 'Alice' }],
    accounts: [
      { username: 'keep', password: 'p', visible_users: [{ jellyfin_name: 'Alice' }] },
      { username: 'empty', password: 'p', visible_users: [{ jellyfin_name: 'Ghost' }] },
    ],
  });

  const { accounts } = validateAndResolveConfig(config, jellyfin('Alice'), (m) => warnings.push(m));

  assert.deepEqual(accounts.map((a) => a.username), ['keep']);
  assert.ok(warnings.some((w) => /dropped account "empty"/.test(w)));
});

test('validateAndResolveConfig fails fast only when the result is unusable', () => {
  const noUsers = v1({ users: [{ jellyfin_name: 'Ghost' }], accounts: [] });
  assert.throws(() => validateAndResolveConfig(noUsers, jellyfin('Alice'), () => {}), /no users resolved/);

  const noAccounts = v1({
    users: [{ jellyfin_name: 'Alice' }],
    accounts: [{ username: 'x', password: 'p', visible_users: [{ jellyfin_name: 'Ghost' }] }],
  });
  assert.throws(() => validateAndResolveConfig(noAccounts, jellyfin('Alice'), () => {}), /no login accounts/);
});

test('validateAndResolveConfig downgrades pin_required when the user has no pin', () => {
  const config = v1({
    users: [{ jellyfin_name: 'Alice' }],
    accounts: [{ username: 'h', password: 'p', visible_users: [{ jellyfin_name: 'Alice', pin_required: true }] }],
  });

  const { accounts } = validateAndResolveConfig(config, jellyfin('Alice'), () => {});
  assert.equal(accounts[0].visible_users[0].pin_required, false);
});

test('resolveViewers maps names to Jellyfin viewers and skips a missing name', () => {
  const users: ConfigUser[] = [{ jellyfin_name: 'Alice' }, { jellyfin_name: 'Bob' }];
  const map = resolveViewers(users, jellyfin('Alice', 'Bob'));
  assert.equal(map.Alice.jellyfinUserId, 'id-Alice');
  assert.equal(map.Bob.jellyfinUserId, 'id-Bob');

  const partial = resolveViewers([{ jellyfin_name: 'Nobody' }], jellyfin('Alice'));
  assert.deepEqual(Object.keys(partial), []);
});

test.after(() => {
  process.chdir(originalCwd);
  process.env = originalEnv;
});
