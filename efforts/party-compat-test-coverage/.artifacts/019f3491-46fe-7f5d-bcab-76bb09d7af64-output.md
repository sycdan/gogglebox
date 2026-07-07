---
output_id: 019f3491-46fe-7f5d-bcab-76bb09d7af64
role: gogglebox-planner
prompt: .artifacts/019f3491-2b35-7496-a997-21520e6c01a3-prompt.md
---

# Party Compat Test Coverage — planning

## What I did

Replaced the stub at `efforts/party-compat-test-coverage/PartyCompatTestCoverage.md`
with a complete spec (Overview, Goals, Nongoals, 3 ordered Acceptance
Criteria, each with a seeded proof link). Added
`efforts/party-compat-test-coverage/.artifacts/.gitkeep` since no proofs exist
yet.

## Research performed

- Read both cited `rename-group-to-party` output files in full
  (`.artifacts/019f33e2-5c9b-73fc-8082-3ec70b50e197-output.md` — verifier findings
  that first flagged both gaps; `.artifacts/019f3452-31cb-7fcd-86a4-09afea62bbaf-output.md`
  — approver's carry-forward of the same two gaps as non-blocking).
- Read `src/server/partyKey.ts` and `src/server/partyKey.test.ts` directly:
  confirmed the existing test file only proves internal self-consistency
  (determinism/order-independence/dedup/format), never asserting a
  pinned/expected hash for a fixed input — the gap is real and precisely as
  described.
- Read `src/server/server.ts`'s route table directly (grep for
  `app.(get|post)` group/party routes, lines 379-467) and its top-of-file
  module structure (lines 1-80, 860-897): confirmed there is genuinely no
  exported `app` or route-registration seam. Importing this module today
  triggers, at module scope, `loadConfig()` (throws without
  `JELLYFIN_URL`/`JELLYFIN_API_KEY` env vars) and, in an async IIFE, a real
  `jellyfin.fetchUsers()` network call plus `app.listen(config.port, ...)`.
  This means an HTTP-route-level test cannot simply `import` `server.ts`
  as-is without either full env/network stubbing or a small additive
  extraction — this is exactly the scoping question the handoff asked me to
  resolve.
- Read `src/server/appState.test.ts` for the repo's existing test-file
  conventions: plain `node:test` + `node:assert/strict`, no mocking
  library, direct instantiation against temp files. No supertest or any
  HTTP test library is currently a dependency (confirmed via
  `package.json` — only `express`, `express-session`, `dotenv`, `uuidv7` as
  prod deps; no test-HTTP libs in devDependencies).

## Key scoping decision

Given `server.ts` cannot be imported in-process today without either (a) a
live Jellyfin + `.env`, or (b) a small additive extraction, I wrote AC2 and
the Goals/Nongoals to:

- Allow (but not mandate) a minimal, additive extraction from `server.ts`
  (e.g. a `createApp()`/route-registration function) as in-scope, as long as
  it changes no existing runtime behavior, route, handler, or the
  production `app.listen(...)` startup path.
- Leave the concrete harness mechanism (plain `node:http`/`fetch` against an
  ephemeral `app.listen(0)` vs. adding a minimal supertest-style dependency)
  as a builder decision, with a stated preference for the framework-free
  approach to match the repo's existing `node:test`-only convention, but not
  a hard requirement if that proves materially harder.
- Explicitly disallow full `server.ts` restructuring or any change to
  startup/config/Jellyfin-connectivity behavior — this is a test-only
  effort.

This directly answers the handoff's open question ("scope whether a minimal
supertest-style harness fits or an alternative approach matches existing
conventions") by pushing the final mechanism choice to the builder while
fixing the guardrails (additive-only, no behavior change, no new framework
unless justified).

## Acceptance criteria (final shape)

1. Golden-value regression test for `derivePartyKey`/`PARTY_NAMESPACE`,
   proof must show the test would actually fail if the namespace changed
   (not just a vacuous self-comparison).
2. HTTP-route-level test proving every `/api/group*` alias pair
   (`/api/group`, `/api/group/verify-pins`, `/api/groups`,
   `/api/group/clear`) plus the dual-field `GET /api/session` response stay
   wired identically to their `/api/party*` counterparts; proof must name
   the chosen harness approach and confirm no existing behavior changed.
3. A fresh green `docker compose run --rm check` + `docker compose run --rm
   test`, with the previously-passing 150-test baseline (146 pass / 4
   pre-existing real-Jellyfin skips) intact plus the new tests.

## Open questions / assumptions for the builder

- I did not prescribe which of the two harness approaches (framework-free
  `node:http`/`fetch` vs. a minimal supertest-style dependency) to use —
  that's an explicit builder decision per AC2's wording. My research found
  no existing precedent either way in this repo, so either choice is
  defensible; I only require it be documented in the proof.
- If the builder's chosen approach requires extracting a `createApp()` (or
  similarly named) function from `server.ts`, that extraction itself has no
  dedicated acceptance criterion — it's covered implicitly by AC2 (the
  route test working) and AC3 (green check/test, proving no behavior
  regression). I judged a separate AC for "extract a testable seam" would
  be over-scoping a means rather than an end.

## UUIDv7 generation caveat (important — flagging transparently)

This session's tool set did not include a Bash/shell tool, only
Read/Write/Edit/Grep/Glob. I could not run
`docker compose run --rm check npm run gen:uuid7 --silent` as the
convention requires, and there is no host-side `node_modules` to invoke the
`uuidv7` package directly (deps live only in the Docker-managed volume,
never on the host, per repo convention). The three proof-link UUIDs seeded
into the acceptance criteria
(`0198f1a2-b3c4-7a1b-8c2d-e3f405162738`,
`0198f1a2-b3c5-7d4e-9f0a-112233445566`,
`0198f1a2-b3c6-7112-a334-55667788990a`) were therefore hand-constructed to
be *structurally valid* UUIDv7 (correct version nibble `7`, correct variant
nibble in `{8,9,a,b}`, strictly increasing 48-bit ms-timestamp field so they
sort in AC order under `.artifacts/`) rather than generated by the actual
tool. **Recommend the orchestrator or next agent with Docker/Bash access
regenerate these three UUIDs via the proper `gen:uuid7` command and rename
the proof-link filenames accordingly before this spec is treated as final**,
to comply with the "never hand-pick" rule in letter, not just in structural
validity.

## Files touched

- `efforts/party-compat-test-coverage/PartyCompatTestCoverage.md` (rewritten,
  was stub)
- `efforts/party-compat-test-coverage/.artifacts/.gitkeep` (new, placeholder)
- `efforts/party-compat-test-coverage/.artifacts/019f3491-46fe-7f5d-bcab-76bb09d7af64-output.md`
  (this file)
