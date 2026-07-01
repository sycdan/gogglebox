# Gogglebox

_Couch-coop streaming._

Gogglebox is a LAN-first Jellyfin frontend for a household that watches together.
One shared login, then pick **who's watching** (one or more people); everything
after that is scoped to that group.

## What it does

- **Watch as a group, not a profile.** Select multiple viewers at once. Marking
  something watched applies to all of them, and watch state is read back from
  Jellyfin. The portal stores no media data of its own.
- **Continue watching first.** The home screen leads with in-progress titles:
  movies and shows together, so the group resumes without first choosing a
  library.
- **Per-viewer watched pills.** Each continue-watching card shows a pill per
  group member with a check when they've watched the current item; click to
  toggle that person's watched state.
- **Recommendations none of you have seen.** Picks are the library minus the
  union of everything anyone in the selected group has already watched.
- **Hide shows you're done with.** A group can ignore a show to drop it from
  continue-watching, recommendations, and search everywhere; unignore brings it
  back.
- **Find, don't browse.** Rather than rendering the whole library, the selector
  drives a small set of recommendations plus a search box.

Users are referenced by their (unique) Jellyfin name in `config.json`; Gogglebox
resolves names to ids itself at startup. One or more login `accounts[]` each see
only the users they are allowed to, and groups are formed live in the UI (a
group is a Jellyfin user created on demand). Jellyfin remains the source of truth
for library, metadata, and watch history; Gogglebox is a thin group-aware layer
on top.

See [BACKLOG.md](BACKLOG.md) for the roadmap.

## Deployment

Deployment is for someone who wants to run Gogglebox on their LAN, not work on
the code. The host only needs Docker Compose and this repo checkout. The deploy
stack pulls a published Gogglebox image and runs it behind a small Caddy
front-door proxy so the app and Jellyfin Web share one browser origin:

- `/` and `/api/*` -> Gogglebox
- `/player/*` -> your Jellyfin server

That same-origin `/player` route is required for the embedded Jellyfin player to
auto-login and start playback.

### 1. Get the deploy files

Clone the repo on the machine that will host Gogglebox:

```bash
git clone <repo-url>
cd gogglebox
```

You will only edit files under `deploy/`.

### 2. Configure users and accounts

Copy the example config and edit it. Config is **schemaVersion 1**
(`"schemaVersion": 1`): list your Jellyfin users by **name** under `users[]`,
then add one or more login
`accounts[]` (a household), each listing the users it may see under
`visible_users[]`. A user can optionally have a `pin`, and an account can mark a
visible user `pin_required` so forming a group with them prompts for that pin.

```bash
cp deploy/config.example.json deploy/config.json
```

```jsonc
{
  "schemaVersion": 1,
  "users": [
    { "jellyfin_name": "A", "pin": "1234" },
    { "jellyfin_name": "B" }
  ],
  "accounts": [
    {
      "username": "house1",
      "password": "set-a-real-password",
      "visible_users": [{ "jellyfin_name": "A" }, { "jellyfin_name": "B" }]
    },
    {
      "username": "house2",
      "password": "set-a-real-password",
      "visible_users": [{ "jellyfin_name": "A", "pin_required": true }]
    }
  ]
}
```

`deploy/config.json` is mounted read-only into the container at
`/app/config.json` as a **source of overrides**. On startup the server
**auto-migrates** it forward to the schema the running image expects (an integer
`schemaVersion`; a config with no `schemaVersion` is treated as the legacy v1
UUID-based config and migrated automatically), seeds defaults from the bundled
example, overlays your values, and caches the derived "effective config" in its
writable `/data` state — your file is never rewritten. Reverting to an older
image re-derives from the same file, so rollback just works. Unresolvable
references (a `jellyfin_name` with no matching Jellyfin user) are **dropped with
a warning** rather than crashing; startup fails fast only if the result is
unusable (no users or no accounts) or the file's `schemaVersion` is newer than
this image understands. Use the exact Jellyfin user **names** (Jellyfin admin →
Users) — you never paste a UUID. Noteworthy config changes are called out in the
GitHub release notes.

### 3. Configure the environment

Copy the deploy env template and fill it in:

```bash
cp deploy/.env.example deploy/.env
```

Required values:

| Var | Purpose |
| --- | --- |
| `GOGGLEBOX_PORT` | Host port for the app front door |
| `JELLYFIN_URL` | Normal Jellyfin origin used by Gogglebox server/API calls and the `/player` proxy; do not include `/player` |
| `JELLYFIN_API_KEY` | Jellyfin API key |
| `SESSION_SECRET` | Long random string for session cookies |

The image is pulled from the project's public GHCR namespace
(`ghcr.io/sycdan/gogglebox`) — no registry login or config needed.

Example for a LAN Jellyfin at `http://jellyfin.lan:8096`:

```env
GOGGLEBOX_PORT=3000
JELLYFIN_URL=http://jellyfin.lan:8096
JELLYFIN_API_KEY=replace-me
SESSION_SECRET=replace-with-a-long-random-secret
```

Generate a session secret with:

```bash
openssl rand -hex 32
```

Optional values:

| Var | Default | Purpose |
| --- | --- | --- |
| `GOGGLEBOX_VERSION` | `latest` | Image tag to pull; pin a version tag for reproducible deploys |
| `GOGGLEBOX_STATE_DIR` | `./data` under `deploy/` | Host directory for writable app state |
| `WATCHED_THRESHOLD` | `0.9` | Fraction watched before an item counts as watched |
| `PORTAL_USERNAME` / `PORTAL_PASSWORD` | unset | Optional auto-login: when set AND matching an `accounts[]` entry, that account is logged in automatically (skipping the login screen); otherwise leave unset and log in via the UI |
| `JELLYFIN_DEBUG` | `false` | Log outbound Jellyfin requests with timing |

### 4. Start Gogglebox

Run from the repo root:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

Open:

```text
http://<host>:<GOGGLEBOX_PORT>
```

For example, if `GOGGLEBOX_PORT=3000` and the host is `media.lan`, open
`http://media.lan:3000`.

Check status and logs:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f
```

Stop:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env down
```

### 5. Update

Set `GOGGLEBOX_VERSION` in `deploy/.env` to the image tag you want, then run:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

The compose file uses `pull_policy: always`, so `up -d` pulls the configured tag
before recreating containers. Pin a specific tag instead of `latest` when you
want deterministic roll-forward/rollback.

### Writable State

The portal writes runtime state (e.g. the per-group list of ignored items) to
`/data/state.json` inside the container. That path is bind-mounted from the host
via `GOGGLEBOX_STATE_DIR` (default `./data`, relative to `deploy/`) so it
survives redeploys. Set it to an absolute path for a real deployment:

```bash
GOGGLEBOX_STATE_DIR=/var/lib/gogglebox
```

Because the container runs as uid **1000**, the host state dir must be writable
by uid 1000. Otherwise writes fail with `EACCES` and actions like ignoring a show
return an error. A freshly created host dir is usually owned by root, so chown it
once after first deploy:

```bash
sudo mkdir -p /var/lib/gogglebox
sudo chown -R 1000:1000 /var/lib/gogglebox
```

## Development (Docker)

All dev execution runs in containers via [docker-compose.yml](docker-compose.yml),
so the host only needs Docker + git: no Node install, no host `node_modules`
(deps live in a named volume). `docker-compose.yml` is the compose default (the
shared base), so no `-f` is needed for the no-config commands:

```bash
docker compose run --rm check   # typecheck (no Jellyfin)
docker compose run --rm test    # unit tests (no Jellyfin)
docker compose down             # stop
```

The bare base is **not** a way to run the app. It carries the shared service
definitions plus `check`/`test` only. Running the actual app (`server`/`client`/
`proof`) requires a stack overlay that supplies its own Jellyfin + config: use
`./scripts/sbx.sh` (seeded offline sandbox) or `./scripts/uat.sh` (your real
Jellyfin). See the next section.

The **proxy is the single entrypoint**: the whole app is served from one origin,
`http://localhost:8080` (Caddy routes `/api` → server, `/player` → Jellyfin,
`/*` → client). `/player` is a Gogglebox proxy mount; Caddy strips it before
forwarding to the normal Jellyfin origin from `JELLYFIN_URL`. `server` and
`client` bind no host ports — reach them only through the proxy. The `proof`
service drives the app with Playwright and writes screenshots to `./artifacts/`.

### Two run stacks: sbx and uat

The base only does typecheck/tests. To actually run the app, pick a stack: two
thin overlays re-point `server`/`proof` (and mount their own config over
`/app/config.json`) without duplicating services; wrapper scripts save you typing
`-f -f`:

| Stack | Jellyfin | Command | Env / config |
| --- | --- | --- | --- |
| base | none (shared defs + check/test only) | `docker compose ...` | `.env` - not a runnable app stack |
| **sbx** | seeded offline sandbox | `./scripts/sbx.sh ...` | `.env` + `.env.sbx`, `config.sbx.json` (generated) |
| **uat** | your **real** Jellyfin | `./scripts/uat.sh ...` | `.env` + `.env.uat`, `config.uat.json` |

**Layered env.** `.env` (copied from `.env.example`) holds the **shared** config
every stack uses (`SESSION_SECRET`, `WATCHED_THRESHOLD`, `JELLYFIN_DEBUG`, the
Vite/proof URLs). Each run stack appends an
**overrides-only** `.env.<env>` on top; compose loads the env files in order, so
later wins. The override file carries environment-specific connection/identity
values such as `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `PORTAL_USERNAME`, and
`PORTAL_PASSWORD`. `JELLYFIN_URL` is the normal Jellyfin origin, with no
`/player` path. `.env.sbx` is **generated** by sandbox provisioning; `.env.uat`
you create by hand.

```bash
# uat (real Jellyfin, e.g. to test a feature before pushing):
cp .env.example .env                         # shared config (once)
cat > .env.uat <<'EOF'                       # overrides-only: your real values
JELLYFIN_URL=https://your-real-jellyfin
JELLYFIN_API_KEY=...
PORTAL_USERNAME=...
PORTAL_PASSWORD=...
EOF
cp deploy/config.example.json config.uat.json # set real Jellyfin user names + an account matching PORTAL_*
./scripts/uat.sh up -d                        # server + client + proxy (single door :8080)
PROOF_FLOW=continue-watching ./scripts/uat.sh run --rm proof

# sbx (seeded offline sandbox - see tools/sandbox/README.md to provision):
./scripts/sbx.sh run --rm sandbox-reset
./scripts/sbx.sh up -d                        # jellyfin + server + client + proxy
PROOF_FLOW=mark-all-watched ./scripts/sbx.sh run --rm proof
```

### Delegated build-test-prove

This repo is set up so Claude's main session acts as an orchestrator that
delegates to subagents in [.claude/agents/](.claude/agents/). It never edits app
code directly:

- **gogglebox-builder** - designs + implements features, self-heals against
  failing checks/tests.
- **gogglebox-runtime** - boots the stack and reports URLs/logs.
- **gogglebox-verifier** - runs typecheck + tests.
- **gogglebox-prover** - drives the UI with Playwright and reads the screenshots
  to visually prove a feature works.

See [CLAUDE.md](CLAUDE.md) for the full protocol.

### Pre-push hook

[.githooks/pre-push](.githooks/pre-push) gates every push — clean tree, a version
bump when an image input changed on `main` (see
[Versioning + publishing](#versioning--publishing)), typecheck, unit tests, and a
production image build. The exact steps and the image-input rule live in the hook's
header comment. The same typecheck + tests also gate the publish workflow
server-side, so a known-broken image is never built.

Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

### Versioning + publishing

Images publish automatically — deployers run none of this. The model is **build
once, test once, promote**: each publish-worthy change on `main` is built and tested
as an immutable prerelease image, and a release _promotes_ one of those prebuilt
images to a pinnable tag (no rebuild), so released bits are byte-identical to what
was tested. Versions are calendar-based: a prerelease between releases, stripped
to a clean `YYYY.M.D` on release. The exact prerelease format lives in
[scripts/bump.sh](scripts/bump.sh).

The mechanics live in each file's header comment (the single source of truth — this
section stays high-level so it can't drift). A maintainer runs two commands:

- **Bump** before pushing an image change to `main`: `./scripts/bump.sh`
  ([scripts/bump.sh](scripts/bump.sh)) — enforced by the
  [pre-push hook](.githooks/pre-push), which owns the image-input list.
- **Release**: `gh workflow run release.yml`
  ([release.yml](.github/workflows/release.yml)) — promotes the prebuilt image to
  `YYYY.M.D` + `latest` and opens a GitHub Release.

The build+test-on-bump workflow is
[publish.yml](.github/workflows/publish.yml) (tags the image with the exact
prerelease version; no `latest`).

**Deployers** pin a release with `GOGGLEBOX_VERSION=2026.6.29` and
`git checkout v2026.6.29` for the matching `deploy/` shape. One release per date (a
collision guard blocks a second).

## Roadmap


---

In loving memory of [Oggie](./mascot.jpg).
