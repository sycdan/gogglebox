# Sandbox Jellyfin

A deterministic, **offline** Jellyfin for testing Gogglebox's continue-watching
features against a **real** Jellyfin with controlled, repeatable data — ending the
"unit tests pass but real behavior fails" cycle.

It is part of the e2e stack (`docker-compose.e2e.yml`, driven by
`./scripts/e2e.sh`) and so of the dev stack layered on it (`./scripts/dev.sh`).

The model: an **immutable** library + users + API key persist in named volumes;
only the **mutable** per-user played-state is reset between tests.

## What's committed vs generated

| Committed (in git) | Generated (gitignored) |
| --- | --- |
| `fixtures.mjs` — the library/users spec | `tools/sandbox/media/` and the `sandbox_media` volume (tiny .webm stubs + .nfo) |
| `generate-fixtures.mjs`, `provision.mjs`, `reset.mjs` | `sandbox_config` / `sandbox_cache` volumes (Jellyfin state) |
| `Dockerfile` (Node + ffmpeg tooling image) | `.env.sbx` (overrides-only: minted API key + URL + auto-login `ACCESS_TOKEN`) |
| this `README.md` | `config.sbx.json` (schemaVersion 2: `users[]` + tiered `accounts` + `access_tokens`) |

## Bring it up (zero manual steps)

```bash
# 1. Boot the sandbox Jellyfin (official image, internal hostname jellyfin-sandbox:8096)
./scripts/e2e.sh up -d jellyfin-sandbox

# 2. Generate the tiny media library (ffmpeg stubs + .nfo) into the sandbox_media volume
./scripts/e2e.sh run --rm sandbox-generate

# 3. Provision: run the first-run wizard, create users, add libraries (online
#    metadata DISABLED), scan + wait, mint a stable API key, emit env + config
./scripts/e2e.sh run --rm sandbox-provision
```

After step 3 you have, at the project root:

- `.env.sbx` — the wrapper loads it after `.env.e2e` (later file wins). It
  carries `JELLYFIN_URL=http://jellyfin-sandbox:8096`, the minted
  `JELLYFIN_API_KEY`, and `ACCESS_TOKEN=sbx-household-token`. (Auto-login is
  implicit: with that token set and matching an `access_tokens` entry, the app
  logs in automatically as the `household` account — there is no separate
  auto-login env var.)
- `config.sbx.json` — **schemaVersion 2** (`schemaVersion: 2`): name-based
  `users[]` (Alice/Bob/Carol/Dave, with Carol carrying `pin: "5678"`), two
  tiered accounts, and their access tokens:
  - `household` (token `sbx-household-token`) — Alice + Bob as PRESELECTED
    primaries, Carol + Dave as secondaries, no guests. Matches the `.env.sbx`
    `ACCESS_TOKEN` so auto-login works.
  - `visitor` (token `sbx-visitor-token`) — no primaries, Dave as a secondary,
    Carol as a TERTIARY guest (addable only via the "+ Add guest" modal with
    her pin), for the guest-PIN party proof (`PROOF_FLOW=party-pin`).

  The server resolves these names → Jellyfin ids at startup (`fetchUsers`); no
  UUIDs, legacy `groups[]`/`parties[]` presets, or `household`/password creds
  are written.

Sandbox volumes are disposable. If provisioning or proof ever looks wedged from
old Jellyfin state, reset from scratch instead of migrating it:

```bash
./scripts/e2e.sh down -v
./scripts/e2e.sh up -d jellyfin-sandbox
./scripts/e2e.sh run --rm sandbox-generate
./scripts/e2e.sh run --rm sandbox-provision
```

Re-running any step is **idempotent**: generate skips existing files (`FORCE=1`
to re-encode), provision skips existing users/libraries and reuses the existing
API key.

## Run the app and proof against it

The e2e stack mounts `config.sbx.json` over `/app/config.json` in both the app
and `proof`, and feeds `.env.sbx` to `proof` so seeders get the sandbox
Jellyfin credentials and scope themselves to Alice/Bob/Carol/Dave (not
`gogglebox-admin`, whose stray played-state would desync the rail).

```bash
# 0. (once) sandbox Jellyfin must be up + provisioned (see "Bring it up" above).

# 1. Reset every user to a clean played-state slate.
./scripts/e2e.sh run --rm sandbox-reset

# 2. Bring up the stack. Bare `up -d` skips the one-shot tools-profile services.
#    The proxy (:8080) is the single entrypoint. dev.sh instead runs the source
#    with hot reload.
./scripts/e2e.sh up -d --build --wait

# 3. Run a flow against the sandbox (writes screenshots to ./artifacts):
PROOF_FLOW=mark-all-watched ./scripts/e2e.sh run --rm proof

# For a multi-flow prover pass, reuse one PROOF_RUN_ID for every proof command so
# all screenshots stay grouped under ./artifacts/<PROOF_RUN_ID>/.
PROOF_RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)-sbx" \
  PROOF_FLOW=mark-all-watched ./scripts/e2e.sh run --rm proof

# 4. Tear down when done.
./scripts/e2e.sh down
```

> Gotcha: if a container ever comes up with **no network** (can happen if a prior
> start aborted on a port conflict — symptom: app logs
> `Failed to load viewers from Jellyfin: fetch failed`), recreate it:
> `./scripts/e2e.sh up -d --force-recreate gogglebox`.

## Deterministic reset (between flows)

No container teardown is needed between flows. Reset returns **all** users to a
clean played-state slate — clears every user's `PlayedItems` and zeroes every
Movie/Episode `PlaybackPositionTicks` — fast, no rescan:

```bash
./scripts/e2e.sh run --rm sandbox-reset
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

Tiny but broad. Each video is a **short, 32×32 ffmpeg encode** (default 12s; set
`SANDBOX_VIDEO_SECONDS` to override) so Jellyfin probes a **real (short)
`RunTimeTicks`** — resume %/`setPlaybackPosition`
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
