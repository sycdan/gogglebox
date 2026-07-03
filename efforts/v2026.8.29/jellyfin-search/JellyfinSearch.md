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

1. [ ] [proof](./.proofs/bd51ef7a-c4d5-45af-911f-87604327e62f.md) that the discovery rail has a search action that filters the rail in place without leaving the home context or opening a separate results mode.
2. [ ] [proof](./.proofs/83989d1a-1885-45c1-ac6c-f31bc2167003.md) that search queries Jellyfin through a server endpoint and returns matching movies, series, and episodes.
3. [ ] [proof](./.proofs/faf4a421-ce65-4359-891d-04966c8622a4.md) that filtered rail results include playable inter-show episodes when the seeded sandbox contains matching episodes outside the current show context.
4. [ ] [proof](./.proofs/6ec71891-3e87-4502-86cb-392888244222.md) that keyword search filters discovery rail results by title and available metadata, with a clear empty state when nothing matches.
