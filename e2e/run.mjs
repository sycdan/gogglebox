// Visual-proof driver. Runs inside the `proof` service (Playwright image),
// logs into the running client, and writes full-page screenshots to
// ./artifacts/<timestamp>/ so the Prover agent can Read them.
//
// Usage (via dev compose):
//   docker compose -f docker-compose.dev.yml --profile proof run --rm proof
//   docker compose -f docker-compose.dev.yml --profile proof run --rm -e PROOF_FLOW=my-feature proof
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

import { mkdir } from 'node:fs/promises';
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

// Flow dispatch order — preserved from the original single-file script. Each
// flow whose `match` matches the flowName runs; multiple may fire for one name.
const flows = [playerFocus, continueWatching, recommendations, ignoreShows, search, viewerWatched, markAllWatched];

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

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve('artifacts', stamp);

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
