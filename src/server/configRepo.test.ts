import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { syncConfigRepo } from './configRepo';

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(repo: string, value: string): void {
  fs.writeFileSync(path.join(repo, 'config.json'), value);
  git('-C', repo, 'add', 'config.json');
  git('-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-m', 'Update config');
}

function fixture(t: test.TestContext, branch = 'main'): { writer: string; production: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gogglebox-config-repo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const writer = path.join(root, 'writer');
  const production = path.join(root, 'production');
  git('init', '--bare', '-b', branch, remote);
  git('clone', remote, writer);
  commit(writer, '{"schemaVersion":2}');
  git('-C', writer, 'push', '-u', 'origin', branch);
  git('clone', remote, production);
  return { writer, production };
}

test('syncConfigRepo pulls a fast-forward and reports when it is up to date', async (t) => {
  const { writer, production } = fixture(t);
  commit(writer, '{"schemaVersion":2,"users":[]}');
  git('-C', writer, 'push');

  const updated = await syncConfigRepo(production);
  assert.equal(updated.changed, true);
  assert.equal(fs.readFileSync(path.join(production, 'config.json'), 'utf8'), '{"schemaVersion":2,"users":[]}');
  assert.equal(updated.revision, git('-C', production, 'rev-parse', '--short=12', 'HEAD'));
  assert.equal((await syncConfigRepo(production)).changed, false);
});

test('syncConfigRepo supports a machine-specific branch', async (t) => {
  const { writer, production } = fixture(t, 'htpc');
  commit(writer, '{"schemaVersion":2,"branch":"htpc"}');
  git('-C', writer, 'push');

  const updated = await syncConfigRepo(production, 'htpc');
  assert.equal(updated.changed, true);
  assert.equal(fs.readFileSync(path.join(production, 'config.json'), 'utf8'), '{"schemaVersion":2,"branch":"htpc"}');
});

test('syncConfigRepo preserves local edits and divergent commits', async (t) => {
  const { writer, production } = fixture(t);
  fs.writeFileSync(path.join(production, 'config.json'), 'local edit');
  await assert.rejects(syncConfigRepo(production), /local changes/);
  assert.equal(fs.readFileSync(path.join(production, 'config.json'), 'utf8'), 'local edit');

  commit(production, 'local commit');
  commit(writer, 'remote commit');
  git('-C', writer, 'push');
  const localHead = git('-C', production, 'rev-parse', 'HEAD');
  await assert.rejects(syncConfigRepo(production));
  assert.equal(git('-C', production, 'rev-parse', 'HEAD'), localHead);
});
