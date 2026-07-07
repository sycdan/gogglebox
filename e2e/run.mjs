// Visual-proof driver. Runs inside the `proof` service (Playwright image),
// logs into the running client, and writes full-page screenshots to
// ./artifacts/<timestamp>/ so the Prover agent can Read them.
//
// Usage (via dev compose):
//   docker compose --profile proof run --rm proof
//   docker compose --profile proof run --rm -e PROOF_FLOW=my-feature proof
//
// Env:
//   PROOF_URL         target client URL (default http://client:5173)
//   PROOF_FLOW        flow name prefixing screenshot files (default "app";
//                     falls back to the first CLI arg if unset). The reserved
//                     value "all" runs every flow in `flows` below, in order,
//                     bypassing each flow's `match` regex filter — see
//                     ALL_FLOWS_TOKEN.
//   PROOF_RUN_ID      optional batch id; groups multiple proof invocations under
//                     ./artifacts/<PROOF_RUN_ID>/<timestamp-flow>/
//   ACCESS_TOKEN      account access token (used when the app does not auto-login)
//
// Auto-login is NOT a harness env var: startSession reads the running app's
// GET /api/session (portalAutoLoginEnabled, which the app derives from whether
// the ACCESS_TOKEN env var is set) and either waits for the auto-login or fills
// the token form.
//
// Exits non-zero on navigation/login failure so agents detect breakage.
// fail() (lib/harness.mjs) calls process.exit(1) directly, so any flow
// assertion failure already propagates as a non-zero process exit with no
// extra plumbing in this file.
//
// Structure: this entry point owns env + outDir, then either:
//   - single-flow mode (PROOF_FLOW=<name>, the default): logs in ONCE, then
//     dispatches every flow module whose `match` regex tests true against the
//     flow name (in the order listed in `flows` below) against that one
//     session/page — unchanged from the original behavior.
//   - all-flows mode (PROOF_FLOW=all): runs every flow in `flows` order,
//     each against its OWN fresh browser context/page (a fresh login +ctx) and
//     its own screenshot subdirectory, so route interception, localStorage/
//     session state, selected account, and per-flow mutations from one flow
//     cannot leak into the next (see runAllFlows below).
// Shared helpers live under lib/, flow bodies under flows/.

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
import * as showDetailBrowser from './flows/show-detail-browser.mjs';
import * as railPagination from './flows/rail-pagination.mjs';
import * as playerHandoff from './flows/player-handoff.mjs';
import * as playerUat from './flows/player-uat.mjs';
import * as partyPin from './flows/party-pin.mjs';
import * as partyAlias from './flows/party-alias.mjs';

// Flow dispatch order — preserved from the original single-file script. Each
// flow whose `match` matches the flowName runs; multiple may fire for one name.
// `name` is the canonical id used ONLY by all-flows mode (PROOF_FLOW=all) to
// pick a per-flow screenshot subdirectory and login flowName — single-flow
// invocations still key entirely off the PROOF_FLOW string against `match`.
const flows = [
  { name: 'party-alias', mod: partyAlias },
  { name: 'party-pin', mod: partyPin },
  { name: 'player-handoff', mod: playerHandoff },
  { name: 'player-uat', mod: playerUat },
  { name: 'player-focus', mod: playerFocus },
  { name: 'continue-watching', mod: continueWatching },
  { name: 'recommendations', mod: recommendations },
  { name: 'ignore-shows', mod: ignoreShows },
  { name: 'search', mod: search },
  { name: 'viewer-watched', mod: viewerWatched },
  { name: 'mark-all-watched', mod: markAllWatched },
  { name: 'card-order', mod: cardOrder },
  { name: 'movie-least-watched', mod: movieLeastWatched },
  { name: 'show-cross-episode', mod: showCrossEpisode },
  { name: 'show-detail-browser', mod: showDetailBrowser },
  { name: 'rail-pagination', mod: railPagination },
];

// Reserved PROOF_FLOW value that runs every flow in one invocation. Chosen
// because it can never collide with a real flow name/match (none of the 14
// `match` regexes match the literal "all") and reads clearly in CI logs.
const ALL_FLOWS_TOKEN = 'all';

const url = process.env.PROOF_URL ?? 'http://client:5173';
const accessToken = process.env.ACCESS_TOKEN ?? '';
const rawFlowName = process.env.PROOF_FLOW || process.argv[2] || 'app';
const flowName = rawFlowName.replace(/[^a-zA-Z0-9_-]/g, '-');
const proofRunId = (process.env.PROOF_RUN_ID ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '-');

// Keep only the newest N top-level artifact entries so stale runs don't pile up.
// A top-level entry may be a single proof run dir (old/default behavior) or a
// PROOF_RUN_ID batch dir containing several flow dirs.
const ARTIFACT_ENTRIES_TO_KEEP = 8;

const artifactsRoot = path.resolve('artifacts');

// Prune artifacts/ down to the newest ARTIFACT_ENTRIES_TO_KEEP top-level dirs.
// Dir names are sortable when callers use ISO-ish PROOF_RUN_ID values. The active
// batch dir is always protected so later flows cannot delete earlier screenshots
// from the same prover run.
async function pruneArtifacts(activeTopLevel) {
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
  const candidates = runDirs.filter((name) => name !== activeTopLevel);
  for (const name of candidates.slice(ARTIFACT_ENTRIES_TO_KEEP)) {
    try {
      await rm(path.join(artifactsRoot, name), { recursive: true, force: true });
      console.log(`[proof] pruned old artifact dir: ${name}`);
    } catch {
      // ignore — a busy/locked dir shouldn't fail the run.
    }
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const topLevel = proofRunId || stamp;
await pruneArtifacts(topLevel);

const isAllFlows = flowName === ALL_FLOWS_TOKEN;

if (isAllFlows) {
  await runAllFlows();
} else {
  await runSingleFlowInvocation();
}

// ── Single-flow mode (unchanged behavior) ───────────────────────────────────
// One outDir, one login, one page; every flow whose `match` tests true against
// flowName runs against that shared page/session, exactly as before this
// effort.
async function runSingleFlowInvocation() {
  const outDir = proofRunId
    ? path.join(artifactsRoot, proofRunId, `${stamp}-${flowName}`)
    : path.join(artifactsRoot, stamp);

  const ctx = createHarness(outDir);
  ctx.flowName = flowName;
  const { fail, shoot } = ctx;

  await mkdir(outDir, { recursive: true });

  const { browser, page } = await startSession({
    url,
    accessToken,
    flowName,
    shoot,
    fail,
  });

  try {
    for (const flow of flows) {
      if (flow.mod.match.test(flowName)) {
        await flow.mod.run(page, ctx);
      }
    }

    console.log('[proof] OK');
  } catch (error) {
    fail('unexpected error during proof run', error);
  } finally {
    await browser.close();
  }
}

// ── All-flows mode (PROOF_FLOW=all) ─────────────────────────────────────────
// Runs every flow in `flows` order, in ONE process invocation, but isolates
// each flow with its OWN fresh browser (a fresh startSession() launch + login)
// rather than sharing one page/session across flows. So route interception
// (party-pin's /api/session patch), localStorage/session state
// (player-handoff's seeded jellyfin_credentials), the selected account
// (party-pin logs in as a different user), and any other per-flow mutation
// from one flow cannot leak into the next — each flow starts from the exact
// same clean logged-in state single-flow mode starts from today. Each flow
// also gets its own screenshot subdirectory (keyed by the flow's own canonical
// name — exactly the flowName that flow would get in single-flow mode) so
// hardcoded and `${flowName}-...` screenshot names never collide across flows
// sharing one batch.
async function runAllFlows() {
  const batchDir = proofRunId
    ? path.join(artifactsRoot, proofRunId, `${stamp}-all`)
    : path.join(artifactsRoot, `${stamp}-all`);

  console.log(`[proof] all-flows: running ${flows.length} flow(s) in dispatch order`);

  for (const flow of flows) {
    const perFlowName = flow.name;
    const outDir = path.join(batchDir, perFlowName);
    await mkdir(outDir, { recursive: true });

    const ctx = createHarness(outDir);
    ctx.flowName = perFlowName;
    const { fail, shoot } = ctx;

    console.log(`[proof] all-flows: -- starting "${perFlowName}" --`);

    // A brand-new browser (and therefore a brand-new default context/page) per
    // flow: cookies, localStorage, and any page.route() interceptors installed
    // by the previous flow cannot leak into this one.
    const { browser, page } = await startSession({
      url,
      accessToken,
      flowName: perFlowName,
      shoot,
      fail,
    });

    try {
      await flow.mod.run(page, ctx);
      console.log(`[proof] all-flows: -- "${perFlowName}" OK --`);
    } catch (error) {
      fail(`all-flows: "${perFlowName}" failed unexpectedly`, error);
    } finally {
      await browser.close().catch(() => {});
    }
  }

  console.log('[proof] OK — all flows passed');
}
