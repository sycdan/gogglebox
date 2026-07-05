# Party Compat Test Coverage

## Overview

STUB — planner must populate this spec. Originates from two non-blocking
gaps flagged during [rename-group-to-party](../rename-group-to-party/RenameGroupToParty.md)
verification (see that effort's
`.outputs/019f33e2-5c9b-73fc-8082-3ec70b50e197.md` and
`.outputs/019f3452-31cb-7fcd-86a4-09afea62bbaf.md`):

1. No golden-value regression test pins `partyKey.ts`'s `PARTY_NAMESPACE`
   UUIDv5 constant to a known hash — an accidental change would pass all
   existing tests undetected, silently breaking every existing deployment's
   persisted party keys and Jellyfin usernames.
2. No HTTP-route-level (supertest-style) test proves the `/api/group*`
   compatibility aliases stay wired to the same handlers as `/api/party*`
   with agreeing response bodies — this currently rests only on manual curl
   checks against a live sandbox, not CI-enforced automation.

## Goals

STUB — planner must populate.

## Nongoals

STUB — planner must populate.

## Acceptance Criteria

STUB — planner must populate.
