# Sandbox Jellyfin

A deterministic, **offline** Jellyfin for testing Gogglebox's continue-watching
features against a **real** Jellyfin with controlled, repeatable data — ending the
"unit tests pass but real behavior fails" cycle.

It is **additive and opt-in**: everything lives in the `docker-compose.sbx.yml`
overlay, driven by `./scripts/sbx.sh` (which layers it on the base file). The base
stack (`docker compose …` against your `.env`) is unaffected unless you use the
overlay.

The model: an **immutable** library + users + API key persist in named volumes;
only the **mutable** per-user played-state is reset between tests.

## What's committed vs generated

| Committed (in git) | Generated (gitignored) |
| --- | --- |
| `fixtures.mjs` — the library/users spec | `tools/sandbox/media/` and the `sandbox_media` volume (tiny .mkv stubs + .nfo) |
| `generate-fixtures.mjs`, `provision.mjs`, `reset.mjs` | `sandbox_config` / `sandbox_cache` volumes (Jellyfin state) |
| `Dockerfile` (Node + ffmpeg tooling image) | `.env.sbx` (overrides-only: minted API key + URL + admin creds) |
| this `README.md` | `config.sbx.json` (groups with the minted user GUIDs) |

## Bring it up (zero manual steps)

```bash
# 1. Boot the sandbox Jellyfin (official image, internal hostname jellyfin-sandbox:8096)
./scripts/sbx.sh up -d jellyfin-sandbox

# 2. Generate the tiny media library (ffmpeg stubs + .nfo) into the sandbox_media volume
./scripts/sbx.sh run --rm sandbox-generate

# 3. Provision: run the first-run wizard, create users, add libraries (online
#    metadata DISABLED), scan + wait, mint a stable API key, emit env + config
./scripts/sbx.sh run --rm sandbox-provision
```

After step 3 you have, at the project root:

- `.env.sbx` — the **overrides-only** env file layered on top of the shared
  `.env` (later file wins). It carries only the four per-env override keys:
  `JELLYFIN_URL=http://jellyfin-sandbox:8096`, the minted `JELLYFIN_API_KEY`, and
  the admin `PORTAL_USERNAME`/`PORTAL_PASSWORD`. Shared keys (e.g.
  `PORTAL_AUTO_LOGIN`) stay in `.env`.
- `config.sbx.json` — `groups` whose `memberIds` are the **actual GUIDs** of
  the provisioned users (Alice/Bob/Carol/Dave), so the server's `fetchUsers` /
  `activeViewersForSession` see exactly this "Everyone" group.

Re-running any step is **idempotent**: generate skips existing files (`FORCE=1`
to re-encode), provision skips existing users/libraries and reuses the existing
API key.

## Point the server / proof at the sandbox (one command)

The `docker-compose.sbx.yml` overlay **re-points the base `server`/`proof`
services** at the sandbox, baking in everything that previously had to be wired by
hand (the `.env.sbx` overrides + the `config.sbx.json` mount over
`/app/config.json`). Because it overrides the same service names, the client's
`http://server:3000` proxy and the proof's `http://client:5173` already resolve —
no network aliases needed. Drive it all with `./scripts/sbx.sh`; the base stack
(`docker compose …` with `.env` + `config.json`) is untouched.

```bash
# 0. (once) sandbox Jellyfin must be up + provisioned (see "Bring it up" above).

# 1. Reset every user to a clean played-state slate.
./scripts/sbx.sh run --rm sandbox-reset

# 2. Bring up the sandbox-pointed server + client. (Use up -d, NOT `run`, so the
#    services are reachable by name for the proxy + proof.)
./scripts/sbx.sh up -d server client

# 3. Run a flow against the sandbox (writes screenshots to ./artifacts):
PROOF_FLOW=mark-all-watched ./scripts/sbx.sh run --rm proof

# 4. Tear down when done.
./scripts/sbx.sh down
```

What the overlay bakes into `server`/`proof` (so you never hand-hack again):

- **`server`**: `env_file: [.env, .env.sbx]` (the ordered list layers the sandbox
  `JELLYFIN_URL`/`JELLYFIN_API_KEY` + creds over the shared `.env`; later wins)
  **and** a compose-managed mount of
  `./config.sbx.json` → `/app/config.json:ro`. The mount target is an
  absolute **in-container** path, so Git Bash never path-mangles it (a mangled
  target silently leaves the live `config.json` in place → `viewers: []` /
  "Unknown viewer"). It also depends on `jellyfin-sandbox`.
- **`client`**: unchanged from base — its `http://server:3000` proxy now resolves
  to the sandbox-pointed `server` because the overlay overrides that same service.
- **`proof`**: `env_file: [.env, .env.sbx]` (so seeders get the sandbox Jellyfin
  creds layered over the shared `.env`) and the same `config.sbx.json` mount, so the flow reads the
  **household group** and scopes seeders to Alice/Bob/Carol/Dave only — not the
  `gogglebox-admin` user, whose stray played-state would desync the rail.

> Gotcha: if a container ever comes up with **no network** (can happen if a prior
> start aborted on a port conflict — symptom: server logs
> `Failed to load viewers from Jellyfin: fetch failed`), recreate it:
> `./scripts/sbx.sh up -d --force-recreate server`.

## Deterministic reset (between flows)

No container teardown is needed between flows. Reset returns **all** users to a
clean played-state slate — clears every user's `PlayedItems` and zeroes every
Movie/Episode `PlaybackPositionTicks` — fast, no rescan:

```bash
./scripts/sbx.sh run --rm sandbox-reset
```

In e2e code the same logic is on the shared client
(`e2e/lib/jellyfin.mjs` → `makeJellyfin(url, key).resetAllPlayedState()`), so a
flow does:

```js
const jf = makeJellyfin(url, apiKey);
await jf.resetAllPlayedState();   // 1. clean slate for every user
// 2. seed your fixture (mark played / set positions)
// 3. assert
```

## Fixture library

Tiny but broad. Each video is a **1-second, 32×32 ffmpeg encode** (a few KB) so
Jellyfin probes a **real (short) `RunTimeTicks`** — resume %/`setPlaybackPosition`
math needs real ticks, so zero-byte files are not used. Total library is
single-digit MB. Folder/file paths are **fixed** so Jellyfin item GUIDs are
reproducible across rebuilds. Online metadata providers are **disabled** on the
libraries; Jellyfin reads the `.nfo` sidecars only, so scans need no network.

Users: **Alice, Bob, Carol, Dave**.

Shows:

| Fixture | Why it exists |
| --- | --- |
| **Normal Show** | Multi-season (S1×4, S2×3); air order matches SxxExx. The happy path. |
| **Production Order** | **Production-order-divergent** — see below. |
| **Specials Show** | Season 0 specials interleaved with regular seasons. |
| **Single Episode** | One season, one episode. |
| **Near Finale** | 3-episode series so a viewer can sit on the last / second-to-last episode (exercises the "no next episode" branch). |

Movies: **Alpha / Beta / Gamma / Delta** (standalone, each with real ticks).

### The production-order-divergent fixture

**`Production Order` (2020), Season 1** is the fixture that reproduces the
real-Jellyfin quirk our anchor logic hit: the episode **PremiereDate (air) order
does NOT match the IndexNumber/SxxExx order**.

```
SxxExx order : E01 -> E02 -> E03 -> E04
aired order  : E01 (Jan 07) -> E04 (Jan 14) -> E02 (Jan 21) -> E03 (Jan 28)
```

So `S01E04` (`Origins`) aired **before** `S01E02` and `S01E03`. Any query that
sorts by `PremiereDate` (e.g. `listEpisodes`, `/Shows/NextUp`) yields a different
sequence than one sorting by season/episode number
(`listSeriesEpisodesPlayedState`). This is exactly the divergence that mis-mapped
a viewer's played episodes to the wrong index in production.

## First-run / provisioning gotchas

Jellyfin's startup wizard is the fiddly part. The provisioner drives it via REST
(see `provision.mjs`); the exact sequence:

1. Poll `GET /System/Info/Public` until the server answers; its
   `StartupWizardCompleted` flag tells us whether the wizard still needs running
   (so re-runs converge instead of erroring).
2. `GET` then `POST /Startup/Configuration` (locale; posting marks the step done).
3. `GET /Startup/User` (touch the step), then `POST /Startup/User` with the admin
   `Name` + `Password`.
4. `POST /Startup/RemoteAccess` `{ EnableRemoteAccess: true,
   EnableAutomaticPortMapping: false }` — UPnP off keeps it deterministic / no
   network discovery.
5. `POST /Startup/Complete`.

Then:

- Authenticate: `POST /Users/AuthenticateByName` `{ Username, Pw }` → `AccessToken`
  (note the field is **`Pw`**, not `Password`).
- Users: `POST /Users/New` per missing household user.
- Libraries: `POST /Library/VirtualFolders?name=&collectionType=tvshows|movies`
  with a `LibraryOptions` body that empties **every** metadata/image fetcher list
  and sets `EnableInternetProviders: false`, `LocalMetadataReaderOrder: ['Nfo']`
  → fully offline scans.
- Scan + wait: `POST /Library/Refresh`, then poll `GET /ScheduledTasks` for the
  `RefreshLibrary` task to return to `State: Idle`, and confirm `/Items` actually
  returns content before declaring done.
- API key: list `GET /Auth/Keys`; reuse the `GOGGLEBOX_SANDBOX` key if present,
  else `POST /Auth/Keys?app=GOGGLEBOX_SANDBOX` and re-read to capture the token.
  (Jellyfin mints the token server-side, so the **value** can differ across a
  full volume wipe; it is emitted to `.env.sbx` for the harness to read. As
  long as the `sandbox_config` volume persists, the same key is reused.)

Auth header on write calls is
`Authorization: MediaBrowser Client="...", Device="...", DeviceId="...", Version="...", Token="..."`
plus `X-Emby-Token` once a token exists.
