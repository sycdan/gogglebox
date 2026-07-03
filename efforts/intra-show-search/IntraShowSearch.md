# Intra-Show Search

## Overview

Add a show detail modal that opens from show titles and lets viewers browse or
search episodes across seasons while seeing each watcher's watched state.

## Goals

- Make show titles actionable wherever they appear in the app.
- Provide season filtering and keyword search across all episodes in the show.
- Show each selected watcher's seen state for every listed episode.

## Nongoals

- Do not replace the existing recommendation or in-progress views.
- Do not edit watched state from this modal unless a later effort specifies it.

## Acceptance Criteria

1. [ ] Clicking a show title anywhere it appears opens an accessible show modal without breaking the current page state behind it. [proof](./proofs/9288e8b3-2858-4ee8-ac7a-a7bd58e9e2a4.md)
2. [ ] The modal lists episodes grouped or filterable by season and supports selecting a season button to narrow the visible episode list. [proof](./proofs/c57d4edd-79ac-4d2e-aad5-a4b60e701ff8.md)
3. [ ] Keyword search filters episodes across seasons by episode title and available episode metadata, with a clear empty state when nothing matches. [proof](./proofs/6ec71891-3e87-4502-86cb-392888244222.md)
4. [ ] Each visible episode row shows the watched or unwatched state for every watcher in the active group. [proof](./proofs/3894f19d-9296-4a3d-bdc9-e1c30b59e961.md)
