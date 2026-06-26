// Deterministic per-test reset for the sandbox Jellyfin.
//
// Returns the sandbox to a CLEAN played-state slate for ALL users (clears every
// user's PlayedItems + zeroes playback positions across the library) WITHOUT a
// container teardown or library rescan. The immutable library/users/key persist;
// only the mutable played-state resets.
//
// Flows do: reset -> seed fixture -> assert.
//
//   node tools/sandbox/reset.mjs
//
// Env: JELLYFIN_URL (default http://jellyfin-sandbox:8096), JELLYFIN_API_KEY.

import { makeJellyfin } from '../../e2e/lib/jellyfin.mjs';

const url = process.env.JELLYFIN_URL || 'http://jellyfin-sandbox:8096';
const apiKey = process.env.JELLYFIN_API_KEY;

if (!apiKey) {
  console.error('[reset] JELLYFIN_API_KEY is required (see .env.sandbox from provision.mjs).');
  process.exit(1);
}

const jf = makeJellyfin(url, apiKey);
await jf.resetAllPlayedState(console.log);
console.log('[reset] sandbox played-state is clean.');
