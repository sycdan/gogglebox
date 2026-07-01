# Gogglebox Backlog

## 🐞 To fix

### e2e `player-handoff` proof — playback forced to transcode → AV1 HLS 500

**Symptom.** `PROOF_FLOW=player-handoff` now runs end-to-end (seeds, hands off,
logs into the Jellyfin tab, playback starts) but FAILS at the final gate:

```text
FAIL: a video STREAM returned 5xx — 500 …/player/videos/<id>/hls1/main/-1.mp4
      ?VideoCodec=av1&AudioCodec=opus,flac…TranscodeReasons=AudioCodecNotSupported
```

**Root cause.** The source fixture is DirectPlay-clean (`ffprobe` confirms
`h264` + `aac`, and jellyfin-web's own detail pane reads "144p H264 SDR / Audio
AAC"). Despite that, the playback request disables direct play —
`EnableDirectPlay=false&EnableDirectStream=false&AllowVideoStreamCopy=false` in
the `/Items/<id>/PlaybackInfo` call — so JF is FORCED to transcode, negotiates
**AV1 + opus/flac**, and the sandbox JF (no usable AV1 transcoder) 500s on the
first HLS segment. So the fixture is NOT the problem (it is already H264/AAC per
`tools/sandbox/generate-fixtures.mjs`, which encodes `-c:v libx264 -c:a aac`);
the problem is that something in the player launch turns direct play OFF.

**Where to look.** Trace who sets `EnableDirectPlay=false` on the launch:

- the app's player-launch path (`src/client/playerLaunch.ts`, `src/client/App.tsx`
  gbx-trigger) — is it injecting a device profile / max-bitrate that disallows
  direct play?
- or jellyfin-web's default profile inside the same-origin `/player` iframe.
A direct-playable source that reports H264/AAC should be able to DirectPlay; the
launch must stop disabling it (or supply a profile that lists H264/AAC as
direct-play-capable).

**Verify.**
`./scripts/sbx.sh run --rm -e PROOF_URL=http://proxy:8080 -e PROOF_FLOW=player-handoff proof`
should reach real playback WITHOUT a 5xx on `…/videos/<id>/hls1/…` (no transcode)
and produce `player-handoff-jellyfin-playing.png` with playback actually started.

## ✅ Done

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
  (bare-only JF still resolves to bare; no regression). **Proven on the sandbox:**
  the flow now seeds, scopes to the household, clicks Resume, reaches the gbx
  panel, and logs into the Jellyfin handoff tab; it only stops at the separate
  transcode issue above.
