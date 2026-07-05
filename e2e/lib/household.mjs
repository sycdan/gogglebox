// Resolve the HOUSEHOLD viewer set the app actually uses, instead of every
// Jellyfin user. The seeders must only touch household viewers: stray users
// (e.g. the sandbox `gogglebox-admin`, who is in no party) are never pills but
// their seeded played-state still drives Jellyfin Resume/NextUp, which desyncs
// the displayed episode from the fixture. We read the same config.json the
// server reads (mounted at /app/config.json) and intersect its configured
// users[].jellyfin_name entries with the live Jellyfin users.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Read the configured user NAMES from config v2 (users[].jellyfin_name). The
// proof container mounts the repo at /app, and the sandbox path mounts
// config.sbx.json over /app/config.json, so this resolves for both live and
// sandbox.
async function readHouseholdMemberNames(configPath) {
  const resolved = configPath || process.env.GOGGLEBOX_CONFIG || path.resolve(process.cwd(), 'config.json');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`could not read household config at ${resolved}: ${error?.message ?? error}`);
  }
  const users = Array.isArray(parsed?.users) ? parsed.users : [];
  return users
    .map((u) => (typeof u?.jellyfin_name === 'string' ? u.jellyfin_name : null))
    .filter(Boolean);
}

// The household viewers: live Jellyfin users intersected with the configured
// users[] names. Falls back to all users only if config lists no users (so
// non-sandbox deploys still function), logging the choice so a desync is
// diagnosable.
export async function householdUsers(jf, { configPath } = {}, log = console.log) {
  const allUsers = await jf.listUsers();
  let memberNames = [];
  try {
    memberNames = await readHouseholdMemberNames(configPath);
  } catch (error) {
    log(`[proof][seed] household: ${error?.message ?? error}; falling back to ALL Jellyfin users`);
    return allUsers;
  }

  if (memberNames.length === 0) {
    log('[proof][seed] household: no users in config; using ALL Jellyfin users');
    return allUsers;
  }

  const memberSet = new Set(memberNames);
  const scoped = allUsers.filter((u) => memberSet.has(u.name));
  if (scoped.length === 0) {
    log(`[proof][seed] household: config names matched no live users (${memberNames.length} names); falling back to ALL users`);
    return allUsers;
  }

  const dropped = allUsers.filter((u) => !memberSet.has(u.name)).map((u) => u.name);
  log(
    `[proof][seed] household: scoped to ${scoped.length} viewer(s) [${scoped.map((u) => u.name).join(', ')}]` +
    (dropped.length ? ` (excluded ${dropped.join(', ')})` : ''),
  );
  return scoped;
}
