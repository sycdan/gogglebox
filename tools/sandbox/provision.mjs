// Provision a fresh sandbox Jellyfin end-to-end with ZERO manual steps.
//
// Steps (all via REST against JELLYFIN_URL, default http://jellyfin-sandbox:8096):
//   1. Wait for the server to answer /System/Info/Public.
//   2. If first-run, complete the startup wizard:
//        GET  /Startup/Configuration         (read defaults)
//        POST /Startup/Configuration         (locale)
//        GET  /Startup/User                  (touch the wizard user step)
//        POST /Startup/User                  (admin username + password)
//        POST /Startup/RemoteAccess          (allow remote, no UPnP)
//        POST /Startup/Complete              (finish wizard)
//   3. Authenticate as the admin to get an access token.
//   4. Create the household users (Alice/Bob/Carol/Dave) if missing.
//   5. Add the shows + movies libraries with ONLINE METADATA DISABLED, then
//      trigger a refresh and WAIT for the scan to finish.
//   6. Mint a STABLE API key (named GOGGLEBOX_SANDBOX) — reused if already present.
//   7. Emit .env.sandbox + config.sandbox.json so server/proof can target the
//      sandbox deterministically.
//
// Idempotent: re-running against an already-provisioned volume converges (users
// that exist are skipped, the existing api key is reused, libraries are only
// added once) instead of erroring.
//
//   node tools/sandbox/provision.mjs

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  SANDBOX_USERS,
  SHOWS_LIBRARY_NAME,
  MOVIES_LIBRARY_NAME,
} from './fixtures.mjs';

const JF_URL = (process.env.JELLYFIN_URL || 'http://jellyfin-sandbox:8096').replace(/\/$/, '');
const ADMIN_USER = process.env.SANDBOX_ADMIN_USER || 'gogglebox-admin';
const ADMIN_PASS = process.env.SANDBOX_ADMIN_PASS || 'gogglebox-sandbox';
const USER_PASS = process.env.SANDBOX_USER_PASS || 'sandbox';
const API_KEY_NAME = 'GOGGLEBOX_SANDBOX';
// In-container media paths the libraries point at (see generate-fixtures.mjs).
const MEDIA_ROOT = process.env.SANDBOX_MEDIA_ROOT || '/media';
const SHOWS_PATH = path.posix.join(MEDIA_ROOT, 'shows');
const MOVIES_PATH = path.posix.join(MEDIA_ROOT, 'movies');
// Where to write the emitted env + config (host-mounted project root).
const OUT_DIR = process.env.SANDBOX_OUT_DIR || process.cwd();

// Jellyfin wants a client identity on the auth + most write calls.
const CLIENT = 'GoggleboxSandboxProvisioner';
const DEVICE = 'provisioner';
const DEVICE_ID = 'gogglebox-sandbox-provisioner';
const VERSION = '1.0.0';

function authHeader(token) {
  const parts = [
    `MediaBrowser Client="${CLIENT}"`,
    `Device="${DEVICE}"`,
    `DeviceId="${DEVICE_ID}"`,
    `Version="${VERSION}"`,
  ];
  if (token) parts.push(`Token="${token}"`);
  return parts.join(', ');
}

async function api(pathname, { method = 'GET', token, body, query } = {}) {
  const url = new URL(pathname, JF_URL);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const headers = { Authorization: authHeader(token) };
  if (token) headers['X-Emby-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jellyfin ${method} ${pathname} -> ${res.status} ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return res.text();
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const info = await api('/System/Info/Public');
      return info;
    } catch {
      await sleep(2000);
    }
  }
  throw new Error('Jellyfin sandbox did not become reachable in time');
}

// True if the startup wizard still needs running.
async function isFirstRun() {
  const info = await api('/System/Info/Public');
  // StartupWizardCompleted is exposed on public system info.
  return info?.StartupWizardCompleted === false;
}

async function runStartupWizard() {
  console.log('[provision] running startup wizard...');
  // Read + post locale config (defaults are fine; posting marks the step done).
  const cfg = await api('/Startup/Configuration').catch(() => ({}));
  await api('/Startup/Configuration', {
    method: 'POST',
    body: {
      UICulture: cfg?.UICulture || 'en-US',
      MetadataCountryCode: cfg?.MetadataCountryCode || 'US',
      PreferredMetadataLanguage: cfg?.PreferredMetadataLanguage || 'en',
    },
  });
  // Touch the user step, then create the first admin user.
  await api('/Startup/User').catch(() => null);
  await api('/Startup/User', {
    method: 'POST',
    body: { Name: ADMIN_USER, Password: ADMIN_PASS },
  });
  // Remote access on, UPnP off (deterministic, no network discovery).
  await api('/Startup/RemoteAccess', {
    method: 'POST',
    body: { EnableRemoteAccess: true, EnableAutomaticPortMapping: false },
  });
  await api('/Startup/Complete', { method: 'POST' });
  console.log('[provision] startup wizard complete.');
}

async function authenticate() {
  const res = await api('/Users/AuthenticateByName', {
    method: 'POST',
    body: { Username: ADMIN_USER, Pw: ADMIN_PASS },
  });
  if (!res?.AccessToken) throw new Error('Admin authentication returned no AccessToken');
  return res.AccessToken;
}

async function ensureUsers(token) {
  const existing = await api('/Users', { token });
  const byName = new Map((existing ?? []).map((u) => [u.Name, u]));
  const created = [];
  for (const name of SANDBOX_USERS) {
    if (byName.has(name)) {
      continue;
    }
    const user = await api('/Users/New', {
      method: 'POST',
      token,
      body: { Name: name, Password: USER_PASS },
    });
    created.push(name);
    byName.set(name, user);
  }
  if (created.length) console.log(`[provision] created users: ${created.join(', ')}`);
  else console.log('[provision] all household users already present.');
  // Return a fresh, complete list keyed by name.
  const all = await api('/Users', { token });
  return new Map((all ?? []).map((u) => [u.Name, u]));
}

// LibraryOptions with EVERY metadata + image fetcher disabled so scans are
// deterministic and need no network — Jellyfin reads our .nfo sidecars only.
function offlineLibraryOptions(collectionType, libraryPath) {
  const typeOptions =
    collectionType === 'tvshows'
      ? ['Series', 'Season', 'Episode']
      : ['Movie'];
  return {
    EnablePhotos: false,
    EnableRealtimeMonitor: false,
    EnableChapterImageExtraction: false,
    ExtractChapterImagesDuringLibraryScan: false,
    EnableInternetProviders: false,
    SaveLocalMetadata: true,
    EnableAutomaticSeriesGrouping: false,
    PathInfos: [{ Path: libraryPath }],
    MetadataSavers: [],
    DisabledLocalMetadataReaders: [],
    LocalMetadataReaderOrder: ['Nfo'],
    MetadataFetchers: [],
    MetadataFetcherOrder: [],
    ImageFetchers: [],
    ImageFetcherOrder: [],
    TypeOptions: typeOptions.map((t) => ({
      Type: t,
      MetadataFetchers: [],
      MetadataFetcherOrder: [],
      ImageFetchers: [],
      ImageFetcherOrder: [],
    })),
  };
}

async function ensureLibrary(token, name, collectionType, libraryPath) {
  const folders = (await api('/Library/VirtualFolders', { token })) ?? [];
  if (folders.some((f) => f.Name === name)) {
    console.log(`[provision] library "${name}" already present.`);
    return false;
  }
  await api('/Library/VirtualFolders', {
    method: 'POST',
    token,
    query: { name, collectionType, refreshLibrary: 'false' },
    body: { LibraryOptions: offlineLibraryOptions(collectionType, libraryPath) },
  });
  console.log(`[provision] added library "${name}" -> ${libraryPath} (online metadata disabled).`);
  return true;
}

// Trigger a full library refresh and WAIT for the scan to complete by polling the
// "Scan Media Library" scheduled task until it returns to Idle.
async function scanAndWait(token) {
  await api('/Library/Refresh', { method: 'POST', token });
  console.log('[provision] library scan triggered; waiting for completion...');
  const SCAN_KEY = 'RefreshLibrary';
  for (let i = 0; i < 150; i += 1) {
    await sleep(2000);
    const tasks = (await api('/ScheduledTasks', { token })) ?? [];
    const scan = tasks.find((t) => t.Key === SCAN_KEY);
    if (scan && scan.State === 'Idle') {
      // Confirm items actually landed before declaring done.
      const items = await api('/Items', {
        token,
        query: { Recursive: 'true', IncludeItemTypes: 'Movie,Episode', Limit: '1' },
      });
      if ((items?.TotalRecordCount ?? items?.Items?.length ?? 0) > 0) {
        console.log('[provision] scan complete; library populated.');
        return;
      }
    }
  }
  console.warn('[provision] scan wait timed out; continuing (library may be empty).');
}

async function ensureApiKey(token) {
  const keys = (await api('/Auth/Keys', { token })) ?? {};
  const list = keys.Items ?? keys ?? [];
  const found = Array.isArray(list)
    ? list.find((k) => k.AppName === API_KEY_NAME)
    : null;
  if (found?.AccessToken) {
    console.log('[provision] reusing existing sandbox API key.');
    return found.AccessToken;
  }
  await api('/Auth/Keys', { method: 'POST', token, query: { app: API_KEY_NAME } });
  const after = (await api('/Auth/Keys', { token })) ?? {};
  const afterList = after.Items ?? after ?? [];
  const minted = Array.isArray(afterList)
    ? afterList.find((k) => k.AppName === API_KEY_NAME)
    : null;
  if (!minted?.AccessToken) throw new Error('Failed to mint sandbox API key');
  console.log('[provision] minted new sandbox API key.');
  return minted.AccessToken;
}

async function emitArtifacts(apiKey, usersByName) {
  // GUIDs for the household group (the server filters Jellyfin users by these).
  const memberIds = SANDBOX_USERS.map((name) => usersByName.get(name)?.Id).filter(Boolean);

  const envPath = path.join(OUT_DIR, '.env.sandbox');
  const envBody = [
    '# Generated by tools/sandbox/provision.mjs — point server/proof at the sandbox.',
    '# Load with: docker compose --env-file .env.sandbox ...  OR copy into .env.',
    `JELLYFIN_URL=http://jellyfin-sandbox:8096`,
    `JELLYFIN_API_KEY=${apiKey}`,
    `PORTAL_USERNAME=${ADMIN_USER}`,
    `PORTAL_PASSWORD=${ADMIN_PASS}`,
    `PORTAL_AUTO_LOGIN=true`,
    '',
  ].join('\n');
  await writeFile(envPath, envBody, 'utf8');

  const configPath = path.join(OUT_DIR, 'config.sandbox.json');
  const config = {
    playback: { watchedThreshold: 0.9 },
    recommendations: { count: 4 },
    groups: [
      { id: 'all', name: 'Everyone', memberIds },
      { id: 'parents', name: 'Alice + Bob', memberIds: memberIds.slice(0, 2) },
    ],
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  console.log(`[provision] wrote ${envPath}`);
  console.log(`[provision] wrote ${configPath}`);
  console.log('[provision] household GUIDs:');
  for (const name of SANDBOX_USERS) {
    console.log(`           ${name} = ${usersByName.get(name)?.Id ?? '(missing)'}`);
  }
}

async function main() {
  console.log(`[provision] target: ${JF_URL}`);
  await waitForServer();

  if (await isFirstRun()) {
    await runStartupWizard();
  } else {
    console.log('[provision] startup wizard already complete; converging.');
  }

  const token = await authenticate();
  const usersByName = await ensureUsers(token);

  const addedShows = await ensureLibrary(token, SHOWS_LIBRARY_NAME, 'tvshows', SHOWS_PATH);
  const addedMovies = await ensureLibrary(token, MOVIES_LIBRARY_NAME, 'movies', MOVIES_PATH);
  if (addedShows || addedMovies) {
    await scanAndWait(token);
  } else {
    // Libraries already exist; a light refresh keeps them current with any new
    // generated files but we don't block on it for the common no-op case.
    await scanAndWait(token);
  }

  const apiKey = await ensureApiKey(token);
  await emitArtifacts(apiKey, usersByName);

  console.log('[provision] done. Sandbox is ready.');
}

main().catch((err) => {
  console.error('[provision] failed:', err);
  process.exit(1);
});
