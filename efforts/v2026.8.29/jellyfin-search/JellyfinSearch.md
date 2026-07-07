# Discovery Rail Search

## Overview

Add search to the single discovery rail. Search filters the rail's result set
instead of opening a separate recommendation mode, and uses Jellyfin search for
quick access to specific content, including episodes from other shows.

## Goals

- Provide a visible search control in the discovery rail.
- Filter the same rail result set that recommendations use, preserving the
  single-rail experience.
- Query Jellyfin search through the server rather than exposing Jellyfin details
  directly to the client.
- Include inter-show episode results where Jellyfin returns them.

## Nongoals

- Do not replace existing browse workflows.
- Do not build a full advanced search page.
- Do not open a separate search results modal or alternate recommendation mode.
- Do not add recommendations based on external search providers.

## Acceptance Criteria

1. [ ] [proof](./.artifacts/019f2aa8-491f-7d01-aa5b-55257f2e3925-proof.md) that the discovery rail has a search action that filters the rail in place without leaving the home context or opening a separate results mode.
2. [ ] [proof](./.artifacts/019f2aa8-4921-7c9b-a64d-0d099a2dfe8c-proof.md) that search queries Jellyfin through a server endpoint and returns matching movies, series, and episodes.
3. [ ] [proof](./.artifacts/019f2aa8-4922-74c5-903e-5db62e1e6247-proof.md) that filtered rail results include playable inter-show episodes when the seeded sandbox contains matching episodes outside the current show context.
4. [ ] [proof](./.artifacts/019f2aa8-4924-7a69-a624-1c518786e551-proof.md) that keyword search filters discovery rail results by title and available metadata, with a clear empty state when nothing matches.
