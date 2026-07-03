# Gogglebox Backlog

## 🐞 To fix

## 🛠️ To build

- Intra-show search. Click on a show title anywhere, and it pops up a modal with an episode list with buttons for seasons, search episode keywords across seasons; show every watcher's seen state for each episode in the list.


## ✅ Done

- **Refactor user management and auth** — `users[]` keyed by Jellyfin name +
  `accounts[]` multi-login + per-user/per-account pins (the current
  `schemaVersion: 1` shape), dynamic pin-gated groups, name-based startup
  resolution (no UUIDs), env auto-login. Config is **auto-migrated** forward on
  startup (versioned migration engine in `src/server/configMigrations.ts`);
  noteworthy config changes are called out in the GitHub release notes.

- **sandbox provision — Jellyfin ignored episode `.nfo` (no season/episode
  numbers)** (fixed + proven 2026-06-30). Every episode came back with
  `IndexNumber`/`ParentIndexNumber` null and `Name` = the raw filename (not the
  nfo `<title>`), so the seeder's `regularSeasonEpisodes` filter
  (`seasonNumber >= 1`) discarded all 20 episodes → `DATA GAP - no spare series`.
  Root cause: the nfo carried `<lockdata>true</lockdata>`; on import Jellyfin locks
  the item, and for EPISODES that lock lands before the nfo's `<season>`/`<episode>`
  are applied — leaving the numbers null AND blocking every later refresh (a manual
  `FullRefresh` + `replaceAllMetadata` did nothing until the item was unlocked).
  Fix: `tools/sandbox/generate-fixtures.mjs` omits `<lockdata>` from all nfo
  templates; scans stay offline via the library options
  (`EnableInternetProviders: false` + empty fetcher lists), which don't need the
  lock. After a from-scratch re-provision, 20/20 episodes carry correct S/E numbers
  and nfo titles.

- **e2e `player-handoff` proof — playback forced to transcode → AV1 HLS 500**
  (fixed + proven 2026-06-30). Playwright's bundled open-source Chromium ships
  WITHOUT proprietary H264/AAC decoders, so jellyfin-web disabled direct play and
  asked JF to transcode to AV1 (the codec that Chromium CAN decode) — which the
  sandbox JF can't encode, so the HLS segment 500'd. Earlier fixtures were H264
  (MKV → MP4) on the mistaken theory that H264/AAC "DirectPlays". Fix:
  `tools/sandbox/generate-fixtures.mjs` encodes **VP9 + Opus in WebM**
  (`libvpx-vp9` / `libopus`), natively decodable by that Chromium, so jellyfin-web
  DirectPlays (`/Videos/<id>/stream.webm?Static=true`, `stream errors = []`).

- **`proof` service used a stale Jellyfin API key (401)** (fixed 2026-06-30). The
  base `proof` service hardcoded `JELLYFIN_URL`/`JELLYFIN_API_KEY` in
  `environment:` (interpolated from the shared `.env`), which OVERRODE the
  overlay's `env_file: [.env, .env.sbx]`. After a re-provision minted a new key into
  `.env.sbx`, the proof kept using the stale `.env` key → `GET /Users` 401. Fix:
  `docker-compose.yml` moves those creds out of `environment:` into
  `env_file: [.env]` (same pattern as `server`), so the sbx/uat overlay's
  `.env.sbx` layer wins.

- **e2e `player-handoff` seed client ignored the Jellyfin `/player` base path**
  (fixed + proven 2026-06-30). The e2e seed client appended paths to a bare
  `JELLYFIN_URL` (the `proof` service gets the bare value via compose
  `${JELLYFIN_URL}` interpolation from the shared `.env`, which overrides the
  `/player` value in `.env.sbx`). `GET /Users` then hit the JF web SPA, parsed to
  `[]`, and seeding threw `no household viewers resolved`. Fix:
  `e2e/lib/seed-inprogress.mjs` resolves the live base via a `connect()` helper
  calling `resolveJellyfinBase` (`tools/sandbox/baseUrl.mjs`) — probes the bare
  root, falls back to `<root>/player`, exactly like the server — so all seven
  seeders are env-agnostic (bare-only JF still resolves to bare; no regression).

  > With all four fixes, `PROOF_FLOW=player-handoff` passes end-to-end: seeds an
  > in-progress episode, hands off to the `/player` iframe logged in as the gbx
  > group user, and playback PROGRESSES via DirectPlay with no stream 5xx.

## Refactor user management and auth (original spec, kept for reference)

This was the **top Priority**.

The goal is that an end user can deploy gogglebox on their local network (which already hosts jellyfin), and share their library with one or more households (including their own).

Certain users should be able to require a pin if a group that contains them is selected (but only from specific households).

### Example

- A, B, C live in house1
- D lives in house2
- C visits D and wants to share a show they have already seen at home

4 jellyfin users: A, B, C, D

public ingress to house1 googglebox: gogglebox.house1.com

separate login for house1 and house2:
- house1:password1
- house2:password2

C goes to house2, loads gogglebox.house1.com, logs in with house2:password2

Sees any groups that have been created for house2 (a group is just a jellyfin user with name matching a conventional pattern)
Can form a new group from any of the visible users across configured households.

C selects A, C, D; app prompts for C's pin, which they cannot provide as they are ot present -- can't create group
C selects C, D; app prompts for C's pin as they are in another household; they provide it; create new group: C + D (house2)

config:

```json
{
 "users": [{"jellyfin_name": "A", "pin": "1234"}, {"B"}, {"C"}, {"D"}],
  "accounts": [
    {"username": "a-at-home", "password": "xxx", "users": "some struct that captures visible users and whether their pin is needed"}
    {"username": "a-at-d", "password": "yyy"},
  ]
}
```


### notes

we can drop portal auto login env var; if portal user and pass are set in env, just auto login.

unresolvable users (a configured `jellyfin_name` with no matching Jellyfin user)
are dropped with a warning rather than crashing startup — a renamed/deleted
Jellyfin user must not take the whole portal down. Startup fails fast only if the
result is unusable (no users or no accounts).

we should stop tracking uids in user config, as names are unique in jf already

the app should take what it needs form the read-only user config and create its own internal state files as necessary to track user ids or whatever else it needs to function
