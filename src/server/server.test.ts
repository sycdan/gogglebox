import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AppState } from './appState';
import { JellyfinClient } from './jellyfin';
import { derivePartyKey } from './partyKey';
import { AppConfig, FamilyMember } from './types';
import type { createApp as CreateApp } from './server.js';

// In-process HTTP-route-level test proving the /api/group* compatibility
// aliases are wired to the IDENTICAL handler as their /api/party* counterparts
// (same response for the same input), plus the dual-field GET /api/session
// agreement. Uses createApp() (see server.ts) — a minimal additive seam that
// builds a fresh Express app from injected config/jellyfin/appState, so no
// live Jellyfin connection or `.env` is needed here. Follows the plain
// node:test + node:http/fetch-against-an-ephemeral-listener convention used
// by the rest of src/server/*.test.ts; no supertest or other HTTP test
// framework was needed.
//
// server.ts's module body calls loadConfig() at import time, which requires
// JELLYFIN_URL/JELLYFIN_API_KEY to be SET (it never actually connects to
// Jellyfin at import time — only the production startup IIFE at the bottom of
// server.ts does that, which this test never triggers). Stubbing them, then
// dynamically importing server.ts inside test.before(), avoids a static
// import's hoisting (which would otherwise run before this file could stub
// the env — and this file's module system disallows top-level await).
let createApp: typeof CreateApp;

test.before(async () => {
  process.env.JELLYFIN_URL = process.env.JELLYFIN_URL || 'http://jellyfin.invalid';
  process.env.JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || 'unused-in-test';
  ({ createApp } = (await import('./server.js')) as { createApp: typeof CreateApp });
});

// id === jellyfinUserId, matching every real Jellyfin-sourced FamilyMember
// (see jellyfin.ts fetchUsers, and the same convention in parties.test.ts) —
// visiblePartiesForAccount/isPartyVisibleToAccount compare party memberIds
// (Jellyfin user ids) against visible[].id, so the two must agree here too.
const ALICE: FamilyMember = { id: 'alice', jellyfinUserId: 'alice', name: 'Alice', avatarUrl: null };
const BOB: FamilyMember = { id: 'bob', jellyfinUserId: 'bob', name: 'Bob', avatarUrl: null };

function tempStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gogglebox-server-test-'));
  return path.join(dir, 'state.json');
}

// A minimal, self-contained config: one account ("household") that can see
// both Alice and Bob as primaries (no pins needed), one access token, and no
// watchedThreshold/recommendations tuning beyond safe defaults. Never reaches
// Jellyfin: the party used across every test already exists in appState, so
// handleCreateParty's `!exists` branch (the only one that calls
// jellyfin.ensurePartyUser) is never taken.
function buildConfig(): AppConfig {
  return {
    appName: 'Gogglebox Test',
    port: 0,
    sessionSecret: 'test-secret',
    watchedThreshold: 0.9,
    envAccessToken: null,
    jellyfinUrl: 'http://jellyfin.invalid',
    jellyfinApiKey: 'unused-in-test',
    recommendations: { count: 8 },
    users: [],
    accounts: {
      household: { primary_users: ['Alice', 'Bob'], secondary_users: [], tertiary_users: [] },
    },
    accessTokens: { 'test-token': 'household' },
    viewersByName: { Alice: ALICE, Bob: BOB },
  };
}

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestServer(config: AppConfig, appState: AppState): Promise<TestServer> {
  const jellyfin = new JellyfinClient(config.jellyfinUrl, config.jellyfinApiKey);
  const app = createApp(config, jellyfin, appState);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected an AddressInfo from an ephemeral listener');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

// Extracts the cookie name=value pairs from a fetch Response's Set-Cookie
// header(s) (attribute-stripped), joined for reuse as a request Cookie header.
// Node's global fetch has no cookie jar, so the session cookie is carried
// manually between requests — same wire behavior a real browser client gets.
function cookieHeaderFrom(response: Response): string | null {
  const raw =
    typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : response.headers.get('set-cookie')
        ? [response.headers.get('set-cookie') as string]
        : [];
  if (raw.length === 0) {
    return null;
  }
  return raw.map((entry) => entry.split(';')[0]).join('; ');
}

async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface PartyListEntry {
  partyKey: string;
  alias: string;
  memberIds: string[];
  memberNames: string[];
}

interface GroupListEntry {
  groupKey: string;
  alias: string;
  memberIds: string[];
  memberNames: string[];
}

interface PartyListResponse {
  parties: PartyListEntry[];
  groups: GroupListEntry[];
}

interface SessionResponse {
  activePartyAlias: string | null;
  activeGroupAlias: string | null;
}

async function login(baseUrl: string, token: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(response.status, 200);
  const cookie = cookieHeaderFrom(response);
  assert.ok(cookie, 'login must set a session cookie');
  return cookie as string;
}

test('/api/group and /api/party (create) invoke the identical handler with agreeing response bodies', async () => {
  const config = buildConfig();
  const appState = new AppState(tempStatePath());
  const partyKey = derivePartyKey([ALICE.jellyfinUserId, BOB.jellyfinUserId]);
  // Pre-seed the party so handleCreateParty's !exists branch (the only one
  // that calls jellyfin.ensurePartyUser) is never taken — no live Jellyfin
  // reachability is required for this test.
  appState.setPartyPlayerUser(partyKey, 'jf-party-user', [ALICE.jellyfinUserId, BOB.jellyfinUserId]);

  const testServer = await startTestServer(config, appState);
  try {
    const cookie = await login(testServer.baseUrl, 'test-token');

    const partyRes = await fetch(`${testServer.baseUrl}/api/party`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ memberIds: [ALICE.id, BOB.id] }),
    });
    const partyBody = await partyRes.json();

    const groupRes = await fetch(`${testServer.baseUrl}/api/group`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ memberIds: [ALICE.id, BOB.id] }),
    });
    const groupBody = await groupRes.json();

    assert.equal(partyRes.status, 200);
    assert.equal(groupRes.status, 200);
    assert.deepEqual(groupBody, partyBody);
    assert.deepEqual(partyBody, { ok: true, activeViewerIds: [ALICE.id, BOB.id] });
  } finally {
    await testServer.close();
  }
});

test('/api/group/verify-pins and /api/party/verify-pins invoke the identical handler with agreeing response bodies', async () => {
  const config = buildConfig();
  const appState = new AppState(tempStatePath());
  const testServer = await startTestServer(config, appState);
  try {
    const cookie = await login(testServer.baseUrl, 'test-token');

    const partyRes = await fetch(`${testServer.baseUrl}/api/party/verify-pins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ memberIds: [ALICE.id, BOB.id] }),
    });
    const partyBody = await partyRes.json();

    const groupRes = await fetch(`${testServer.baseUrl}/api/group/verify-pins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ memberIds: [ALICE.id, BOB.id] }),
    });
    const groupBody = await groupRes.json();

    assert.equal(partyRes.status, 200);
    assert.equal(groupRes.status, 200);
    assert.deepEqual(groupBody, partyBody);
    assert.deepEqual(partyBody, { ok: true });
  } finally {
    await testServer.close();
  }
});

test('/api/groups and /api/parties invoke the identical handler, including per-entry groupKey/partyKey equality', async () => {
  const config = buildConfig();
  const appState = new AppState(tempStatePath());
  const partyKey = derivePartyKey([ALICE.jellyfinUserId, BOB.jellyfinUserId]);
  appState.setPartyPlayerUser(partyKey, 'jf-party-user', [ALICE.jellyfinUserId, BOB.jellyfinUserId]);
  appState.setPartyAlias(partyKey, 'Alice + Bob');

  const testServer = await startTestServer(config, appState);
  try {
    const cookie = await login(testServer.baseUrl, 'test-token');

    const partiesRes = await fetch(`${testServer.baseUrl}/api/parties`, { headers: { cookie } });
    const partiesBody = await json<PartyListResponse>(partiesRes);

    const groupsRes = await fetch(`${testServer.baseUrl}/api/groups`, { headers: { cookie } });
    const groupsBody = await json<PartyListResponse>(groupsRes);

    assert.equal(partiesRes.status, 200);
    assert.equal(groupsRes.status, 200);
    // Both responses come from the identical handler: the /api/groups response
    // carries both `parties` and `groups`, the /api/parties response also
    // carries both (same handler, same shape) — so the two bodies are equal.
    assert.deepEqual(groupsBody, partiesBody);
    assert.equal(partiesBody.parties.length, 1);
    assert.equal(partiesBody.groups.length, 1);
    assert.equal(partiesBody.parties[0].partyKey, partyKey);
    assert.equal(partiesBody.groups[0].groupKey, partyKey);
    // Per-entry partyKey/groupKey equality (same value, aliased field name).
    assert.equal(partiesBody.groups[0].groupKey, partiesBody.parties[0].partyKey);
  } finally {
    await testServer.close();
  }
});

test('/api/group/clear and /api/party/clear invoke the identical handler with agreeing response bodies', async () => {
  const config = buildConfig();
  const appState = new AppState(tempStatePath());
  const partyKey = derivePartyKey([ALICE.jellyfinUserId, BOB.jellyfinUserId]);
  appState.setPartyPlayerUser(partyKey, 'jf-party-user', [ALICE.jellyfinUserId, BOB.jellyfinUserId]);

  const testServer = await startTestServer(config, appState);
  try {
    const cookie = await login(testServer.baseUrl, 'test-token');
    // Activate a party first so clearing it is meaningful.
    await fetch(`${testServer.baseUrl}/api/party`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ memberIds: [ALICE.id, BOB.id] }),
    });

    const partyRes = await fetch(`${testServer.baseUrl}/api/party/clear`, {
      method: 'POST',
      headers: { cookie },
    });
    const partyBody = await partyRes.json();

    const groupRes = await fetch(`${testServer.baseUrl}/api/group/clear`, {
      method: 'POST',
      headers: { cookie },
    });
    const groupBody = await groupRes.json();

    assert.equal(partyRes.status, 200);
    assert.equal(groupRes.status, 200);
    assert.deepEqual(groupBody, partyBody);
    assert.deepEqual(partyBody, { ok: true, activeViewerIds: [] });
  } finally {
    await testServer.close();
  }
});

test('GET /api/session returns activePartyAlias and activeGroupAlias with equal values', async () => {
  const config = buildConfig();
  const appState = new AppState(tempStatePath());
  const partyKey = derivePartyKey([ALICE.jellyfinUserId, BOB.jellyfinUserId]);
  appState.setPartyPlayerUser(partyKey, 'jf-party-user', [ALICE.jellyfinUserId, BOB.jellyfinUserId]);
  appState.setPartyAlias(partyKey, 'Alice + Bob');

  const testServer = await startTestServer(config, appState);
  try {
    const cookie = await login(testServer.baseUrl, 'test-token');
    await fetch(`${testServer.baseUrl}/api/party`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ memberIds: [ALICE.id, BOB.id] }),
    });

    const sessionRes = await fetch(`${testServer.baseUrl}/api/session`, { headers: { cookie } });
    const sessionBody = await json<SessionResponse>(sessionRes);

    assert.equal(sessionRes.status, 200);
    assert.equal(sessionBody.activePartyAlias, 'Alice + Bob');
    assert.equal(sessionBody.activeGroupAlias, sessionBody.activePartyAlias);
  } finally {
    await testServer.close();
  }
});
