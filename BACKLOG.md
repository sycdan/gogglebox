# Gogglebox Backlog

## Backlog

### Per-viewer watched-state pills in continue-watching

Each continue-watching card shows who in the group has seen the current episode,
and lets you toggle it.

- **Play button:** rename the card's "Continue" button to "Play".
- **Viewer pills:** next to Play, render a small icon per viewer in the active
  group. Overlay a marker on a viewer's icon when that person has watched the
  episode.
- **Toggle:** clicking a viewer's icon toggles that episode's watched state for
  that person in Jellyfin (mark played / unplayed for that user id).

## Recently shipped

Ignore shows per viewer group (backend + UI in code):

- A viewer group can hide a show from all results (continue-watching,
  recommendations, search). Ignoring suppresses it everywhere; an unignore
  action brings it back.
- **Group key:** deterministic, order-independent id from the set of selected
  user ids (sort ids, namespaced UUIDv5, dashes stripped) — same people always
  map to the same key. See [src/server/groupKey.ts](src/server/groupKey.ts).
- **Storage:** `groupKey → [showId]` persisted in a writable app state file
  (not `config.json`), mounted from the host so it survives redeploys. See
  [src/server/appState.ts](src/server/appState.ts).
- **Filtering + endpoints:** ignored ids subtracted from all three surfaces;
  `GET/POST/DELETE /api/ignored-shows`. UI has an ignore action and an
  ignored-shows panel to unignore.

Continue-watching-first home (all phases verified + visually proven):

- Combined movie + show continue-watching rail, promoted above the toolbar; no
  longer pick a library to resume.
- Recommendations capped at a configurable count (`recommendations.count`,
  default 8) with a "Show me other picks" button that swaps in non-repeating
  picks per viewer group.
- Full-library browse removed; toolbar drives a 1s-debounced search that shows
  only matches and renders in place of recommendations while a query is active.

## Useful files

- Backend entrypoint: [src/server/server.ts](src/server/server.ts)
- Jellyfin API client: [src/server/jellyfin.ts](src/server/jellyfin.ts)
- Config loader: [src/server/config.ts](src/server/config.ts)
- Client app: [src/client/App.tsx](src/client/App.tsx)
- Continue-watching merge: [src/server/continueWatching.ts](src/server/continueWatching.ts)
