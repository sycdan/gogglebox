---
output_id: 019f33b8-bcab-7de3-9b20-ccc8bf0dfc57
role: gogglebox-builder
prompt: .prompts/019f33b8-a312-742d-ba92-2048f426bf59.md
---

# Rename Group To Party — implementation summary

## What changed

### Server internals (pure logic + state)
- `src/server/groupKey.ts` → `src/server/partyKey.ts`: `deriveGroupKey` →
  `derivePartyKey`. The UUIDv5 namespace constant (`PARTY_NAMESPACE`, same value
  as the old `GROUP_NAMESPACE`) is **unchanged** so every previously-derived key
  still resolves identically — this is load-bearing for existing persisted
  state and minted Jellyfin usernames.
- `src/server/groups.ts` → `src/server/parties.ts`: `VisibleGroup` →
  `VisibleParty`, `buildGroupAlias` → `buildPartyAlias`,
  `isGroupVisibleToAccount` → `isPartyVisibleToAccount`,
  `visibleGroupsForAccount` → `visiblePartiesForAccount`,
  `resolveGroupForMembers` → `resolvePartyForMembers`. Field renamed `groupKey`
  → `partyKey` in the internal `VisibleParty` shape.
- `src/server/appState.ts`: new `PartyPlayerUser` type (`GroupPlayerUser` kept
  as a structural alias). New methods `getPartyPlayerUserId`,
  `setPartyPlayerUser`, `getPartyPlayerUsers`, `getPartyAlias`,
  `getPartyAliases`, `setPartyAlias`. **Persisted state compatibility**: reads
  prefer the new `partyPlayerUsers`/`partyAliases` state-file keys but fall back
  to the pre-rename `groupPlayerUsers`/`groupAliases` keys with zero data loss;
  writes always normalize forward to the new keys (same pattern already used for
  `ignoredShows` → `ignoredItems`).
- `src/server/accounts.ts`: `verifyGroupPins` → `verifyPartyPins`,
  `resolveGroupMemberSelection` → `resolvePartyMemberSelection`.
- `src/server/jellyfin.ts`: `groupUserName` → `partyUserName`, `ensureGroupUser`
  → `ensurePartyUser`. The underlying Jellyfin username format (`gbx-grp-<id>`)
  is **intentionally left unchanged** — it's real, already-minted Jellyfin state
  for every existing deployment, and the Nongoals forbid changing how parties
  map to Jellyfin users.
- `src/server/session.d.ts`: `activeGroupPinVerified` → `activePartyPinVerified`
  (safe direct rename — express-session's default MemoryStore never persists to
  disk, so there's no rollout/compat concern for this field).
- `src/server/server.ts`: new canonical routes `POST /api/party`,
  `POST /api/party/verify-pins`, `GET /api/parties`, `POST /api/party/clear`.
  The old `POST /api/group`, `POST /api/group/verify-pins`, `GET /api/groups`,
  `POST /api/group/clear` are kept as **compatibility aliases** wired to the
  exact same handlers. `GET /api/session` now returns both `activePartyAlias`
  (new) and `activeGroupAlias` (old, identical value). `GET /api/parties`
  returns both `parties` (new, `partyKey`-shaped) and `groups` (old,
  `groupKey`-shaped) in the same response body.

### Config / migration (AC3)
- `src/server/configMigrations.ts`: the schemaVersion-0 legacy preset list now
  accepts `parties[]` as an alias for the pre-rename `groups[]` key (`parties[]`
  wins if both are present). No new schemaVersion was needed — this is within
  v0's existing shape. Every already-supported legacy shape (bare `groups[]`,
  v1 credentialed accounts, v2 current) still migrates forward exactly as
  before; nothing was removed from the migration chain.
- Added unit tests in `configMigrations.test.ts` and `config.test.ts` proving
  `parties[]` migrates identically to `groups[]`, `parties[]` takes precedence
  when both are present, and the drop-warning mentions both terms.

### Client (`src/client/App.tsx` and friends)
- User-visible copy: "Pick the group" → "Pick the party", "Saved groups" →
  "Saved parties", "Group picks" → "Party picks", "This group" → "This party",
  "Nothing in progress/ignored for this group" → "...party", mixed-selection
  warning copy now says "party"/"parties".
- `SessionResponse.activeGroupAlias` → `activePartyAlias`; new `SavedParty`
  type (`groupKey` → `partyKey`); client now calls `/api/party`,
  `/api/party/verify-pins`, `/api/party/clear`, `/api/parties` exclusively
  (the old `/api/group*` routes remain server-side aliases for any other
  consumer, but the shipped client no longer depends on them).
- CSS class names (`saved-groups`, `saved-group-card`, `group-alias`) were
  **kept as-is** — they're implementation details, not user-visible text, and
  renaming them offered no product-terminology benefit while adding markup/CSS
  diff risk. Added a clarifying comment in `styles.css` instead.

### e2e / proof flows (AC1, AC4)
- `e2e/flows/group-alias.mjs` → `party-alias.mjs`, `group-pin.mjs` →
  `party-pin.mjs`: full rewrite to party terminology (screenshots, log
  messages, `/api/parties` assertions), while keeping each flow's `match`
  regex accepting both the old and new flow names.
- `e2e/lib/viewer.mjs`: `pickEveryoneGroupAndContinue` →
  `pickEveryonePartyAndContinue` (old name kept as an exported alias); heading
  matcher updated to `/pick the party/i`. All flow files that select viewers
  (`card-order`, `continue-watching`, `ignore-shows`, `mark-all-watched`,
  `movie-least-watched`, `rail-pagination`, `recommendations`, `search`,
  `show-cross-episode`, `viewer-watched`, `player-handoff`, `player-uat`)
  updated to the new helper name and matching "Pick the party" / "Party picks"
  copy.
- `e2e/run.mjs` updated flow registration/imports and prose comments.

### Docs / automation (AC4)
- `README.md`: repositioned around "party" language; states the rename is done
  (not upcoming) and calls out the `/api/group*` compatibility aliases.
- `tools/sandbox/README.md`, `tools/sandbox/provision.mjs`,
  `tools/proxy/Caddyfile`, `docker-compose.yml`, `docker-compose.sbx.yml`:
  prose updated to "party" terminology, with an explicit compatibility note
  about legacy `groups[]`/`parties[]` config keys.
- `kb/00000000-0000-0000-0000-000000000000.md` (agent guide): one stale
  "per-group JF user" phrase corrected to "per-party" for consistency with the
  now-completed rename.

## Compatibility aliases added
- Server routes: `/api/group`, `/api/group/verify-pins`, `/api/groups`,
  `/api/group/clear` — all still live, wired to the same handlers as their
  `/api/party*` counterparts.
- Response fields: `activeGroupAlias` (session), `groups`/`groupKey` (parties
  list).
- Config: legacy `groups[]` preset list still accepted at schemaVersion 0
  (alongside the new `parties[]` spelling).
- Persisted state: `groupPlayerUsers`/`groupAliases` state-file keys still read
  as a fallback (never written again, matching the existing `ignoredShows`
  pattern).
- Internal types: `GroupPlayerUser` kept as a structural alias for
  `PartyPlayerUser`.
- Jellyfin username format `gbx-grp-<id>` and the UUIDv5 key-derivation
  namespace: unchanged (these are data/wire compatibility, not display text).
- e2e helper: `pickEveryoneGroupAndContinue` kept as an alias for
  `pickEveryonePartyAndContinue`.

## Which ACs I believe are satisfied and why
- **AC1** (user-visible copy/nav/labels/empty-states/proof-test-flow text says
  "party"): satisfied. Verified by reading the rendered UI in a real sandbox
  run (`PROOF_FLOW=party-alias` and `PROOF_FLOW=party-pin` both passed against
  a live sandbox Jellyfin, screenshots confirm "Pick the party", "Saved
  parties", "Party picks", alias label, mixed-party warning, etc.).
- **AC2** (server API contracts / client state use party-oriented names for
  new fields/helpers, with compatibility for existing group-oriented
  consumers): satisfied. New `/api/party*` routes and `partyKey`/`parties`
  response shapes are canonical; verified via curl against the running sandbox
  that the old `/api/group`, `/api/groups`, `/api/group/clear` routes and
  `groupKey`/`groups`/`activeGroupAlias` fields still work byte-for-byte
  identically alongside the new ones.
- **AC3** (config auto-migrates/aliases every previously-supported
  group-shaped config to party terminology, no manual step, no schema rollback
  risk): satisfied for every config shape this app has ever supported
  (schemaVersion 0 `groups[]`, schemaVersion 1 credentialed accounts,
  schemaVersion 2 current). Added `parties[]` as an accepted alias for the
  legacy `groups[]` preset key. No new schemaVersion was needed since neither
  the v1 nor the v2 schema ever had a literal "group" field — the only
  group-shaped legacy input was the v0 preset list, which is now dual-spelled.
  Unit tests cover both spellings end-to-end through `buildEffectiveConfig`.
- **AC4** (sandbox/UAT/README/developer docs/automation scripts describe
  parties consistently, with compat notes for legacy group keys/paths):
  satisfied for every file this phase touched — README, tools/sandbox/README,
  provision script comments, Caddyfile, docker-compose files, and the shared
  agent guide's one stale mention. Compatibility notes were added wherever a
  legacy key/route survives (README, tools/sandbox/README, server.ts route
  comments).
- **AC5** (typecheck/unit/visual-proof verification) is explicitly out of
  scope for this phase per the handoff prompt — a later verifier/prover phase
  owns it. That said, I self-checked as I went: `docker compose run --rm
  check` and `docker compose run --rm test` are both green (150 tests, 146
  pass + 4 pre-existing real-Jellyfin skips, 0 fail), and I additionally ran
  both renamed e2e proof flows (`party-alias`, `party-pin`) against a live
  sandbox Jellyfin stack to confirm the rename works end-to-end, not just in
  unit tests.

## Anything incomplete / left for later phases
- I did not rename the CSS class names (`saved-groups`, `saved-group-card`,
  `group-alias`) or the Jellyfin username prefix (`gbx-grp-`) — both are
  deliberate, documented decisions (implementation detail / data compatibility
  respectively), not oversights.
- I did not touch other effort directories under `./efforts`, nor edit this
  effort spec's checkboxes (left for the approver).
- Full verification (AC5: typecheck, unit coverage for config/API
  compatibility, at least one visual proof) is intentionally left to the next
  phase per the handoff, though I've already produced strong evidence (green
  check/test, two full sandbox proof-flow runs, and manual curl verification
  of the compat routes) that nothing is obviously broken.
