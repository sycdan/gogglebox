# Gogglebox — agent guide

Gogglebox is a LAN-first Jellyfin household frontend. Express API + React/Vite
client, TypeScript throughout. Backend entry `src/server/server.ts`, client
`src/client/App.tsx`, config `src/server/config.ts`, Jellyfin client
`src/server/jellyfin.ts`.

## Orchestration protocol (read first)

The main session is the **orchestrator**. It plans and delegates — it does **not**
edit application code itself. Classify each request and delegate to a subagent:

| Request | Delegate to |
| --- | --- |
| Build / change / fix a feature | `gogglebox-builder` |
| Run / boot the stack, report URLs & logs | `gogglebox-runtime` |
| Typecheck / unit / e2e verification | `gogglebox-verifier` |
| Visually prove a user-visible feature | `gogglebox-prover` |

Typical feature flow: **builder → verifier → prover**. The builder self-heals
against typecheck/test failures before handing off. Only `gogglebox-builder` edits
files under `src/` (and other app code); the other three are read-only on source.

Subagents cannot spawn subagents, so the orchestrator sequences the chain.

## Run everything in Docker (host stays minimal)

The host needs only Docker + git. All app execution goes through
`docker-compose.dev.yml`. Source is bind-mounted; deps live in a named
`node_modules` volume (never installed on the host). Use the **Bash tool (Git
Bash)** for commands.

```bash
docker compose -f docker-compose.dev.yml run --rm check        # typecheck (no Jellyfin)
docker compose -f docker-compose.dev.yml run --rm test         # unit tests (no Jellyfin)
docker compose -f docker-compose.dev.yml up -d server client   # full stack
docker compose -f docker-compose.dev.yml --profile proof run --rm -e PROOF_FLOW=my-feature proof   # visual proof
docker compose -f docker-compose.dev.yml down                  # stop
```

URLs: client `http://localhost:5173`, API `http://localhost:3000`.

### Jellyfin
`server` (and `proof`) need a **reachable real Jellyfin** via `.env`
(`JELLYFIN_URL`, `JELLYFIN_API_KEY`, real `PORTAL_USERNAME`/`PORTAL_PASSWORD`).
The server exits at startup if Jellyfin is unreachable. `check` and `test` need
no Jellyfin.

### Vite cache / blank-SPA recovery
The client's Vite dep-optimizer cache (`cacheDir`) is on an ephemeral tmpfs
(`/tmp/vite`), not the persistent `node_modules` volume, so a stale/half-written
`.vite` can't survive a kill and wedge the next boot with 504s. If the client
ever serves a blank SPA, recover with
`docker compose -f docker-compose.dev.yml up -d --force-recreate client` (NOT
`restart`, which races the optimizer).

### Visual proof
The Playwright suite entry is `e2e/run.mjs`. It logs in, then runs one module per
flow under `e2e/flows/`, with shared harness/session/viewer helpers under
`e2e/lib/`. It writes PNGs to `./artifacts/<timestamp>/`. The prover Reads those
PNGs to confirm the UI.

## Conventions
- Never run `npm`/`node`/`tsc` on the host — use the compose services above.
- If a `docker run` ever needs an absolute in-container path under Git Bash,
  prefix with `MSYS_NO_PATHCONV=1` to stop path mangling. (Plain
  `docker compose ... run` commands above don't need it.)
- Don't commit `artifacts/` (gitignored) — it's run output.
