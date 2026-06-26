// Generate the deterministic sandbox media library from fixtures.mjs.
//
// Output (under MEDIA_ROOT, default /media):
//   <root>/shows/<Title> (<Year>)/tvshow.nfo
//   <root>/shows/<Title> (<Year>)/Season 0N/<base>.mkv  + <base>.nfo
//   <root>/movies/<Title> (<Year>)/<base>.mkv           + <base>.nfo
//
// Each .mkv is a 1-second, 32x32 ffmpeg encode so Jellyfin probes a REAL (short)
// RunTimeTicks — a few KB each, single-digit MB total. Zero-byte files would
// give no ticks and break resume %/setPlaybackPosition math, so we always encode.
//
// Runs inside a container that has ffmpeg (the jellyfin image does). Idempotent:
// existing files are left in place unless FORCE=1, so re-running is cheap and the
// on-disk paths (and therefore Jellyfin GUIDs) stay stable.
//
//   node tools/sandbox/generate-fixtures.mjs

import { execFile } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
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

// Encode a tiny REAL video so Jellyfin probes a short, non-zero RunTimeTicks.
// 1 second, 32x32, silent. testsrc gives a deterministic frame; -t 1 caps length.
async function encodeStub(filePath) {
  if (!FORCE && (await exists(filePath))) {
    return false;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await execFileAsync(FFMPEG, [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=duration=1:size=32x32:rate=24',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-t', '1',
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
        const mkv = path.join(seasonDir, `${base}.mkv`);
        const nfo = path.join(seasonDir, `${base}.nfo`);
        if (await encodeStub(mkv)) encoded += 1;
        if (await writeIfNeeded(nfo, episodeNfo(show, s.season, ep))) nfos += 1;
      }
    }
  }

  for (const movie of MOVIES) {
    const dir = path.join(MOVIES_ROOT, movieFolder(movie));
    const base = movieBaseName(movie);
    const mkv = path.join(dir, `${base}.mkv`);
    const nfo = path.join(dir, `${base}.nfo`);
    if (await encodeStub(mkv)) encoded += 1;
    if (await writeIfNeeded(nfo, movieNfo(movie))) nfos += 1;
  }

  console.log(`[generate] media root: ${MEDIA_ROOT}`);
  console.log(`[generate] encoded ${encoded} stub video(s), wrote ${nfos} .nfo file(s)${FORCE ? ' (forced)' : ' (idempotent)'}.`);
}

main().catch((err) => {
  console.error('[generate] failed:', err);
  process.exit(1);
});
