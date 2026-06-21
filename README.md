# Gogglebox

Gogglebox is a shared-household Jellyfin frontend that helps people browse the library together, pick something to watch, and keep session state in sync between the server and client.

See [BACKLOG.md](BACKLOG.md) for the roadmap.

## Development (Docker)

All dev execution runs in containers via [docker-compose.dev.yml](docker-compose.dev.yml),
so the host only needs Docker + git — no Node install, no host `node_modules`
(deps live in a named volume). Copy `.env.example` to `.env` first; `server` and
`proof` need a reachable real Jellyfin.

```bash
docker compose -f docker-compose.dev.yml run --rm check        # typecheck (no Jellyfin)
docker compose -f docker-compose.dev.yml run --rm test         # unit tests (no Jellyfin)
docker compose -f docker-compose.dev.yml up -d server client   # full stack
docker compose -f docker-compose.dev.yml --profile proof run --rm proof   # visual proof
docker compose -f docker-compose.dev.yml down                  # stop
```

Client: `http://localhost:5173` · API: `http://localhost:3000`. The `proof`
service drives the app with Playwright and writes screenshots to `./artifacts/`.

### Delegated build–test–prove

This repo is set up so Claude's main session acts as an orchestrator that
delegates to subagents in [.claude/agents/](.claude/agents/) — it never edits app
code directly:

- **gogglebox-builder** — designs + implements features, self-heals against
  failing checks/tests.
- **gogglebox-runtime** — boots the stack and reports URLs/logs.
- **gogglebox-verifier** — runs typecheck + tests.
- **gogglebox-prover** — drives the UI with Playwright and reads the screenshots
  to visually prove a feature works.

See [CLAUDE.md](CLAUDE.md) for the full protocol.

## Docker

Publish the image to the registry (builds, tags, and pushes in one step):

```bash
REGISTRY_HOST=registry.example.com:5000 ./scripts/docker-publish.sh
```

Override the image name and tag too:

```bash
REGISTRY_HOST=registry.example.com:5000 IMAGE_NAME=gogglebox IMAGE_TAG=v1.0.0 ./scripts/docker-publish.sh
```

Optional platform override (passed through to build):

```bash
REGISTRY_HOST=registry.example.com:5000 PLATFORM=linux/amd64 ./scripts/docker-publish.sh
```

Deploy also requires a `config.json` next to the compose file. It holds the
household groups (and playback settings) and is bind-mounted read-only into the
container (`./config.json:/app/config.json:ro`) rather than baked into the image.
Copy `config.example.json` to `config.json` and fill in real Jellyfin user ids
(the server fails fast at startup if it is missing, empty, or invalid JSON):

```bash
cp config.example.json config.json
```

Deploy with Docker Compose. Container vars are interpolated from the env file
passed via `--env-file` (auto-loads `.env` if the flag is omitted). Copy
`.env.example` and fill it in:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env up -d
```

Deploy with a specific env file:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env.production up -d
```

Required vars (compose fails fast if unset): `REGISTRY_HOST` (registry host
for the image), `GOGGLEBOX_PORT` (host port), `JELLYFIN_URL`,
`JELLYFIN_API_KEY`, `SESSION_SECRET`.

The container listens on port `3000` internally and serves both API routes and the built client from `dist/client`.
