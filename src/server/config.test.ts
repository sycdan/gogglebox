import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const originalEnv = { ...process.env };
const originalCwd = process.cwd();

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function setupWorkspace(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gogglebox-config-test-'));

  writeJson(path.join(tempRoot, 'config.json'), {
    groups: [
      {
        id: 'all',
        name: 'Everyone',
        memberIds: ['user1'],
      },
    ],
  });

  return tempRoot;
}

test('loadConfig defaults portal auto login to false when env var is unset', async () => {
  const workspace = setupWorkspace();

  try {
    process.chdir(workspace);
    process.env = {
      ...originalEnv,
      JELLYFIN_URL: 'https://example.test',
      JELLYFIN_API_KEY: 'key',
      PORTAL_USERNAME: 'household-user',
      PORTAL_PASSWORD: 'household-pass',
    };
    delete process.env.PORTAL_AUTO_LOGIN;

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    assert.equal(config.portalAutoLogin, false);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('loadConfig parses portal auto login true values', async () => {
  const workspace = setupWorkspace();

  try {
    process.chdir(workspace);
    process.env = {
      ...originalEnv,
      JELLYFIN_URL: 'https://example.test',
      JELLYFIN_API_KEY: 'key',
      PORTAL_USERNAME: 'household-user',
      PORTAL_PASSWORD: 'household-pass',
      PORTAL_AUTO_LOGIN: 'true',
    };

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    assert.equal(config.portalAutoLogin, true);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('loadConfig throws a clear error when config.json is missing', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gogglebox-config-test-'));

  try {
    process.chdir(workspace);
    process.env = {
      ...originalEnv,
      JELLYFIN_URL: 'https://example.test',
      JELLYFIN_API_KEY: 'key',
      PORTAL_USERNAME: 'household-user',
      PORTAL_PASSWORD: 'household-pass',
    };

    const { loadConfig } = await import('./config.js');

    assert.throws(() => loadConfig(), /Missing required config file:.*config\.json/);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test.after(() => {
  process.chdir(originalCwd);
  process.env = originalEnv;
});
