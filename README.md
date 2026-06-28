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
| `GOGGLEBOX_PORT` | Host port for the app front door |
| `JELLYFIN_URL` | Jellyfin URL used by Gogglebox server/API calls |
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
| `PORTAL_USERNAME` / `PORTAL_PASSWORD` | unset | Shared household login credentials |
| `PORTAL_AUTO_LOGIN` | `false` | Skip the login screen on a trusted LAN |
| `JELLYFIN_DEBUG` | `false` | Log outbound Jellyfin requests with timing |
| `JELLYFIN_PROXY_UPSTREAM` | `JELLYFIN_URL` | Override the `/player/*` proxy origin; only needed when the proxy must reach Jellyfin at a different origin than the portal |

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
`JELLYFIN_DEBUG`, the Vite/proof URLs). Each run stack appends an
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
builds the production image as a gate. It does not publish — that is CI's job
(see [Publishing images](#publishing-images)). The push only proceeds if all of
that is green.

Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

### Publishing images

End users do not run this — images are published automatically. There are two
channels:

**Rolling** ([.github/workflows/publish.yml](.github/workflows/publish.yml)) —
runs on every push to `main`. Builds the multi-arch (`linux/amd64`,
`linux/arm64`) image with the built-in `GITHUB_TOKEN` (no PAT) and tags it twice:

- `latest` — rolling pointer to the newest build,
- `yyyymmddhhmmss` (UTC) — immutable, sortable pin for ad-hoc reproducible pulls.

**Release** ([.github/workflows/release.yml](.github/workflows/release.yml)) —
the pinnable channel. One manual run does everything:

```bash
gh workflow run release.yml
```

It computes a calendar version `YYYY.M.D` (e.g. `2026.6.28`), stamps it into
`package.json` and commits that to `main` (with `[skip ci]` so the rolling build
does not double-fire), builds + pushes the image tagged `YYYY.M.D` (and
`latest`), pushes the git tag `v2026.6.28`, and opens a GitHub Release with
generated notes. The image tag / pin is bare (`2026.6.28`) while the git tag
carries a `v` (gh convention), so a deployer who pins
`GOGGLEBOX_VERSION=2026.6.28` runs `git checkout v2026.6.28` to get the exact
`deploy/` shape that shipped with it.

One release per day: a second run the same day fails on the collision guard
before changing anything. The package must be public for unauthenticated
`docker pull` to work: after the first run, open the `gogglebox` package on
GitHub -> Package settings -> change visibility to **Public**.

To publish manually (rare), log in to GHCR with a PAT that has `write:packages`,
then build and push:

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u sycdan --password-stdin
docker build -t ghcr.io/sycdan/gogglebox:latest .
docker push ghcr.io/sycdan/gogglebox:latest
```

---
