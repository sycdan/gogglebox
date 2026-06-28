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
import { resolveJellyfinBase } from './baseUrl.mjs';

const apiKey = process.env.JELLYFIN_API_KEY;

if (!apiKey) {
  console.error('[reset] JELLYFIN_API_KEY is required (see .env.sbx from provision.mjs).');
  process.exit(1);
}

// reset runs post-provision (BaseUrl already /player), but the anchor may inject a
// BARE JELLYFIN_URL. Discover the active base (bare vs /player) so we don't hit a
// 302 like provision did before this fix.
const base = await resolveJellyfinBase(process.env.JELLYFIN_URL, { token: apiKey });
console.log(`[reset] active base: ${base}`);

const jf = makeJellyfin(base, apiKey);
await jf.resetAllPlayedState(console.log);
console.log('[reset] sandbox played-state is clean.');
