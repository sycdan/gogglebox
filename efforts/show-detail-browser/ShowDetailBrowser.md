# Show Detail Browser

## Overview

Add a show detail modal that opens from show titles and lets viewers browse
episodes across seasons while seeing each watcher's watched state. [Judgement
Day](../v2026.8.29/V2026.8.29.md) owns global and discovery rail search UX; this
effort may own keyword search only inside one show's detail context, scoped to
episodes from that specific show.

## Goals

- Make show titles actionable wherever they appear in the app.
- Prove Jellyfin search can find episodes by keyword when constrained to one
  specific show.
- Show each selected watcher's seen state for every listed episode.

## Nongoals

- Do not replace the existing recommendation or in-progress views.
- Do not add global search, discovery rail search, or cross-show search UX; those
  remain owned by [Judgement Day](../v2026.8.29/V2026.8.29.md).
- Do not edit watched state from this modal unless a later effort specifies it.

## Acceptance Criteria

1. [ ] [proof](./.proofs/9288e8b3-2858-4ee8-ac7a-a7bd58e9e2a4.md) that clicking a show title anywhere it appears opens an accessible show modal without breaking the current page state behind it.
2. [ ] [proof](./.proofs/c57d4edd-79ac-4d2e-aad5-a4b60e701ff8.md) that the modal lists episodes grouped or filterable by season and supports selecting a season button to narrow the visible episode list.
3. [ ] [proof](./.proofs/3894f19d-9296-4a3d-bdc9-e1c30b59e961.md) that each visible episode row shows the watched or unwatched state for every watcher in the active group.
4. [ ] [proof](./.proofs/bad0af2b-3685-4848-9947-0161384cd56e.md) that Jellyfin search can find episodes by keyword scoped to one specific show without surfacing episodes from other shows or becoming a global discovery rail search.
