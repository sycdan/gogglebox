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

Viewers and groups map to Jellyfin user ids in `config.json`. Jellyfin remains
the source of truth for library, metadata, and watch history; Gogglebox is a thin
group-aware layer on top.

See [BACKLOG.md](BACKLOG.md) for the roadmap.

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

Client: `http://localhost:5173` - API: `http://localhost:3000`. The `proof`
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
every stack uses (`SESSION_SECRET`, `WATCHED_THRESHOLD`, `PORTAL_AUTO_LOGIN`,
`JELLYFIN_DEBUG`, `REGISTRY_HOST`, the Vite/proof URLs). Each run stack appends an
**overrides-only** `.env.<env>` on top; compose loads the env files in order, so
later wins. The override file carries just the four connection/identity vars:
`JELLYFIN_URL`, `JELLYFIN_API_KEY`, `PORTAL_USERNAME`, `PORTAL_PASSWORD`.
`.env.sbx` is **generated** by sandbox provisioning; `.env.uat` you create by hand.

```bash
# uat (real Jellyfin, e.g. to test a feature before pushing):
cp .env.example .env                         # shared config (once)
cat > .env.uat <<'EOF'                       # overrides-only: your real values
JELLYFIN_URL=https://your-real-jellyfin
JELLYFIN_API_KEY=...
PORTAL_USERNAME=...
PORTAL_PASSWORD=...
EOF
cp deploy/config.example.json config.uat.json # set real Jellyfin user ids
./scripts/uat.sh up -d server client
PROOF_FLOW=continue-watching ./scripts/uat.sh run --rm proof

# sbx (seeded offline sandbox - see tools/sandbox/README.md to provision):
./scripts/sbx.sh run --rm sandbox-reset
./scripts/sbx.sh up -d server client
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

[.githooks/pre-push](.githooks/pre-push) gates every push: it fails if the
working tree is dirty, runs the typecheck ("lint" - there is no eslint), then
builds and publishes the production image to the registry via
[scripts/docker-publish.sh](scripts/docker-publish.sh) (the script does the
`docker build`). The push only proceeds if all of that is green, so
`REGISTRY_HOST` must be set (in `.env` or the environment) or the publish step,
and the push, will fail.

Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

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

### 2. Configure the household

Copy the example config and replace the placeholder Jellyfin user ids with the
real Jellyfin user ids for your household. Groups are configured here, not baked
into the image.

```bash
cp deploy/config.example.json deploy/config.json
```

`deploy/config.json` is mounted read-only into the container at
`/app/config.json`. The server fails fast at startup if it is missing, empty, or
invalid JSON.

To find Jellyfin user ids, open Jellyfin as an admin and inspect each user's id
from the user details page/API, then put those ids in the `memberIds` arrays.

### 3. Configure the environment

Copy the deploy env template and fill it in:

```bash
cp deploy/.env.example deploy/.env
```

Required values:

| Var | Purpose |
| --- | --- |
| `REGISTRY_HOST` | Registry host to pull the Gogglebox image from |
| `GOGGLEBOX_PORT` | Host port for the app front door |
| `JELLYFIN_URL` | Jellyfin URL used by Gogglebox server/API calls |
| `JELLYFIN_API_KEY` | Jellyfin API key |
| `JELLYFIN_PROXY_UPSTREAM` | Jellyfin origin for `/player/*`, usually the same origin as `JELLYFIN_URL` but without any `/player` base path |
| `SESSION_SECRET` | Long random string for session cookies |

Example for a LAN Jellyfin at `http://htpc.lan:8096`:

```env
REGISTRY_HOST=registry.example.com:5000
GOGGLEBOX_PORT=3000
JELLYFIN_URL=http://htpc.lan:8096
JELLYFIN_PROXY_UPSTREAM=http://htpc.lan:8096
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
| `PORTAL_USERNAME` / `PORTAL_PASSWORD` | unset | Shared household login credentials |
| `PORTAL_AUTO_LOGIN` | `false` | Skip the login screen on a trusted LAN |
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

### Publishing Images

End users normally do not need this step if a Gogglebox image has already been
published to your registry. Maintainers can build and publish from the repo root
with [scripts/docker-publish.sh](scripts/docker-publish.sh). It reads `.env` for
defaults, then pushes both `latest` and a timestamped `yyyy.m.d.<minute-of-day>`
tag from the same build:

```bash
REGISTRY_HOST=registry.example.com:5000 ./scripts/docker-publish.sh
```

Overrides:

```bash
REGISTRY_HOST=registry.example.com:5000 IMAGE_NAME=gogglebox ./scripts/docker-publish.sh
REGISTRY_HOST=registry.example.com:5000 PLATFORM=linux/amd64 ./scripts/docker-publish.sh
```

---

In loving memory of [Oggie](mascot.jpg).
