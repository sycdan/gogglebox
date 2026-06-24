# Gogglebox Backlog

## Backlog

### Ignore shows per viewer group

Let a viewer group hide a show from all results (continue-watching,
recommendations, and search). Ignoring just suppresses the show everywhere; an
unignore action in the UI brings it back.

- **Group key:** derive a deterministic id from the set of selected user ids,
  order-independent (sort ids, then namespaced UUIDv5, dashes stripped). Same
  group of people always maps to the same key.
- **Storage:** persist a `groupKey → [showId]` map (or its inverse) in a
  writable **app state file**, not `config.json`. App must write to it at
  runtime. Mount the state path from the host via docker-compose deploy so it
  survives redeploys. Config stays read-only.
- **Filtering:** subtract a group's ignored show ids from continue-watching,
  recommendations, and search results for that group.
- **UI:** action to ignore a show, and a way to view/unignore the group's
  ignored shows.

## Recently shipped

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
