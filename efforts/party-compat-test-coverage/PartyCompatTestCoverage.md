# Party Compat Test Coverage

## Overview

The now-done [rename-group-to-party](../rename-group-to-party/RenameGroupToParty.md)
effort renamed the "group" concept to "party" while preserving backward
compatibility for existing deployments (persisted keys, Jellyfin usernames,
config shapes, and `/api/group*` HTTP aliases). Its verification and approval
phases flagged two non-blocking automated-test gaps that were explicitly
carried forward rather than fixed (see
`efforts/rename-group-to-party/.artifacts/019f33e2-5c9b-73fc-8082-3ec70b50e197-output.md`
and `efforts/rename-group-to-party/.artifacts/019f3452-31cb-7fcd-86a4-09afea62bbaf-output.md`):

1. **No golden-value regression test for `PARTY_NAMESPACE`.**
   `src/server/partyKey.ts` derives every party key (and the Jellyfin
   usernames minted from it) from a fixed UUIDv5 namespace constant,
   `PARTY_NAMESPACE`, whose source comment says it "must NEVER change"
   because it is baked into every already-persisted deployment's keys.
   `src/server/partyKey.test.ts` only asserts internal self-consistency
   (determinism, order-independence, dedup, hex format) — none of it pins a
   known/expected output for a fixed input. An accidental future edit to
   that constant (e.g. during an unrelated refactor) would pass every
   existing test silently while breaking every existing deployment's
   persisted keys and usernames.
2. **No HTTP-route-level test for the `/api/group*` compatibility
   aliases.** `src/server/server.ts` registers `/api/group`,
   `/api/group/verify-pins`, `/api/groups`, `/api/group/clear` as
   compatibility aliases wired to the exact same handler functions as their
   `/api/party*` counterparts, and `GET /api/session` / the party-list
   handler return both old and new field names with identical values
   (`activePartyAlias`/`activeGroupAlias`, `parties`/`groups`, each entry's
   `partyKey`/`groupKey`). This currently rests only on manual curl checks
   against a live sandbox performed during the rename effort's build/proof
   phases, not on any CI-enforced automated test. There is no
   `server.test.ts` or any supertest-style test anywhere in `src/server/` —
   this would be the first HTTP-route-level test in the repo.

This effort closes both gaps with durable, CI-enforced automated tests,
without introducing a new project-wide testing framework or restructuring
`server.ts` beyond the minimum needed to make its routes reachable
in-process from a test.

## Goals

- Add a golden-value regression test that pins `derivePartyKey`'s output for
  one or more fixed viewer-id inputs to a hard-coded, pre-computed hex
  string, so any future change to `PARTY_NAMESPACE` (or the derivation
  algorithm around it) fails a test immediately instead of passing silently.
- Add an automated, CI-enforced test that drives the running route table (not
  just static source reading) and proves, for each alias pair:
  - `/api/group` and `/api/party` invoke the same handler and produce the
    same response for the same input (`handleCreateParty`).
  - `/api/group/verify-pins` and `/api/party/verify-pins` do the same
    (`handleVerifyPartyPins`).
  - `/api/groups` and `/api/parties` do the same (`handleListParties`),
    including that each returned entry carries both `partyKey` and the
    aliased `groupKey` with equal values.
  - `/api/group/clear` and `/api/party/clear` do the same
    (`handleClearParty`).
  - `GET /api/session` returns `activePartyAlias` and `activeGroupAlias` with
    equal values.
- If proving the above in-process requires extracting a minimal, additive
  seam from `src/server/server.ts` (for example, a `createApp()`/route
  -registration function that a test can call without requiring a live
  Jellyfin connection or a real `.env`), that extraction is in scope as long
  as it is additive and does not change any existing runtime behavior,
  route, handler, or the production `app.listen(...)` startup path.
  Behavior-preservation of that extraction is itself provable by the
  existing green `check`/`test` run plus the new tests passing.
- Keep the new HTTP-level test's style consistent with the plain
  `node:test` + `node:assert/strict` conventions already used everywhere
  in `src/server/*.test.ts`, so it fits the repo's existing test
  conventions (see `src/server/appState.test.ts`, `src/server/parties.test.ts`).
- Land both new test files (or additions to existing ones) such that
  `docker compose run --rm check` and `docker compose run --rm test` stay
  green, with the previously-passing 150 tests (146 pass / 4 pre-existing
  real-Jellyfin skips, per the rename effort's last verified run) still
  passing and only new tests added.

## Nongoals

- Do not introduce a general-purpose HTTP testing framework/library (e.g.
  supertest) unless it turns out to be the lightest-weight path; prefer
  Node's built-in `node:test` + `node:http`/`fetch` against an
  ephemeral `app.listen(0)`, matching the repo's existing "no test
  framework beyond `node:test`" convention, unless the builder finds that
  approach materially harder to get right than a small, well-justified
  dependency addition.
- Do not restructure `server.ts`'s startup sequence, config loading, or
  Jellyfin connectivity requirements. Any extraction must be the minimum
  needed to make the route table reachable in-process; it must not change
  what happens when the server actually boots via `npm start`/`docker
  compose up`.
- Do not change any user-visible behavior, route path, handler logic, or
  response shape. This is a test-only effort; if a gap is found where the
  aliases actually disagree, fix the disagreement only as an incidental
  correction with its own explicit note in the proof, not as a silent scope
  expansion.
- Do not attempt to cover every route in `src/server/server.ts` — only the
  group/party alias pairs and the dual-field session/party-list responses
  named above are in scope for the HTTP-level test.
- Do not touch `src/client/` — both gaps and their fixes are server-only.

## Acceptance Criteria

1. [x] [proof](./.artifacts/019f3495-1612-71cf-8d95-2b9d125396e1-proof.md) A golden
   -value regression test exists (in `src/server/partyKey.test.ts` or a
   new file) that computes `derivePartyKey` for one or more fixed viewer-id
   inputs and asserts the result equals a specific, pre-computed, hard-coded
   32-char hex string — not merely re-deriving and comparing to itself. The
   proof demonstrates that manually reverting/mutating `PARTY_NAMESPACE` to
   a different value locally causes this new test (and only tests that
   depend on the namespace) to fail, confirming the test actually pins the
   constant rather than passing vacuously.
2. [x] [proof](./.artifacts/019f3495-3105-7457-bb87-42d041ade278-proof.md) An
   automated, in-process HTTP-route-level test exists proving each
   `/api/group*` alias is wired to the identical handler as its `/api/party*`
   counterpart with agreeing response bodies for the same input, covering at
   minimum: `/api/group` vs `/api/party` (create), `/api/group/verify-pins`
   vs `/api/party/verify-pins`, `/api/groups` vs `/api/parties` (including
   per-entry `groupKey`/`partyKey` equality), `/api/group/clear` vs
   `/api/party/clear`, and `GET /api/session`'s `activeGroupAlias` vs
   `activePartyAlias`. The proof states which approach was chosen (minimal
   supertest-style harness vs. plain `node:http`/`fetch` against an
   ephemeral listener vs. any additive `server.ts` seam extraction), why it
   fits or extends the existing `src/server/*.test.ts` conventions, and
   confirms no existing route, handler, or startup behavior changed.
3. [x] [proof](./.artifacts/019f3495-4bd6-7296-a123-1c219ddab732-proof.md) A fresh
   `docker compose run --rm check` and `docker compose run --rm test` run
   from this effort's own branch/worktree is green: zero typecheck errors,
   and the full unit-test run passes with both new tests included and no
   regression in the previously-passing count (150 tests, 146 pass / 4
   pre-existing real-Jellyfin skips before this effort's additions).
