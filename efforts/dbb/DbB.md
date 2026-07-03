# DbB

## Overview

Explore and add a durable database-backed model for Gogglebox state, with room
for graph-shaped relationships if that proves useful.

## Goals

- Define which application state belongs in durable storage rather than config
  or transient memory.
- Introduce a database layer that can be migrated and inspected safely.
- Preserve LAN-first deployment simplicity.

## Nongoals

- Do not require external hosted database infrastructure.
- Do not change user-facing behavior without a specific acceptance criterion.

## Acceptance Criteria

1. [ ] The effort defines the initial data model, including whether graph-shaped relationships are needed and why. [proof](./proofs/fab9dc12-fe8b-42c3-aa6c-71de1c93ed12.md)
2. [ ] The app can initialize the chosen local database storage through Docker Compose without requiring host-level database setup. [proof](./proofs/195a0c79-e25d-4e6b-99c0-8528cbf0a6ec.md)
3. [ ] Database migrations run automatically and are covered by verification that starts from an empty database and at least one prior schema version. [proof](./proofs/b846876b-f163-4447-8d1e-3ab334bf8bdd.md)
