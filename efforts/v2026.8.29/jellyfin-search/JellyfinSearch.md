# Jellyfin Search

## Overview

Add a search action from the recommendation rail that uses Jellyfin search for
quick access to specific content, including episodes from other shows.

## Goals

- Provide a visible search control in the recommendation rail.
- Query Jellyfin search through the server rather than exposing Jellyfin details
  directly to the client.
- Include inter-show episode results where Jellyfin returns them.

## Nongoals

- Do not replace existing browse workflows.
- Do not build a full advanced search page.
- Do not add recommendations based on external search providers.

## Acceptance Criteria

1. [ ] [proof](./.proofs/bd51ef7a-c4d5-45af-911f-87604327e62f.md) that the recommendation rail has a search action that opens a search experience without leaving the home context.
2. [ ] [proof](./.proofs/83989d1a-1885-45c1-ac6c-f31bc2167003.md) that search queries Jellyfin through a server endpoint and returns matching movies, series, and episodes.
3. [ ] [proof](./.proofs/faf4a421-ce65-4359-891d-04966c8622a4.md) that search results include playable inter-show episodes when the seeded sandbox contains matching episodes outside the current show context.
