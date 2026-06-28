// Generate the deterministic sandbox media library from fixtures.mjs.
//
// Output (under MEDIA_ROOT, default /media):
//   <root>/shows/<Title> (<Year>)/tvshow.nfo
//   <root>/shows/<Title> (<Year>)/Season 0N/<base>.mp4  + <base>.nfo
//   <root>/movies/<Title> (<Year>)/<base>.mp4           + <base>.nfo
//
// Each .mp4 is a short, 32x32 ffmpeg encode (H264 + silent AAC + faststart) so
// Jellyfin probes a REAL (short) RunTimeTicks — a few KB each, single-digit MB
// total. The format is the canonical Chromium DIRECT-PLAY container: previously
// these were H264-in-MKV, which Chromium can't DirectPlay, so JF transcoded and
// (wrongly) targeted VideoCodec=av1 -> 500 on /hls1/main/-1.mp4 -> the player
// errored at t=0. An MP4 with H264 video + AAC audio + +faststart plays directly,
// so no transcode happens and playback actually starts (feeding /Sessions for the
// Stage B watched fan-out).
//
// IMPORTANT: changing the extension changes the ON-DISK paths, which changes the
// Jellyfin ITEM GUIDs. The sandbox must be RE-GENERATED with FORCE=1 and
// RE-SCANNED / RE-PROVISIONED for the new items to appear (old .mkv items become
// stale). User GUIDs are unaffected. (Runtime does the re-gen + re-provision.)
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

// Remove a stale same-base .mkv next to the .mp4 we now write. Earlier versions
// emitted H264-in-MKV; if those linger in the media volume a rescan catalogs the
// stale (non-DirectPlay) item alongside the new MP4. Always runs (even on the
// idempotent no-encode path) so existing volumes get cleaned. Returns true if a
// stale file was removed.
let staleMkvRemoved = 0;
async function removeStaleMkv(mp4Path) {
  const mkvPath = mp4Path.replace(/\.mp4$/i, '.mkv');
  if (mkvPath !== mp4Path && (await exists(mkvPath))) {
    await rm(mkvPath, { force: true });
    staleMkvRemoved += 1;
    return true;
  }
  return false;
}

const VIDEO_SECONDS = Number(process.env.SANDBOX_VIDEO_SECONDS ?? 12);
if (!Number.isFinite(VIDEO_SECONDS) || VIDEO_SECONDS <= 0) {
  throw new Error(`SANDBOX_VIDEO_SECONDS must be a positive number, got ${process.env.SANDBOX_VIDEO_SECONDS}`);
}
const VIDEO_SECONDS_TEXT = String(VIDEO_SECONDS);

// Encode a tiny REAL video so Jellyfin probes a short, non-zero RunTimeTicks.
// Default 12 seconds, 32x32, H264 video + a silent AAC audio track, +faststart -> the
// canonical Chromium DIRECT-PLAY MP4 so JF does NOT transcode (no av1/HLS 500).
// testsrc gives a deterministic frame; anullsrc supplies the silent audio track;
// -shortest + -t cap the length to the configured short duration.
async function encodeStub(filePath) {
  // Clean up any stale .mkv for this base regardless of whether we re-encode.
  await removeStaleMkv(filePath);
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
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-shortest',
    '-t', VIDEO_SECONDS_TEXT,
    '-movflags', '+faststart',
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
        const video = path.join(seasonDir, `${base}.mp4`);
        const nfo = path.join(seasonDir, `${base}.nfo`);
        if (await encodeStub(video)) encoded += 1;
        if (await writeIfNeeded(nfo, episodeNfo(show, s.season, ep))) nfos += 1;
      }
    }
  }

  for (const movie of MOVIES) {
    const dir = path.join(MOVIES_ROOT, movieFolder(movie));
    const base = movieBaseName(movie);
    const video = path.join(dir, `${base}.mp4`);
    const nfo = path.join(dir, `${base}.nfo`);
    if (await encodeStub(video)) encoded += 1;
    if (await writeIfNeeded(nfo, movieNfo(movie))) nfos += 1;
  }

  console.log(`[generate] media root: ${MEDIA_ROOT}`);
  console.log(`[generate] video duration: ${VIDEO_SECONDS_TEXT}s`);
  console.log(`[generate] encoded ${encoded} stub video(s), wrote ${nfos} .nfo file(s)${FORCE ? ' (forced)' : ' (idempotent)'}.`);
  if (staleMkvRemoved > 0) {
    console.log(`[generate] removed ${staleMkvRemoved} stale .mkv file(s) (superseded by DirectPlay .mp4).`);
  }
}

main().catch((err) => {
  console.error('[generate] failed:', err);
  process.exit(1);
});
