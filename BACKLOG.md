# Gogglebox Backlog

Goal: make the home screen **continue-watching-first**. The household resumes
anything in progress — movies *and* shows together — without first picking a
library. The library/kind selector stops being a browse-everything wall and
becomes a scoped control for **recommendations** and **search** only.

Phases are ordered to ship independently. Each ends with verify (typecheck +
unit) and a visual proof.

---

## Phase 1 — Combined continue watching, promoted to the top

Continue watching moves above the toolbar and merges movies + shows into one
rail, so the user never picks a library to resume.

- **Backend** — drop the `kind` requirement from `/api/continue-watching`
  ([server.ts:258](src/server/server.ts#L258)). `getContinueWatchingItems`
  ([server.ts:93](src/server/server.ts#L93)) fetches *both* kinds per viewer
  (`listContinueWatching(..., 'movie')` + `listShowContinueWatching`) and feeds
  the combined candidate list through the existing `mergeContinueWatching`.
- **Frontend** — render the Continue Watching `<section>` above the toolbar
  ([App.tsx:613](src/client/App.tsx#L613)); fetch it once per active group
  instead of on every `kind` change. Cards already carry `item.type`, so movie
  vs. show metadata renders correctly with no extra wiring.
- **Acceptance** — a group with one movie and one show in progress sees both in
  a single rail at the top, regardless of the kind toggle.

## Phase 2 — Configurable recommendation count + "more like this"

Recommendations shrink to a small default and gain a refresh that never repeats
a title already shown this session.

- **Config** — add `recommendations.count` to `config.json` (default 8) and read
  it in `config.ts` ([config.ts:94](src/server/config.ts#L94)) with a clamp
  (e.g. 1–24); extend `AppConfig` in `types.ts`.
- **Backend** — `/api/recommendations`
  ([server.ts:234](src/server/server.ts#L234)) accepts an `exclude` list
  (comma-separated ids), filters out the watched union **and** the excluded ids,
  and slices to `config.recommendations.count`. Deterministic rating sort means
  excluding shown ids naturally yields the next-best batch.
- **Frontend** — track shown rec ids in a session `Set`; render a "Show me other
  picks" button that refetches with `exclude=<shown ids>`; append/replace.
  Disable when a refetch returns empty.
- **Acceptance** — default view shows 8 recs; clicking refresh swaps in 8 unseen
  titles; no title repeats within the session.

## Phase 3 — Library selector becomes recommendations + search

The full-library render is removed. The toolbar (kind / genre / kids-only) now
scopes recommendations and a new search box. Search renders only matches, never
the whole library.

- **Backend** — add `searchItems(kind, query, genre?)` to `jellyfin.ts`
  (Jellyfin `SearchTerm`); expose via `/api/library` requiring a non-empty `q`
  (empty `q` ⇒ empty result, never the whole library)
  ([server.ts:217](src/server/server.ts#L217)).
- **Frontend** — delete the "Browse" full-library section
  ([App.tsx:683-704](src/client/App.tsx#L683-L704)); add a search input with a
  **1s debounce** that calls the search endpoint and renders matches in their own
  rail. Genre options come from a static/known list or the recommendation
  payload rather than a full library scan.
- **Acceptance** — no full grid renders on load; typing waits ~1s then shows only
  matching titles; clearing the box clears results.

---

## Useful files

- Backend entrypoint: [src/server/server.ts](src/server/server.ts)
- Jellyfin API client: [src/server/jellyfin.ts](src/server/jellyfin.ts)
- Config loader: [src/server/config.ts](src/server/config.ts)
- Client app: [src/client/App.tsx](src/client/App.tsx)
- Continue-watching merge: [src/server/continueWatching.ts](src/server/continueWatching.ts)
</content>
</invoke>
