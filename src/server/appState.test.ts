import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AppState } from './appState';

function tempStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gogglebox-state-test-'));
  return path.join(dir, 'nested', 'state.json');
}

test('getIgnoredItems returns empty when the state file does not exist', () => {
  const state = new AppState(tempStatePath());
  assert.deepEqual(state.getIgnoredItems('group-1'), []);
});

test('ignoreItem creates the file and persists per group', () => {
  const filePath = tempStatePath();
  const state = new AppState(filePath);

  state.ignoreItem('group-1', 'item-a');
  state.ignoreItem('group-1', 'item-b');
  state.ignoreItem('group-2', 'item-c');

  assert.ok(fs.existsSync(filePath));
  assert.deepEqual(state.getIgnoredItems('group-1').sort(), ['item-a', 'item-b']);
  assert.deepEqual(state.getIgnoredItems('group-2'), ['item-c']);
});

test('ignoreItem is idempotent for the same item', () => {
  const state = new AppState(tempStatePath());
  state.ignoreItem('group-1', 'item-a');
  state.ignoreItem('group-1', 'item-a');
  assert.deepEqual(state.getIgnoredItems('group-1'), ['item-a']);
});

test('unignoreItem removes the item and prunes empty groups', () => {
  const filePath = tempStatePath();
  const state = new AppState(filePath);
  state.ignoreItem('group-1', 'item-a');
  state.ignoreItem('group-1', 'item-b');

  state.unignoreItem('group-1', 'item-a');
  assert.deepEqual(state.getIgnoredItems('group-1'), ['item-b']);

  state.unignoreItem('group-1', 'item-b');
  assert.deepEqual(state.getIgnoredItems('group-1'), []);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { ignoredItems?: Record<string, string[]> };
  assert.equal(raw.ignoredItems?.['group-1'], undefined);
});

test('group aliases persist and read back, ignoring empty/blank aliases', () => {
  const filePath = tempStatePath();
  const state = new AppState(filePath);

  assert.equal(state.getGroupAlias('group-1'), undefined);

  state.setGroupAlias('group-1', 'Alice + Bob');
  assert.equal(state.getGroupAlias('group-1'), 'Alice + Bob');

  // An empty/blank alias is a no-op (never overwrites with garbage).
  state.setGroupAlias('group-1', '   ');
  assert.equal(state.getGroupAlias('group-1'), 'Alice + Bob');

  state.setGroupAlias('group-2', 'Carol');
  assert.deepEqual(state.getGroupAliases(), { 'group-1': 'Alice + Bob', 'group-2': 'Carol' });

  // Aliases coexist with other state (e.g. group player users) without clobbering.
  state.setGroupPlayerUser('group-1', 'jf-1', ['m-1', 'm-2']);
  assert.equal(state.getGroupAlias('group-1'), 'Alice + Bob');
  assert.deepEqual(state.getGroupPlayerUserId('group-1'), 'jf-1');
});

test('reads survive a corrupt state file by starting fresh', () => {
  const filePath = tempStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{ not valid json');
  const state = new AppState(filePath);
  assert.deepEqual(state.getIgnoredItems('group-1'), []);
});

test('reads a legacy ignoredShows-only file and migrates to ignoredItems on write', () => {
  const filePath = tempStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // A pre-rename state file carries only the legacy `ignoredShows` key.
  fs.writeFileSync(
    filePath,
    JSON.stringify({ ignoredShows: { 'group-1': ['legacy-a', 'legacy-b'] } }, null, 2),
  );
  const state = new AppState(filePath);

  // READ falls back to the legacy key with zero data loss.
  assert.deepEqual(state.getIgnoredItems('group-1').sort(), ['legacy-a', 'legacy-b']);

  // WRITE migrates: the new key carries the merged set; the legacy key is dropped.
  state.ignoreItem('group-1', 'new-c');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    ignoredItems?: Record<string, string[]>;
    ignoredShows?: Record<string, string[]>;
  };
  assert.equal(raw.ignoredShows, undefined);
  assert.deepEqual(raw.ignoredItems?.['group-1']?.slice().sort(), ['legacy-a', 'legacy-b', 'new-c']);
  assert.deepEqual(state.getIgnoredItems('group-1').sort(), ['legacy-a', 'legacy-b', 'new-c']);
});

function cachedConfig(overrides: Partial<{ sourceHash: string; builtForPackage: string }> = {}): {
  schemaVersion: number;
  builtForPackage: string;
  sourceHash: string;
  users: unknown[];
  accounts: unknown[];
  watchedThreshold: number;
  recommendationCount: number;
} {
  return {
    schemaVersion: 1,
    builtForPackage: '2026.6.29',
    sourceHash: 'hash-a',
    users: [{ jellyfin_name: 'Alice' }],
    accounts: [{ username: 'h', password: 'p', visible_users: [{ jellyfin_name: 'Alice' }] }],
    watchedThreshold: 0.9,
    recommendationCount: 8,
    ...overrides,
  };
}

test('effective config round-trips and is fresh for the same hash + package', () => {
  const state = new AppState(tempStatePath());
  state.setEffectiveConfig(cachedConfig());

  assert.equal(state.getEffectiveConfig()?.sourceHash, 'hash-a');
  assert.equal(state.isEffectiveConfigFresh('hash-a', '2026.6.29'), true);
});

test('effective config is stale when the source hash changed (user edited config.json)', () => {
  const state = new AppState(tempStatePath());
  state.setEffectiveConfig(cachedConfig());
  assert.equal(state.isEffectiveConfigFresh('hash-b', '2026.6.29'), false);
});

test('effective config is stale when the package version changed (new/rolled-back image)', () => {
  const state = new AppState(tempStatePath());
  state.setEffectiveConfig(cachedConfig());
  assert.equal(state.isEffectiveConfigFresh('hash-a', '2026.7.1'), false);
});

test('effective config is not fresh when nothing has been cached yet', () => {
  const state = new AppState(tempStatePath());
  assert.equal(state.getEffectiveConfig(), undefined);
  assert.equal(state.isEffectiveConfigFresh('hash-a', '2026.6.29'), false);
});
