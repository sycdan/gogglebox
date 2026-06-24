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

test('getIgnoredShows returns empty when the state file does not exist', () => {
  const state = new AppState(tempStatePath());
  assert.deepEqual(state.getIgnoredShows('group-1'), []);
});

test('ignoreShow creates the file and persists per group', () => {
  const filePath = tempStatePath();
  const state = new AppState(filePath);

  state.ignoreShow('group-1', 'show-a');
  state.ignoreShow('group-1', 'show-b');
  state.ignoreShow('group-2', 'show-c');

  assert.ok(fs.existsSync(filePath));
  assert.deepEqual(state.getIgnoredShows('group-1').sort(), ['show-a', 'show-b']);
  assert.deepEqual(state.getIgnoredShows('group-2'), ['show-c']);
});

test('ignoreShow is idempotent for the same show', () => {
  const state = new AppState(tempStatePath());
  state.ignoreShow('group-1', 'show-a');
  state.ignoreShow('group-1', 'show-a');
  assert.deepEqual(state.getIgnoredShows('group-1'), ['show-a']);
});

test('unignoreShow removes the show and prunes empty groups', () => {
  const filePath = tempStatePath();
  const state = new AppState(filePath);
  state.ignoreShow('group-1', 'show-a');
  state.ignoreShow('group-1', 'show-b');

  state.unignoreShow('group-1', 'show-a');
  assert.deepEqual(state.getIgnoredShows('group-1'), ['show-b']);

  state.unignoreShow('group-1', 'show-b');
  assert.deepEqual(state.getIgnoredShows('group-1'), []);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { ignoredShows?: Record<string, string[]> };
  assert.equal(raw.ignoredShows?.['group-1'], undefined);
});

test('reads survive a corrupt state file by starting fresh', () => {
  const filePath = tempStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{ not valid json');
  const state = new AppState(filePath);
  assert.deepEqual(state.getIgnoredShows('group-1'), []);
});
