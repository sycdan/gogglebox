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
