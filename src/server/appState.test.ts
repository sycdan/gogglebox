import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AppState, IgnoreEntry } from './appState';

function tempStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gogglebox-state-test-'));
  return path.join(dir, 'nested', 'state.json');
}

function keys(entries: IgnoreEntry[]): string[] {
  return entries.map((entry) => entry.key);
}

test('getIgnoreEntries returns empty when the state file does not exist', () => {
  const state = new AppState(tempStatePath());
  assert.deepEqual(state.getIgnoreEntries('group-1'), []);
});

test('ignoreItem creates the file and persists per group', () => {
  const filePath = tempStatePath();
  const state = new AppState(filePath);

  state.ignoreItem('group-1', { key: 'item-a', matchSeriesId: false, label: 'Item A' });
  state.ignoreItem('group-1', { key: 'item-b', matchSeriesId: true, label: 'Item B' });
  state.ignoreItem('group-2', { key: 'item-c', matchSeriesId: false, label: 'Item C' });

  assert.ok(fs.existsSync(filePath));
  assert.deepEqual(keys(state.getIgnoreEntries('group-1')).sort(), ['item-a', 'item-b']);
  assert.deepEqual(keys(state.getIgnoreEntries('group-2')), ['item-c']);
});

test('getIgnoreEntries orders most-recent-first, and re-ignoring the same key bumps it to the top', async () => {
  const state = new AppState(tempStatePath());

  state.ignoreItem('group-1', { key: 'item-a', matchSeriesId: false, label: 'A' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  state.ignoreItem('group-1', { key: 'item-b', matchSeriesId: false, label: 'B' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  state.ignoreItem('group-1', { key: 'item-c', matchSeriesId: false, label: 'C' });

  assert.deepEqual(keys(state.getIgnoreEntries('group-1')), ['item-c', 'item-b', 'item-a']);

  // Re-ignoring 'item-a' (upsert) bumps it to the top and refreshes its label,
  // without duplicating the entry.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const result = state.ignoreItem('group-1', { key: 'item-a', matchSeriesId: true, label: 'A renamed' });

  assert.deepEqual(keys(result), ['item-a', 'item-c', 'item-b']);
  assert.equal(result.length, 3); // no duplicate entry for item-a
  const bumped = result.find((entry) => entry.key === 'item-a');
  assert.equal(bumped?.label, 'A renamed');
  assert.equal(bumped?.matchSeriesId, true);
});

test('unignoreItem removes the item and prunes empty groups', () => {
  const filePath = tempStatePath();
  const state = new AppState(filePath);
  state.ignoreItem('group-1', { key: 'item-a', matchSeriesId: false, label: 'A' });
  state.ignoreItem('group-1', { key: 'item-b', matchSeriesId: false, label: 'B' });

  state.unignoreItem('group-1', 'item-a');
  assert.deepEqual(keys(state.getIgnoreEntries('group-1')), ['item-b']);

  state.unignoreItem('group-1', 'item-b');
  assert.deepEqual(state.getIgnoreEntries('group-1'), []);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { ignoredItems?: Record<string, unknown> };
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
  assert.deepEqual(state.getIgnoreEntries('group-1'), []);
});

test('reads a legacy ignoredShows-only file and migrates each id to whole-show scope', () => {
  const filePath = tempStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // A pre-rename state file carries only the legacy `ignoredShows` key, flat string[].
  fs.writeFileSync(
    filePath,
    JSON.stringify({ ignoredShows: { 'group-1': ['legacy-a', 'legacy-b'] } }, null, 2),
  );
  const state = new AppState(filePath);

  // READ falls back to the legacy key with zero data loss, migrated to
  // matchSeriesId: true (legacy ignores always stored a series id) and
  // ignoredAt: 0 (sorts last / oldest under most-recent-first).
  const entries = state.getIgnoreEntries('group-1');
  assert.deepEqual(keys(entries).sort(), ['legacy-a', 'legacy-b']);
  for (const entry of entries) {
    assert.equal(entry.matchSeriesId, true);
    assert.equal(entry.ignoredAt, 0);
  }

  // A fresh ignore (higher ignoredAt) sorts BEFORE the migrated legacy entries.
  state.ignoreItem('group-1', { key: 'new-c', matchSeriesId: false, label: 'New C' });
  const after = state.getIgnoreEntries('group-1');
  assert.equal(after[0].key, 'new-c');
  assert.deepEqual(keys(after).sort(), ['legacy-a', 'legacy-b', 'new-c']);

  // WRITE migrates: the new key carries the merged set; the legacy key is dropped.
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    ignoredItems?: Record<string, unknown>;
    ignoredShows?: Record<string, string[]>;
  };
  assert.equal(raw.ignoredShows, undefined);
  assert.ok(raw.ignoredItems?.['group-1']);
});

test('reads a legacy flat ignoredItems: string[] shape and migrates as whole-show scope', () => {
  const filePath = tempStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ ignoredItems: { 'group-1': ['series-old-a'] } }, null, 2),
  );
  const state = new AppState(filePath);

  const entries = state.getIgnoreEntries('group-1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, 'series-old-a');
  assert.equal(entries[0].matchSeriesId, true);
  assert.equal(entries[0].label, 'series-old-a');
  assert.equal(entries[0].ignoredAt, 0);

  // Still matches by id after migration (unignore works against the migrated key).
  const remaining = state.unignoreItem('group-1', 'series-old-a');
  assert.deepEqual(remaining, []);
});

function cachedConfig(
  overrides: Partial<{ sourceHash: string; builtForPackage: string; schemaVersion: number }> = {},
): {
  schemaVersion: number;
  builtForPackage: string;
  sourceHash: string;
  users: unknown[];
  accounts: Record<string, unknown>;
  accessTokens: Record<string, string>;
  watchedThreshold: number;
  recommendationCount: number;
} {
  return {
    schemaVersion: 2,
    builtForPackage: '2026.6.29',
    sourceHash: 'hash-a',
    users: [{ jellyfin_name: 'Alice' }],
    accounts: { h: { primary_users: ['Alice'], secondary_users: [], tertiary_users: [] } },
    accessTokens: { 'token-1': 'h' },
    watchedThreshold: 0.9,
    recommendationCount: 8,
    ...overrides,
  };
}

test('effective config round-trips and is fresh for the same hash + package + schema', () => {
  const state = new AppState(tempStatePath());
  state.setEffectiveConfig(cachedConfig());

  assert.equal(state.getEffectiveConfig()?.sourceHash, 'hash-a');
  assert.equal(state.isEffectiveConfigFresh('hash-a', '2026.6.29', 2), true);
});

test('effective config is stale when the source hash changed (user edited config.json)', () => {
  const state = new AppState(tempStatePath());
  state.setEffectiveConfig(cachedConfig());
  assert.equal(state.isEffectiveConfigFresh('hash-b', '2026.6.29', 2), false);
});

test('effective config is stale when the package version changed (new/rolled-back image)', () => {
  const state = new AppState(tempStatePath());
  state.setEffectiveConfig(cachedConfig());
  assert.equal(state.isEffectiveConfigFresh('hash-a', '2026.7.1', 2), false);
});

test('effective config is stale when the cached schemaVersion differs (older-schema cache)', () => {
  const state = new AppState(tempStatePath());
  // A schemaVersion-1 effective config cached by an older image must NOT be
  // reused by a v2 runtime, even when source + package happen to match.
  state.setEffectiveConfig(cachedConfig({ schemaVersion: 1 }));
  assert.equal(state.isEffectiveConfigFresh('hash-a', '2026.6.29', 2), false);
});

test('effective config is not fresh when nothing has been cached yet', () => {
  const state = new AppState(tempStatePath());
  assert.equal(state.getEffectiveConfig(), undefined);
  assert.equal(state.isEffectiveConfigFresh('hash-a', '2026.6.29', 2), false);
});
