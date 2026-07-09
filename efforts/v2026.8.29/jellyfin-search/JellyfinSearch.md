# Jellyfin Search

## Overview

Search is the known-item, high-intent path in
[Judgement Day](../V2026.8.29.md): the household already knows what it wants,
so the algorithm gets out of the way. Search queries Jellyfin through a server
endpoint (never exposing Jellyfin details to the client) and returns global
results including inter-show episodes. Results REPLACE the deck surface in a
dense grid exempt from deck/hero layout — same single surface, with a clear
escape back to the deck and a clear empty state. Search is phone-shaped and
de-emphasized in the controller context.

## Goals

- Query Jellyfin search through the server rather than exposing Jellyfin
  details directly to the client.
- Present results as a dense grid that replaces the deck surface, with an
  obvious escape back to the deck and a clear empty state.
- Include inter-show episode results where Jellyfin returns them.

## Nongoals

- Do not replace existing browse workflows.
- Do not build a full advanced search page.
- Do not open a separate search results modal or alternate recommendation
  mode — search reuses the single surface.
- Do not add recommendations based on external search providers.
- Do not filter or re-rank the deck by the search query — search results are
  global Jellyfin results, not a filtered deck.

## Acceptance Criteria

1. [ ] [proof](./.artifacts/019f2aa8-4921-7c9b-a64d-0d099a2dfe8c-proof.md) that search queries Jellyfin through a server endpoint and returns matching movies, series, and episodes.
2. [ ] [proof](./.artifacts/019f46d2-e43b-7657-aa74-a7d69be570b4-proof.md) that search results replace the deck surface in a dense grid exempt from deck/hero layout on the same single surface, with a clear escape action returning to the deck and a clear empty state when nothing matches.
3. [ ] [proof](./.artifacts/019f2aa8-4922-74c5-903e-5db62e1e6247-proof.md) that search results include playable inter-show episodes when the seeded sandbox contains matching episodes outside the current show context.
