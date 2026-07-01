// Generate the deterministic sandbox media library from fixtures.mjs.
//
// Output (under MEDIA_ROOT, default /media):
//   <root>/shows/<Title> (<Year>)/tvshow.nfo
//   <root>/shows/<Title> (<Year>)/Season 0N/<base>.webm  + <base>.nfo
//   <root>/movies/<Title> (<Year>)/<base>.webm           + <base>.nfo
//
// Each .webm is a short, 32x32 ffmpeg encode (VP9 video + silent Opus audio) so
// Jellyfin probes a REAL (short) RunTimeTicks — a few KB each, single-digit MB
// total. VP9 + Opus in WebM is the format the PROOF browser can actually DECODE:
// Playwright's bundled Chromium is the open-source build, which ships WITHOUT the
// proprietary H264/AAC decoders. Earlier fixtures were H264 (first in MKV, then in
// MP4) on the theory that H264/AAC "DirectPlays"; but since the headless browser
// can't decode H264 at all, jellyfin-web disabled direct play and asked JF to
// transcode to VideoCodec=av1 (the best codec open-Chromium CAN decode) — which
// the sandbox JF's ffmpeg can't encode, so the HLS segment 500'd and the player
// errored at t=0. VP9 + Opus is royalty-free and natively decodable by that same
// Chromium, so jellyfin-web DirectPlays it: no transcode, playback actually starts
// (feeding /Sessions for the Stage B watched fan-out).
//
// IMPORTANT: changing the extension changes the ON-DISK paths, which changes the
// Jellyfin ITEM GUIDs. The sandbox must be RE-GENERATED with FORCE=1 and
// RE-SCANNED / RE-PROVISIONED for the new items to appear (old .mp4/.mkv items
// become stale). User GUIDs are unaffected. (Runtime does the re-gen + re-provision.)
//
//   FORCE=1 node tools/sandbox/generate-fixtures.mjs

import { execFile } from 'node:child_process';
import { mkdir, writeFile, access, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  SHOWS,
  MOVIES,
  showFolder,
  seasonFolder,
  episodeBaseName,
  movieFolder,
  movieBaseName,
} from './fixtures.mjs';

const execFileAsync = promisify(execFile);

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/media';
const SHOWS_ROOT = path.join(MEDIA_ROOT, 'shows');
const MOVIES_ROOT = path.join(MEDIA_ROOT, 'movies');
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const xmlEscape = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Remove stale same-base .mp4/.mkv next to the .webm we now write. Earlier
// versions emitted H264-in-MKV, then H264-in-MP4; if those linger in the media
// volume a rescan catalogs the stale (non-DirectPlay) item alongside the new
// WebM. Always runs (even on the idempotent no-encode path) so existing volumes
// get cleaned. Returns true if any stale file was removed.
let staleSourcesRemoved = 0;
async function removeStaleSources(webmPath) {
  let removed = false;
  for (const ext of ['.mp4', '.mkv']) {
    const stalePath = webmPath.replace(/\.webm$/i, ext);
    if (stalePath !== webmPath && (await exists(stalePath))) {
      await rm(stalePath, { force: true });
      staleSourcesRemoved += 1;
      removed = true;
    }
  }
  return removed;
}

const VIDEO_SECONDS = Number(process.env.SANDBOX_VIDEO_SECONDS ?? 12);
if (!Number.isFinite(VIDEO_SECONDS) || VIDEO_SECONDS <= 0) {
  throw new Error(`SANDBOX_VIDEO_SECONDS must be a positive number, got ${process.env.SANDBOX_VIDEO_SECONDS}`);
}
const VIDEO_SECONDS_TEXT = String(VIDEO_SECONDS);

// Encode a tiny REAL video so Jellyfin probes a short, non-zero RunTimeTicks.
// Default 12 seconds, 32x32, VP9 video + a silent Opus audio track in WebM -> the
// format Playwright's open-source Chromium can DECODE, so JF DirectPlays it (no
// av1/HLS 500). testsrc gives a deterministic frame; anullsrc supplies the silent
// audio track; -shortest + -t cap the length to the configured short duration.
// libvpx-vp9 wants -b:v 0 alongside -crf for constant-quality VBR; -deadline
// realtime + -cpu-used 8 keep the trivial 32x32 encode fast.
async function encodeStub(filePath) {
  // Clean up any stale .mp4/.mkv for this base regardless of whether we re-encode.
  await removeStaleSources(filePath);
  if (!FORCE && (await exists(filePath))) {
    return false;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await execFileAsync(FFMPEG, [
    '-y',
    '-f', 'lavfi',
    '-i', `testsrc=duration=${VIDEO_SECONDS_TEXT}:size=32x32:rate=24`,
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-c:v', 'libvpx-vp9',
    '-crf', '30',
    '-b:v', '0',
    '-deadline', 'realtime',
    '-cpu-used', '8',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'libopus',
    '-shortest',
    '-t', VIDEO_SECONDS_TEXT,
    filePath,
  ]);
  return true;
}

// tvshow.nfo at the series root. lockdata + empty providerids keep scans offline.
function tvshowNfo(show) {
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<tvshow>
  <title>${xmlEscape(show.title)}</title>
  <year>${show.year}</year>
  <premiered>${show.year}-01-01</premiered>
  <lockdata>true</lockdata>
</tvshow>
`;
}

function episodeNfo(show, season, ep) {
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<episodedetails>
  <title>${xmlEscape(ep.title)}</title>
  <showtitle>${xmlEscape(show.title)}</showtitle>
  <season>${season}</season>
  <episode>${ep.ep}</episode>
  <aired>${ep.premiere}</aired>
  <premiered>${ep.premiere}</premiered>
  <lockdata>true</lockdata>
</episodedetails>
`;
}

function movieNfo(movie) {
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <title>${xmlEscape(movie.title)}</title>
  <year>${movie.year}</year>
  <premiered>${movie.year}-01-01</premiered>
  <lockdata>true</lockdata>
</movie>
`;
}

async function writeIfNeeded(filePath, contents) {
  if (!FORCE && (await exists(filePath))) {
    return false;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
  return true;
}

async function main() {
  let encoded = 0;
  let nfos = 0;

  for (const show of SHOWS) {
    const dir = path.join(SHOWS_ROOT, showFolder(show));
    if (await writeIfNeeded(path.join(dir, 'tvshow.nfo'), tvshowNfo(show))) nfos += 1;

    for (const s of show.seasons) {
      const seasonDir = path.join(dir, seasonFolder(s.season));
      for (const ep of s.episodes) {
        const base = episodeBaseName(show, s.season, ep);
        const video = path.join(seasonDir, `${base}.webm`);
        const nfo = path.join(seasonDir, `${base}.nfo`);
        if (await encodeStub(video)) encoded += 1;
        if (await writeIfNeeded(nfo, episodeNfo(show, s.season, ep))) nfos += 1;
      }
    }
  }

  for (const movie of MOVIES) {
    const dir = path.join(MOVIES_ROOT, movieFolder(movie));
    const base = movieBaseName(movie);
    const video = path.join(dir, `${base}.webm`);
    const nfo = path.join(dir, `${base}.nfo`);
    if (await encodeStub(video)) encoded += 1;
    if (await writeIfNeeded(nfo, movieNfo(movie))) nfos += 1;
  }

  console.log(`[generate] media root: ${MEDIA_ROOT}`);
  console.log(`[generate] video duration: ${VIDEO_SECONDS_TEXT}s`);
  console.log(`[generate] encoded ${encoded} stub video(s), wrote ${nfos} .nfo file(s)${FORCE ? ' (forced)' : ' (idempotent)'}.`);
  if (staleSourcesRemoved > 0) {
    console.log(`[generate] removed ${staleSourcesRemoved} stale .mp4/.mkv file(s) (superseded by DirectPlay .webm).`);
  }
}

main().catch((err) => {
  console.error('[generate] failed:', err);
  process.exit(1);
});
