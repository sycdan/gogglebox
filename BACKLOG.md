# Gogglebox Backlog

## 🐞 To fix

### sandbox provision — Jellyfin ignores episode `.nfo` (no season/episode numbers)

**Symptom.** `PROOF_FLOW=player-handoff` (and any seeder flow) DATA-GAPs:

```text
[proof][seed] show-advance: DATA GAP - no spare series with >=2 regular-season episodes; cannot seed.
```

**Root cause.** After provisioning, every episode has `IndexNumber = null` /
`ParentIndexNumber = null`, and its `Name` is the raw FILENAME
("Normal Show S01E02 Second Wind") instead of the `.nfo` `<title>`
("Second Wind"). So Jellyfin is **not applying the episode `.nfo` at all** and is
**not parsing `SxxExx` from the filename** either — episodes get grouped into
"Season 1" by folder but carry no numbers. The seeder's `regularSeasonEpisodes`
(`e2e/lib/seed-inprogress.mjs`) filters on `seasonNumber >= 1 && typeof
episodeNumber === 'number'`, so it discards all 20 episodes and finds no seedable
series. Confirmed pre-existing (the old .mp4 fixtures hit the same gap); a manual
`Items/<lib>/Refresh?metadataRefreshMode=FullRefresh&replaceAllMetadata=true`
did NOT populate the numbers. `RunTimeTicks` IS correct, so file probing works —
only the nfo/episode-number metadata is missing.

**Where to look.** `tools/sandbox/provision.mjs` library-creation `LibraryOptions`:
the offline setup empties every metadata/image fetcher and sets
`LocalMetadataReaderOrder: ['Nfo']` + `EnableInternetProviders: false`. Something
in that combination is stopping the episode nfo reader / filename resolver from
assigning `IndexNumber`. Check whether `EnableEmbeddedEpisodeInfos`, the episode
metadata-fetcher list, or a metadata refresh pass (not just a library scan) is
needed, and whether the movie items (which don't need episode numbers and DO
play) mask the gap.

**Verify.**
`Items?IncludeItemTypes=Episode&Recursive=true&Fields=ParentIndexNumber,IndexNumber`
should return real season/episode numbers for all 20 episodes, and
`PROOF_FLOW=player-handoff` should seed an in-progress mid-series episode.

## 🔧 Fixed — awaiting end-to-end proof

### e2e `player-handoff` proof — playback forced to transcode → AV1 HLS 500

**Fix applied (2026-06-30).** The proof browser (Playwright's bundled, open-source
Chromium) ships WITHOUT proprietary H264/AAC decoders. jellyfin-web therefore
disabled direct play and asked JF to transcode to **AV1** (the best codec that
Chromium *can* decode) — which the sandbox JF's ffmpeg can't encode, so the HLS
segment 500'd. Earlier fixtures were H264 (MKV → then MP4) on the mistaken theory
that H264/AAC "DirectPlays"; the headless browser can't decode H264 at all, so it
always transcoded. Fix: `tools/sandbox/generate-fixtures.mjs` now encodes
**VP9 + Opus in WebM** (`libvpx-vp9` / `libopus`) — royalty-free and natively
decodable by that Chromium, so jellyfin-web DirectPlays with no transcode.
Verified JF stores the WebM with a correct `RunTimeTicks`. **Cannot prove the full
flow yet** — it is blocked upstream by the episode-`.nfo` DATA GAP above, which
stops the seeder before playback is reached.

## ✅ Done

- **`proof` service used a stale Jellyfin API key (401)** (fixed 2026-06-30). The
  base `proof` service hardcoded `JELLYFIN_URL`/`JELLYFIN_API_KEY` in
  `environment:` (interpolated from the shared `.env`), which OVERRODE the
  overlay's `env_file: [.env, .env.sbx]`. After a sandbox re-provision minted a new
  key into `.env.sbx`, the proof kept using the stale `.env` key → `GET /Users` 401
  → seed skipped. Fix: `docker-compose.yml` moves those creds out of `environment:`
  into `env_file: [.env]` (same pattern as `server`), so the sbx/uat overlay's
  `.env.sbx` layer wins. Verified the proof container now reads the freshly-minted
  key/URL/portal.

- **e2e `player-handoff` seed client ignored the Jellyfin `/player` base path**
  (fixed + proven 2026-06-30). The e2e seed client appended paths to a bare
  `JELLYFIN_URL` (the `proof` service gets the bare value via compose
  `${JELLYFIN_URL}` interpolation from the shared `.env`, which overrides the
  `/player` value in `.env.sbx`). `GET /Users` then hit the JF web SPA, parsed to
  `[]`, and seeding threw `no household viewers resolved`, so no Continue-watching
  card existed and the flow aborted before the handoff. Fix: `e2e/lib/seed-inprogress.mjs`
  now resolves the live base via a `connect()` helper calling `resolveJellyfinBase`
  (`tools/sandbox/baseUrl.mjs`) — probes the bare root, falls back to
  `<root>/player`, exactly like the server — so all seven seeders are env-agnostic
  (bare-only JF still resolves to bare; no regression). Proven on the sandbox: the
  flow now seeds-attempts, scopes to the household [Alice, Bob, Carol, Dave], and
  reaches the gbx panel + Jellyfin handoff tab login.
