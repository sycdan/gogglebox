# Signal Facts

## Overview

Build the fact store that everything else in
[Judgement Day](../V2026.8.29.md) feeds on: an append-only JSONL event log in
the state dir with the shape `{ ts, userId, itemId, kind, value, provenance }`.
Fact kinds include `seen`, `liked`, `rewatch`, `completed`, `skipped`,
`ignored`, `started-blind` (played via Press Start), `backed-out`,
`not-tonight`, `elicited-*`, plus session telemetry (deck advances, new-deck
deals, time-to-play). A new data source is just a new fact kind — no schema
migration. The `provenance` field distinguishes `own-pad` (self-reported via a
bound controller) from `room-reported`.

## Goals

- Provide a durable, append-only JSONL fact log in the state dir that
  survives restarts and redeploys.
- Define a documented, extensible fact-kind registry so new sources add kinds
  without migrating existing data.
- Wire capture points so real flows emit facts: plays, completes, ignores,
  skips, not-tonight, started-blind, backed-out, new-deck deals, elicited
  answers, and newly-added library scans.
- Record the north-star telemetry (time-to-play, deck-advance and new-deck
  counts) as per-session facts.
- Carry provenance on every fact (`own-pad` vs `room-reported`).

## Nongoals

- No database-backed persistence — JSONL until measured pain (see the parent
  ledger and the superseded
  [persistence-refactor](../../persistence-refactor/PersistenceRefactor.md)).
- No scoring, aggregation, or ranking logic — that is
  [recommendation-core](../recommendation-core/RecommendationCore.md).
- No UI for browsing or editing facts.

## Acceptance Criteria

1. [ ] [proof](./.artifacts/019f46d2-c6a8-7f6f-8b77-278c98313862-proof.md) that the append-only JSONL fact store lives in the state dir, accepts facts shaped `{ ts, userId, itemId, kind, value, provenance }`, and retains them across a server restart.
2. [ ] [proof](./.artifacts/019f46d2-c7e1-767d-b1f7-c648402c21a9-proof.md) that a documented fact-kind registry covers the initial kinds (seen, liked, rewatch, completed, skipped, ignored, started-blind, backed-out, not-tonight, elicited-*) and that adding a new kind requires no schema migration of existing fact data.
3. [ ] [proof](./.artifacts/019f46d2-c91a-7737-8977-ad251787180e-proof.md) that real flows write facts at their capture points — plays, completes, ignores, skips, not-tonight, started-blind, backed-out, new-deck deals, elicited answers, and newly-added library scans — each with a provenance value.
4. [ ] [proof](./.artifacts/019f46d2-ca52-78c8-afbc-6f514bd3ce39-proof.md) that session telemetry facts are recorded per session: time-to-play (login → playback start), deck-advance count, and new-deck deal count.
