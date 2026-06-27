// Visual-proof driver. Runs inside the `proof` service (Playwright image),
// logs into the running client, and writes full-page screenshots to
// ./artifacts/<timestamp>/ so the Prover agent can Read them.
//
// Usage (via dev compose):
//   docker compose --profile proof run --rm proof
//   docker compose --profile proof run --rm -e PROOF_FLOW=my-feature proof
//
// Env:
//   PROOF_URL        target client URL (default http://client:5173)
//   PROOF_FLOW       flow name prefixing screenshot files (default "app";
//                    falls back to the first CLI arg if unset)
//   PORTAL_USERNAME  household login username (required)
//   PORTAL_PASSWORD  household login password (required)
//   PORTAL_AUTO_LOGIN  "true"/"1" skips the login form
//
// Exits non-zero on navigation/login failure so agents detect breakage.
//
// Structure: this entry point owns env + outDir + login, then dispatches each
// flow module whose `match` regex tests true against the flow name (in the
// order listed in `flows` below). Shared helpers live under lib/, flow bodies
// under flows/.

import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { createHarness } from './lib/harness.mjs';
import { startSession } from './lib/session.mjs';
import * as playerFocus from './flows/player-focus.mjs';
import * as continueWatching from './flows/continue-watching.mjs';
import * as recommendations from './flows/recommendations.mjs';
import * as ignoreShows from './flows/ignore-shows.mjs';
import * as search from './flows/search.mjs';
import * as viewerWatched from './flows/viewer-watched.mjs';
import * as markAllWatched from './flows/mark-all-watched.mjs';
import * as cardOrder from './flows/card-order.mjs';
import * as movieLeastWatched from './flows/movie-least-watched.mjs';
import * as showCrossEpisode from './flows/show-cross-episode.mjs';
import * as railPagination from './flows/rail-pagination.mjs';

// Flow dispatch order — preserved from the original single-file script. Each
// flow whose `match` matches the flowName runs; multiple may fire for one name.
const flows = [playerFocus, continueWatching, recommendations, ignoreShows, search, viewerWatched, markAllWatched, cardOrder, movieLeastWatched, showCrossEpisode, railPagination];

const url = process.env.PROOF_URL ?? 'http://client:5173';
const username = process.env.PORTAL_USERNAME ?? '';
const password = process.env.PORTAL_PASSWORD ?? '';
const autoLogin = ['1', 'true', 'yes', 'on'].includes(
  (process.env.PORTAL_AUTO_LOGIN ?? '').trim().toLowerCase(),
);
const flowName = (process.env.PROOF_FLOW || process.argv[2] || 'app').replace(
  /[^a-zA-Z0-9_-]/g,
  '-',
);

// Keep only the newest N run dirs in artifacts/ so stale runs don't pile up.
// Pruning runs before this run's dir is created, so the current run is safe.
const ARTIFACT_RUNS_TO_KEEP = 3;

const artifactsRoot = path.resolve('artifacts');

// Prune artifacts/ down to the newest ARTIFACT_RUNS_TO_KEEP run dirs. Dir names
// are sortable ISO timestamps, so a reverse name sort gives newest-first. Only
// directories are touched; a missing artifacts dir (first run) is a no-op.
async function pruneArtifacts() {
  let entries;
  try {
    entries = await readdir(artifactsRoot, { withFileTypes: true });
  } catch {
    return; // no artifacts dir yet, or unreadable — nothing to prune.
  }
  const runDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const name of runDirs.slice(ARTIFACT_RUNS_TO_KEEP)) {
    try {
      await rm(path.join(artifactsRoot, name), { recursive: true, force: true });
      console.log(`[proof] pruned old artifact dir: ${name}`);
    } catch {
      // ignore — a busy/locked dir shouldn't fail the run.
    }
  }
}

await pruneArtifacts();

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(artifactsRoot, stamp);

const ctx = createHarness(outDir);
ctx.flowName = flowName;
const { fail, shoot } = ctx;

await mkdir(outDir, { recursive: true });

const { browser, page } = await startSession({
  url,
  username,
  password,
  autoLogin,
  flowName,
  shoot,
  fail,
});

try {
  for (const flow of flows) {
    if (flow.match.test(flowName)) {
      await flow.run(page, ctx);
    }
  }

  console.log('[proof] OK');
} catch (error) {
  fail('unexpected error during proof run', error);
} finally {
  await browser.close();
}
