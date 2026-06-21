# Gogglebox Backlog

## Backlog

1. ~~Use Jellyfin for the viewer list instead of local user data.~~ **Done** - `JellyfinClient.fetchUsers()` calls `GET /Users` at server startup, and viewer names plus avatar URLs flow through `/api/session` to the client.

2. Add lightweight admin config UI.
   - Edit viewer presets and household settings without manual JSON edits.
   - Support editing or backup/restore for household and groups settings stored in `groups.json`.

3. Add watched/unwatched parity for series rollups.
   - Decide whether marking a series should fan out to all episodes.
   - Keep recommendation exclusion semantics consistent with that decision.

4. Add integration tests for API routes.
   - Cover `/api/recommendations`, `/api/items/:id/stream`, and `/api/shows/:seriesId/episodes` with mocked Jellyfin responses.

5. Improve episode browsing ergonomics.
   - Add per-season grouping and search within episodes.
   - Surface watched badges in episode and library cards.

## Useful Files

- Backend entrypoint: [src/server/server.ts](src/server/server.ts)
- Jellyfin API client: [src/server/jellyfin.ts](src/server/jellyfin.ts)
- Config loader: [src/server/config.ts](src/server/config.ts)
- Client app: [src/client/App.tsx](src/client/App.tsx)
- Example env file: [.env.example](.env.example)