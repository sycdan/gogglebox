import assert from 'node:assert/strict';
import test from 'node:test';

import { buildJellyfinCredentials, seedJellyfinWebSession } from './jellyfinSession';

const payload = {
  serverId: 'srv-1',
  userId: 'user-1',
  accessToken: 'tok-1',
  deviceId: 'device-abc',
  playerOrigin: '/player',
};

test('buildJellyfinCredentials encodes a same-origin /player server entry with a resolvable address', () => {
  const raw = buildJellyfinCredentials(payload, 'http://localhost:8080', 1234);
  const parsed = JSON.parse(raw);

  assert.equal(parsed.Servers.length, 1);
  const server = parsed.Servers[0];
  assert.equal(server.Id, 'srv-1');
  assert.equal(server.AccessToken, 'tok-1');
  assert.equal(server.UserId, 'user-1');
  assert.equal(server.DateLastAccessed, 1234);

  const expectedAddress = 'http://localhost:8080/player';
  // jellyfin-apiclient resolves the ApiClient address from LastConnectionMode:
  // mode 0 (Local) reads LocalAddress, which MUST be non-empty or the ApiClient
  // ctor throws "Must supply a serverAddress" and React never mounts.
  assert.equal(server.LastConnectionMode, 0);
  assert.equal(server.LocalAddress, expectedAddress);
  // Belt-and-suspenders: every address field is set to the same value so any
  // version/mode resolves to the same-origin /player base.
  assert.equal(server.Address, expectedAddress);
  assert.equal(server.ManualAddress, expectedAddress);
  assert.equal(server.RemoteAddress, expectedAddress);
  // The address the mode-0 resolver returns must be non-empty (regression guard).
  const resolvedByMode0 = server.LocalAddress;
  assert.ok(typeof resolvedByMode0 === 'string' && resolvedByMode0.length > 0);
});

test('seedJellyfinWebSession writes all three auto-login keys with the mint deviceId', () => {
  const store = new Map<string, string>();
  const storage = { setItem: (k: string, v: string) => store.set(k, v) };

  seedJellyfinWebSession(storage, payload, 'http://localhost:8080', 1234);

  assert.equal(store.get('_deviceId2'), 'device-abc');
  assert.equal(store.get('enableAutoLogin'), 'true');

  const creds = JSON.parse(store.get('jellyfin_credentials') as string);
  assert.equal(creds.Servers[0].UserId, 'user-1');
  // The seeded deviceId MUST equal the deviceId used at mint.
  assert.equal(store.get('_deviceId2'), payload.deviceId);
});
