# Gogglebox Backlog

## 🐞 To fix

Nothing open.

## ✅ Done

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
