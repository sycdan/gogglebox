# Rename Group To Party

## Overview

In keeping with Gogglebox's co-op theme, rename the household "group" concept to
"party" everywhere users encounter it. Parties function the same as groups for
now: they collect watchers, own access tokens, and drive shared watch state. This
effort is a terminology and compatibility pass, not a data-model redesign.

## Goals

- Present "party" terminology throughout the user-facing app, setup flows, API
  responses intended for the client, logs, docs, and test/proof copy.
- Preserve existing group-backed data, config files, access tokens, and Jellyfin
  integration behavior without requiring manual migration.
- Keep internal compatibility aliases where needed so old configs, clients, and
  URLs roll forward cleanly while the visible product language becomes "party".

## Nongoals

- Do not change how parties are selected, authenticated, authorized, or mapped to
  Jellyfin users.
- Do not split, merge, or otherwise redesign the current group data model beyond
  the naming migration needed for this effort.
- Do not remove backward compatibility for existing `group` config fields,
  database fields, routes, or persisted client state unless an explicit migration
  path proves older installations still start successfully.

## Acceptance Criteria

1. [ ] [proof](./.proofs/8f4c2dbb-f808-4855-ac4d-2808c342cf56.md) that all user-visible application copy, navigation, form labels, empty states, and proof/test flow text refer to parties instead of groups while preserving the existing workflows.
2. [ ] [proof](./.proofs/d9163ea7-2edb-45e2-bbc0-bb2cf36c1b0b.md) that server API contracts and client state use party-oriented names for newly exposed fields and helpers, with compatibility maintained for any existing group-oriented consumers or persisted state.
3. [ ] [proof](./.proofs/92201c73-9fe0-4c52-b0db-14f4e9314dfd.md) that config loading auto-migrates or aliases every previously supported group-shaped config to the party terminology without a manual migration step or schema rollback risk.
4. [ ] [proof](./.proofs/756ad662-f6d8-4148-9248-0d3987d60d03.md) that sandbox, UAT, README, developer docs, and relevant automation scripts describe parties consistently, while retaining compatibility notes where operators may still see legacy group keys or paths.
5. [ ] [proof](./.proofs/91cd27a7-9744-402b-b97f-8c37bd26baab.md) that automated verification covers the terminology migration, including typecheck, unit coverage for config/API compatibility, and at least one visual proof that the party language appears in the running UI.
