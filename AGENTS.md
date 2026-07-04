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
against typecheck/test failures before handing off. Before any agent starts
running tests, booting the stack, or visual proof for a feature, the orchestrator
must first make a git checkpoint commit containing the builder's current work.
Use a clearly provisional message such as `checkpoint: before verification` if
the work is not final; later agents may add follow-up fix commits. Only
`gogglebox-builder` edits files under `src/` (and other app code); the other
three are read-only on source.

Subagents cannot spawn subagents, so the orchestrator sequences the chain.

## Efforts are the canonical backlog

`./efforts` on `main` is the canonical source for all work to be done. Effort
specs modified on feature or topic branches are branch-local planning/proposed
updates; they are not canonical until merged or updated on `main`. Before
delegating implementation, verification, runtime, or proof work, the
orchestrator must match the request to an existing effort spec under
`./efforts`. If no matching effort exists, switch to `gogglebox-planner` first.
The planner's only job is to populate `./efforts`, and its write access is
limited to that directory.

Efforts may be broken down into nested subefforts, for example
`auth-refactor/account-access-tokens` or `auth-refactor/account-user-tiers`.
Each effort directory contains a PascalCase markdown spec named for the effort,
such as `AuthRefactor.md`, with Overview, Goals when applicable, Nongoals when
applicable, and ordered Acceptance Criteria.

The acceptance criteria are the controlling checklist for an effort. Each effort
must have at least one acceptance criterion. Criteria must be checked
sequentially, and each criterion must include exactly one unique generated UUIDv7
proof link in this exact style: `[proof](./.proofs/<uuidv7>.md)`. Proof files live
in the effort's hidden `.proofs/` metadata directory, because any non-hidden
directory inside an effort is treated as a subeffort. An acceptance criterion may
require that a subeffort is done; when it does, start the checklist item with
the proof link and link the subeffort slug in the sentence, for example:
`1. [ ] [proof](./.proofs/<uuidv7>.md) that [account-access-tokens](./account-access-tokens/AccountAccessTokens.md) is done`.
Acceptance criteria do not have to be subeffort dependencies; any provable
criterion is valid. Proof is required for each criterion and may copy evidence
from root `./artifacts` into the effort's `.proofs/` directory. Only an approver
who has loaded the whole effort context, including parent effort specs for
nested efforts, may mark acceptance criteria checked. When asked whether an
effort is done, the approver checks each criterion, reads any linked proof,
marks criteria checked only when the proof is sufficient, confirms all visible
child subefforts are done, and then either confirms the effort is done or
lists what remains to be proven.

## Run everything in Docker (host stays minimal)

The host needs only Docker + git. All app execution goes through Compose. The
base file `docker-compose.yml` is the compose **default** (no `-f` needed) and the
shared base for two thin overlays. Source is bind-mounted; deps live in a named
`node_modules` volume (never installed on the host). Use the **Bash tool (Git
Bash)** for commands.

The bare base only carries shared service definitions plus `check`/`test` — it is
**not** a way to run the app. Base commands (no Jellyfin, no config):

```bash
docker compose run --rm check   # typecheck (no Jellyfin)
docker compose run --rm test    # unit tests (no Jellyfin)
docker compose down             # stop
```

### Two run stacks (sbx / uat)
To actually run the app (`server`/`client`/`proof`), use an overlay stack. Each
re-points the base services and mounts its own config over `/app/config.json`;
wrapper scripts avoid typing `-f -f`:

- **sbx** — `./scripts/sbx.sh …` layers `docker-compose.sbx.yml`: a seeded,
  offline sandbox Jellyfin (`.env.sbx` + `config.sbx.json`, both generated). See
  `tools/sandbox/README.md`. e.g.
  `./scripts/sbx.sh up -d`,
  `PROOF_FLOW=mark-all-watched ./scripts/sbx.sh run --rm proof`.
- **uat** — `./scripts/uat.sh …` layers `docker-compose.uat.yml`: the developer's
  **real** Jellyfin (`.env.uat` + `config.uat.json`). Use this to test a feature
  against real data before pushing. e.g. `./scripts/uat.sh up -d`,
  `./scripts/uat.sh run --rm proof`.

Bare `up -d` (no service names) brings up the whole running stack — server +
client + proxy (+ the sandbox Jellyfin under sbx) — and skips the one-shot
`tools`-profile services (`sandbox-generate`/`provision`/`reset`, run those
explicitly with `run --rm`).

URLs (either stack): the proxy is the **single entrypoint** — the same-origin
front door at `http://localhost:8080` (`/` → client, `/api` → server, `/player` →
Jellyfin). `/player` is a Gogglebox proxy mount: Caddy strips it before
forwarding to the normal Jellyfin origin from `JELLYFIN_URL`. Serving everything
from ONE origin lets the gbx client seed Jellyfin-web's localStorage so the
`/player` tab auto-logs-in as the per-group JF user. `server` and `client` bind
**no host ports** — reach them only through the proxy.

### Layered env (`.env` shared + `.env.<env>` overrides)
Compose `env_file:` injects **container runtime** env. The run stacks load an
ordered list `[.env, .env.<env>]`, where the **later file wins**. Keep `.env`
(copied from `.env.example`) for shared defaults such as `SESSION_SECRET`,
`WATCHED_THRESHOLD`, `JELLYFIN_DEBUG`, and dev/proof defaults; put environment-
specific connection and identity values in the overlay file, such as
`JELLYFIN_URL`, `JELLYFIN_API_KEY`, `PORTAL_USERNAME`, and `PORTAL_PASSWORD`.
`JELLYFIN_URL` should be the normal Jellyfin origin, with no `/player` path.

`.env.sbx` is generated by sandbox provisioning; `.env.uat` is hand-created for
the developer's real Jellyfin. There is no `PORTAL_AUTO_LOGIN` var: auto-login is
implicit when portal creds are set and match an `accounts[]` entry. The e2e
harness reads the app's own `GET /api/session` `portalAutoLoginEnabled` to decide
whether to fill the login form.

This runtime `env_file:` layering is distinct from Compose `${VAR}`
interpolation, which happens at parse time and only reads the default `.env`.
The base compose file avoids interpolating Jellyfin connection vars into the
`proof` container, so `docker compose config` can parse without stubbed secrets.

### Jellyfin
`server` (and `proof`) need a **reachable Jellyfin**, supplied by the run stack's
`.env.<env>` override on top of `.env`. The server exits at startup if Jellyfin is
unreachable. The bare base `check`/`test` commands need no Jellyfin.

### Vite cache / blank-SPA recovery
The client's Vite dep-optimizer cache (`cacheDir`) is on an ephemeral tmpfs
(`/tmp/vite`), not the persistent `node_modules` volume, so a stale/half-written
`.vite` can't survive a kill and wedge the next boot with 504s. If the client
ever serves a blank SPA, recover with
`docker compose up -d --force-recreate client` (NOT `restart`, which races the
optimizer).

### Visual proof
The Playwright suite entry is `e2e/run.mjs`. It logs in, then runs one module per
flow under `e2e/flows/`, with shared harness/session/viewer helpers under
`e2e/lib/`. It writes PNGs to `./artifacts/<timestamp>/` for a single flow. When
running several flows as one prover pass, set the same `PROOF_RUN_ID` on every
invocation so screenshots are grouped under
`./artifacts/<PROOF_RUN_ID>/<timestamp-flow>/`. The prover Reads those PNGs to
confirm the UI.

The `player-handoff` flow (Stage A browser auto-login) MUST run against the
same-origin proxy so the localStorage origin matches `/player`. Override the
target via compose `-e` flags — a shell-level `PROOF_URL=...` prefix does NOT
override the compose `environment:` default (which always wins), so use `-e`.
The default `app` flow is unaffected:

```bash
./scripts/sbx.sh run --rm -e PROOF_URL=http://proxy:8080 -e PROOF_FLOW=player-handoff proof
```

It opens a new tab at `/player/web/...` and writes `player-handoff-gbx.png`
(the gbx launch panel) + `player-handoff-jellyfin-loggedin.png` (the Jellyfin
tab, which must show the logged-in home/library and NO manual login form).

## Conventions
- Never break the config schema. Any older `config.json` must roll forward to the
  current shape — extend the `schemaVersion` migration chain in `src/server/config.ts`
  so startup auto-migrates from *any* prior version. Never require a manual migration
  step, never drop support for an old version.
- Keep `README.md` current when project direction, user-facing behavior,
  deployment shape, major workflows, or other human-important project context
  changes. The README is for humans: capture high-level positioning, shipped
  capabilities, practical usage, and roadmap pointers, but do not dump low-level
  implementation detail there.
- Never run `npm`/`node`/`tsc` on the host — use the compose services above.
- If a `docker run` ever needs an absolute in-container path under Git Bash,
  prefix with `MSYS_NO_PATHCONV=1` to stop path mangling. (Plain
  `docker compose ... run` commands above don't need it.)
- Don't commit `artifacts/` (gitignored) — it's run output.
