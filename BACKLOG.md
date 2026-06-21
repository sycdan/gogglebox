# Gogglebox Backlog

## Backlog

_Empty._ Add real, needs-driven items here.

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
</content>
