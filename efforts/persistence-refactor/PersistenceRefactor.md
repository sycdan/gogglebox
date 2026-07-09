# Persistence Refactor (Superseded)

## Overview

**This effort is superseded and will not be done.** The 2026-07 Judgement Day
design exploration absorbed it into
[v2026.8.29/signal-facts](../v2026.8.29/signal-facts/SignalFacts.md): durable
state lands as an append-only JSONL fact log in the state dir. A real database
is deferred until measured pain — file contention or query slowness, which is
unlikely before roughly 100k facts. Graph-shaped relationships were rejected
as unjustified at household scale. See the
[Judgement Day](../v2026.8.29/V2026.8.29.md) nongoals ledger
("database-backed persistence").

This spec is kept for history only. There is no live work here.

## Nongoals

- Everything previously in scope: the data-model exploration, the
  database layer, and automated migrations are all withdrawn in favor of the
  JSONL fact store.

## Acceptance Criteria

The former acceptance criteria (define the initial data model incl. whether
graph relationships are needed; initialize local database storage via Docker
Compose; automatic verified migrations) are withdrawn unproven — the effort
was superseded before any were checked, and no proof will be produced. Its
durable-storage intent is carried by the signal-facts acceptance criteria
instead.
