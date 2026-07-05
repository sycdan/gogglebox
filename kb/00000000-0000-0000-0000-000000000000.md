# Gogglebox — agent guide

Gogglebox is a LAN-first Jellyfin household frontend. Express API + React/Vite
client, TypeScript throughout. Backend entry `src/server/server.ts`, client
`src/client/App.tsx`, config `src/server/config.ts`, Jellyfin client
`src/server/jellyfin.ts`.

## Generating a UUIDv7

Whenever any workflow step below calls for a fresh UUIDv7 (e.g. `prompt_id`,
a proof-link filename, etc.), generate it with
`docker compose run --rm check npm run gen:uuid7 --silent` — never hand-pick
or reuse one.

## Orchestration protocol (read first)

The main session is the **orchestrator**. It plans and delegates — it does
**not** edit application code itself. Classify each request and delegate to a
subagent:

| Request                                            | Delegate to          |
| -------------------------------------------------- | -------------------- |
| Build / change / fix a feature                     | `gogglebox-builder`  |
| Run / boot the stack, report URLs & logs           | `gogglebox-runtime`  |
| Typecheck / unit / e2e verification                | `gogglebox-verifier` |
| Visually prove a user-visible feature              | `gogglebox-prover`   |
| Decide whether proof satisfies acceptance criteria | `gogglebox-approver` |
| Plan an effort / scope work                        | `gogglebox-planner`  |

Typical feature flow: **planner, when needed -> builder -> verifier -> runtime
and/or prover -> approver**. Subagents cannot spawn subagents, so the
orchestrator sequences the chain. Only `gogglebox-builder` edits files under
`src/` (and other app code); all other agents are read-only on source.

Before handing work to any subagent, the orchestrator must write the exact
handoff prompt to the effort tree at `<effort-dir>/.prompts/<uuidv7>.md`. The
prompt file must start with frontmatter containing at least:

```yaml
---
prompt_id: <uuidv7>
target_agent: <agent>
effort_path: <effort-spec-path>
output_path: <effort-dir>/.outputs/<output-uuidv7>.md
base_tag: handoff/<prompt_id>
session_name: <deepest-effort-slug>.<...>.<root-effort-slug>.<utcmillis>
---
```

`prompt_id` and the uuidv7 embedded in `output_path` (`<output-uuidv7>`) are
**two separate freshly-generated UUIDv7s**, decided by the orchestrator up
front before writing the prompt file — never reuse `prompt_id` as the output
filename. This keeps the `.prompts/<uuidv7>.md` and `.outputs/<uuidv7>.md`
filenames independently unique and independently sortable, even though the
frontmatter still links them (`output_path` declared inside the prompt is the
request/response link, not a shared id).

`session_name` is the effort's slug chain, **deepest subeffort first** (the
reverse of the directory path), dot-separated, with the UTC-millis timestamp of
worktree creation appended last. For `efforts/auth-refactor/guest-pin-rework`
that's `guest-pin-rework.auth-refactor.<utcmillis>`; for a top-level effort with
no parent it's just `top-level-effort.<utcmillis>`.

Here `<effort-spec-path>` is the PascalCase markdown spec file, such as
`efforts/auth-refactor/AuthRefactor.md` or
`efforts/auth-refactor/guest-pin-rework/GuestPinRework.md`; `<effort-dir>` is
the directory containing that spec. The prompt body must include the effort spec
path, the relevant acceptance criteria, what phase the agent is doing, what it
may edit or run, and the fact that the agent's final response must be written to
the declared `output_path`. The orchestrator commits that prompt on `main`
before sending it, using this message pattern:
`prompt(<effort-dir>/.prompts/<uuidv7>.md): handoff to <agent>`. After that
commit, the orchestrator creates the temporary tag named by `base_tag`, pointing
at the prompt commit. `base_tag` must use the same UUIDv7 as `prompt_id`, e.g.
`handoff/019...`. The committed prompt file and tag are the durable handoff
inputs: if work resumes in a later session or on another machine, load that
prompt and tag from git rather than relying on prior chat context. If the
handoff crosses machines, push both `main` and the temporary tag; after the
squash lands, delete the temporary tag locally and remotely.

Immediately after creating `base_tag`, and before dispatching the subagent, the
orchestrator creates that call's dedicated worktree and branch with plain git —
no harness-specific isolation feature, since subagents may run under different
tools/harnesses over the life of a repo and AGENTS.md must not assume one:

```bash
git worktree add ./sessions/<session_name> -b <session_name> <base_tag>
```

The handoff prompt must tell the subagent, as its first instruction, to `cd` into
`./sessions/<session_name>` before doing anything else and to make all edits,
commands, and commits from there. This is a prompt-level instruction, not a
harness guarantee, so the orchestrator never trusts compliance blindly — see
verification below.

Subagents work in that dedicated `./sessions/<session_name>` worktree/branch,
not directly on `main`. They do not _need_ to make any commits. A subagent
signals that its phase is ready for the orchestrator by writing its final
summary to the exact `output_path` from the prompt. If that file is absent, the
phase is still in progress or blocked and the orchestrator must not advance the
effort. The output file does not need frontmatter; the prompt's declared
`output_path` is the request/response link. The orchestrator is the only actor
allowed to commit or merge to `main`.

When the orchestrator consumes a subagent handoff, it first verifies that
`base_tag` exists, the `./sessions/<session_name>` branch actually descends from
the commit named by that tag, and the declared `output_path` exists inside that
worktree. This is also the check that catches a subagent that ignored the
prompt's `cd` instruction and worked somewhere else despite it — the branch
will be missing the expected commits or the output file won't be where it's
declared, and the orchestrator must not advance the effort in that case. For a
`gogglebox-prover` handoff specifically, the orchestrator also greps every
`.proofs/*.md` file touched in that worktree for a `./artifacts` or bare
`artifacts/` reference before squashing or tearing anything down; `./artifacts`
is gitignored and the worktree is about to be deleted, so a proof doc still
pointing there is not durable evidence and will be silently unrecoverable once
the session is torn down. If any is found, the orchestrator does not
squash/teardown — it re-prompts the same prover session to copy the missing
evidence into `.proofs/` first. If the worktree has uncommitted changes, the
orchestrator stages them and makes a
mechanical snapshot commit in the session branch so the range can be consumed.
The orchestrator then squashes exactly the commits in `base_tag..<session-branch-head>`
into one commit on `main` with this message:
`output(<output_path>): handoff from <agent>`, where `<output_path>` is the
prompt's declared `output_path` (e.g.
`efforts/auth-refactor/.outputs/<uuidv7>.md`). This keeps `main`
phase-oriented while letting session branches contain any number of local
progress commits or none at all. After the squash lands successfully on `main`,
the orchestrator removes the temporary `base_tag`, then tears the session down
with `scripts/teardown-session.sh <session_name>` — never bare
`git worktree remove` — since a subagent's `docker compose run --rm
check/test/...` leaves its `deps` dependency container (the one-shot `npm ci`
service other services `depends_on`) exited but not removed, and on Windows an
exited container can still hold the bind-mounted worktree open and make plain
`git worktree remove` fail with a permission/busy error. The script's
`docker compose down -v --remove-orphans` (run from inside the worktree, so the
project name matches whatever the subagent's un-prefixed `docker compose ...`
commands auto-derived) clears that before removing the worktree and deleting
the branch.

After `gogglebox-verifier` reports successful static verification, the
orchestrator must land the verified session-branch state on `main` using the same
output-file and tag-bounded squash rule before delegating runtime or visual
proof work for that effort.

## Efforts are the canonical backlog

`./efforts` on `main` is the canonical source for all work to be done. Effort
specs modified on other branches are planning/proposed updates; they are not
considered real until merged or updated on `main`. Before delegating
implementation, verification, runtime, proof, or planning work, the orchestrator
must identify the relevant effort path under `./efforts`. **All subagent work**
must tie back to an effort, with no exceptions.

If no matching effort exists yet, the orchestrator creates the effort directory
on `main` before delegating. It must add `.prompts/`, `.outputs/`, `.proofs/`,
and a stub PascalCase effort spec such as `EffortName.md` containing the
standard headings (`Overview`, `Goals`, `Nongoals`, and `Acceptance Criteria`)
plus brief placeholder text saying the planner must populate the spec. The first
handoff prompt goes in that effort's `.prompts/` directory and must target
`gogglebox-planner`, instructing it to replace the stub with a complete effort
spec and any findings needed for later phases. Commit the stub and prompt on
`main` with the `prompt(...): handoff to gogglebox-planner` message pattern. The
planner's write access is limited to `./efforts`.

Efforts may be broken down into nested subefforts, for example
`auth-refactor/account-access-tokens` or `auth-refactor/account-user-tiers`.
Each effort directory contains a PascalCase markdown spec named for the effort,
such as `AuthRefactor.md`, with Overview, Goals when applicable, Nongoals when
applicable, and ordered Acceptance Criteria.

The acceptance criteria are the controlling checklist for an effort. Each effort
must have at least one acceptance criterion. Criteria should be written in the
preferred implementation/proof order when an order matters. Criteria may be
proven and checked independently unless a criterion explicitly depends on an
earlier criterion or subeffort. Each criterion must include exactly one unique
generated UUIDv7 proof link in this exact style:
`[proof](./.proofs/<uuidv7>.md)`. Planners seed these proof links when writing
the acceptance criteria so each criterion has a stable identity throughout
implementation and proofing; the proof file itself is not expected to exist
until the criterion has actually been proven. A missing proof file is therefore
normal for unchecked criteria and means the criterion is not yet checkable, not
that the effort spec is malformed. Prompt files live in the effort's hidden
`.prompts/` metadata directory, subagent output summaries live in `.outputs/`,
and proof files live in `.proofs/`, because any non-hidden directory inside an
effort is treated as a subeffort. An acceptance criterion may require that a
subeffort is done; when it does, start the checklist item with the proof link
and link the subeffort slug in the sentence, for example:

```markdown
1. [ ] [proof](./.proofs/<uuidv7>.md) that [auth-refactor](./auth-refactor/AuthRefactor.md) is done
```

Acceptance criteria do not have to be subeffort dependencies; any provable
criterion is valid. Proof is required for each criterion; any screenshot
evidence must be copied from root `./artifacts` into the effort's `.proofs/`
directory (`./artifacts` is gitignored and does not survive a session's
worktree being torn down, `.proofs/` is not) — a proof doc that still
references `./artifacts` is not sufficient proof. Only an approver
who has loaded the whole effort context, including parent effort specs for
nested efforts, may mark acceptance criteria checked. When asked whether an
effort is done, the approver checks each criterion, reads any linked proof,
marks criteria checked only when the proof is sufficient, confirms all visible
child subefforts are done, and then either confirms the effort is done or lists
what remains to be proven.

`gogglebox-approver` may edit only under `efforts/`. If proof is sufficient, the
approver updates the relevant effort spec by checking the satisfied acceptance
criteria and writes its final summary to the declared `.outputs/<uuidv7>.md`
file. That summary must list which criteria were checked, which remain
unchecked, and why. Checked acceptance criteria become canonical only after the
orchestrator consumes the approver handoff onto `main` with the standard
tag-bounded squash rule.

## Run everything in Docker (host stays minimal)

The host needs only Docker + git. All app execution goes through Compose. The
base file `docker-compose.yml` is the compose **default** (no `-f` needed) and
the shared base for environment overlays. Source is bind-mounted; deps live in a
named `node_modules` volume, never installed on the host.

The bare base only carries shared service definitions plus `check`/`test` — it
is **not** a way to run the app. Base commands (no Jellyfin, no config):

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
  `tools/sandbox/README.md`. e.g. `./scripts/sbx.sh up -d`,
  `PROOF_FLOW=mark-all-watched ./scripts/sbx.sh run --rm proof`.
- **uat** — `./scripts/uat.sh …` layers `docker-compose.uat.yml`: the
  developer's **real** Jellyfin (`.env.uat` + `config.uat.json`). Use this to
  test a feature against real data before pushing. e.g.
  `./scripts/uat.sh up -d`, `./scripts/uat.sh run --rm proof`.

Bare `up -d` (no service names) brings up the whole running stack — server +
client + proxy (+ the sandbox Jellyfin under sbx) — and skips the one-shot
`tools`-profile services (`sandbox-generate`/`provision`/`reset`, run those
explicitly with `run --rm`).

URLs (either stack): the proxy is the **single entrypoint** — the same-origin
front door at `http://localhost:8080` (`/` → client, `/api` → server, `/player`
→ Jellyfin). `/player` is a Gogglebox proxy mount: Caddy strips it before
forwarding to the normal Jellyfin origin from `JELLYFIN_URL`. Serving everything
from ONE origin lets the gbx client seed Jellyfin-web's localStorage so the
`/player` tab auto-logs-in as the per-group JF user. `server` and `client` bind
**no host ports** — reach them only through the proxy.

### Layered env (`.env` shared + `.env.<env>` overrides)

Compose `env_file:` injects **container runtime** env. The run stacks load an
ordered list `[.env, .env.<env>]`, where the **later file wins**. Keep `.env`
(copied from `.env.example`) for shared defaults; put environment- specific
connection and identity values in the overlay file.

`.env.sbx` is generated by sandbox provisioning; `.env.uat` is hand-created for
the developer's real Jellyfin.

This runtime `env_file:` layering is distinct from Compose `${VAR}`
interpolation, which happens at parse time and only reads the default `.env`.
The base compose file avoids interpolating Jellyfin connection vars into the
`proof` container, so `docker compose config` can parse without stubbed secrets.

### Jellyfin

`server` (and `proof`) need a **reachable Jellyfin**, supplied by the run
stack's `.env.<env>` override on top of `.env`. The server exits at startup if
Jellyfin is unreachable. The bare base `check`/`test` commands need no Jellyfin.

### Vite cache / blank-SPA recovery

The client's Vite dep-optimizer cache (`cacheDir`) is on an ephemeral tmpfs
(`/tmp/vite`), not the persistent `node_modules` volume, so a stale/half-written
`.vite` can't survive a kill and wedge the next boot with 504s. If the client
ever serves a blank SPA, recover with
`docker compose up -d --force-recreate client` (NOT `restart`, which races the
optimizer).

### Visual proof

The Playwright suite entry is `e2e/run.mjs`. It logs in, then runs one module
per flow under `e2e/flows/`, with shared harness/session/viewer helpers under
`e2e/lib/`. It writes PNGs to `./artifacts/<timestamp>/` for a single flow. When
running several flows as one prover pass, set the same `PROOF_RUN_ID` on every
invocation so screenshots are grouped under
`./artifacts/<PROOF_RUN_ID>/<timestamp-flow>/`. The prover Reads those PNGs to
confirm the UI.

The `player-handoff` flow (Stage A browser auto-login) MUST run against the
same-origin proxy so the localStorage origin matches `/player`. Override the
target via compose `-e` flags — a shell-level `PROOF_URL=...` prefix does NOT
override the compose `environment:` default (which always wins), so use `-e`.
Use this invocation:

```bash
./scripts/sbx.sh run --rm -e PROOF_URL=http://proxy:8080 -e PROOF_FLOW=player-handoff proof
```

It opens a new tab at `/player/web/...` and writes `player-handoff-gbx.png` (the
gbx launch panel) + `player-handoff-jellyfin-loggedin.png` (the Jellyfin tab,
which must show the logged-in home/library and NO manual login form).

## Conventions

- Never break the config schema. Any older `config.json` must roll forward to
  the current shape — extend the `schemaVersion` migration chain in
  `src/server/config.ts` so startup auto-migrates from _any_ prior version.
  Never require a manual migration step, never drop support for an old version.
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
