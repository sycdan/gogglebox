# Gogglebox Backlog

## Backlog

### Stabilize continue-watching card order

The SHOW (and overall) card ordering in the continue-watching rail can **vary
between loads/refetches** — cards visibly reshuffle, which is jarring. Because
every viewer-watched toggle now refetches the rail
([src/client/App.tsx](src/client/App.tsx) `loadContinueWatching`), an unstable
sort makes cards jump position on each interaction, not just on navigation.

- Give the rail a **deterministic, stable sort** so the same state always yields
  the same order and cards don't move under the user mid-session.
- Decide the intended ordering key (e.g. most-recently-played first) and make it
  total/tie-broken (fall back to a stable id) so equal-rank cards keep a fixed
  relative order across refetches.
- Verify on the sandbox: refetch the rail repeatedly with unchanged state and
  assert identical card order.

### Movies resume least-watched first

When several viewers in a group have the same movie in progress at different
points, the continue-watching card currently resumes from the **most**-watched
viewer's position (rank = highest `progressPercent`, see
[src/server/continueWatching.ts](src/server/continueWatching.ts) `rankCandidate`).
That spoils the least-watched viewer. Flip it so a movie's card resumes from the
**least**-watched viewer's position instead.

- Only movies (`type === 'movie'`) change; shows still rank by season/episode
  then progress as today.
- Pick the in-progress candidate with the **lowest** `progressPercent` for that
  movie; that viewer becomes the card's `sourceViewer` / resume point.
- Keep deduping movies by `movie:{id}`; the per-viewer pills already show
  everyone's individual watched state, so the card still reflects the group.
- Update `continueWatching.test.ts` to assert the least-progressed viewer wins
  for movies.

## Recently shipped

Per-viewer watched-state pills in continue-watching (built + visually proven):

- "Continue" button renamed to "Play" (and "Resume" when the file has partial
  progress).
- A viewer pill per active-group member next to the button, with a check badge
  overlaid when that viewer has the card's current item marked played in
  Jellyfin. Avatars clip to equal circles (`object-fit: cover`).
- Clicking a pill toggles that viewer's played/unplayed state in Jellyfin.
- Fixed a Jellyfin field-name bug (`UserData.Played`, not `IsPlayed`) so the
  watched badge reads correctly on initial load, not just after a toggle.

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
