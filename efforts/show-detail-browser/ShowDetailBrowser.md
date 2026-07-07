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

1. [ ] [proof](./.artifacts/019f2aa8-4939-7df8-b837-de245fa41849-proof.md) that clicking a show title anywhere it appears opens an accessible show modal without breaking the current page state behind it.
2. [ ] [proof](./.artifacts/019f2aa8-493a-7ef9-958a-cfcc7486cdd8-proof.md) that the modal lists episodes grouped or filterable by season and supports selecting a season button to narrow the visible episode list.
3. [ ] [proof](./.artifacts/019f2aa8-493c-7830-b953-38a8a7ed72ab-proof.md) that each visible episode row shows the watched or unwatched state for every watcher in the active group.
4. [ ] [proof](./.artifacts/019f2aa8-493e-7583-8889-4e701cc2bc20-proof.md) that Jellyfin search can find episodes by keyword scoped to one specific show without surfacing episodes from other shows or becoming a global discovery rail search.
