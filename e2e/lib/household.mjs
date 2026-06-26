// Resolve the HOUSEHOLD viewer set the app actually uses, instead of every
// Jellyfin user. The seeders must only touch household viewers: stray users
// (e.g. the sandbox `gogglebox-admin`, who is in no group) are never pills but
// their seeded played-state still drives Jellyfin Resume/NextUp, which desyncs
// the displayed episode from the fixture. We read the same config.json the
// server reads (mounted at /app/config.json), pick the largest group (the
// "Everyone"/all group), and intersect its member GUIDs with the live users.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Read the household group's member GUIDs from config.json. The proof container
// mounts the repo at /app, and the sandbox path mounts config.sandbox.json over
// /app/config.json, so this resolves correctly for both live and sandbox.
async function readHouseholdMemberIds(configPath) {
  const resolved = configPath || process.env.GOGGLEBOX_CONFIG || path.resolve(process.cwd(), 'config.json');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`could not read household config at ${resolved}: ${error?.message ?? error}`);
  }
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
  if (groups.length === 0) {
    return [];
  }
  // Prefer a group literally named "Everyone"; otherwise the largest group (the
  // all-household set). Don't hardcode names/GUIDs so this works for any deploy.
  const everyone = groups.find((g) => /^everyone$/i.test(g?.name ?? ''));
  const chosen = everyone
    ?? groups.reduce((best, g) =>
      ((g?.memberIds?.length ?? 0) > (best?.memberIds?.length ?? 0) ? g : best), groups[0]);
  return Array.isArray(chosen?.memberIds) ? chosen.memberIds : [];
}

// The household viewers: live Jellyfin users intersected with the configured
// household group's member GUIDs. Falls back to all users only if config has no
// groups (so non-sandbox deploys without groups still function), logging the
// choice so a desync is diagnosable.
export async function householdUsers(jf, { configPath } = {}, log = console.log) {
  const allUsers = await jf.listUsers();
  let memberIds = [];
  try {
    memberIds = await readHouseholdMemberIds(configPath);
  } catch (error) {
    log(`[proof][seed] household: ${error?.message ?? error}; falling back to ALL Jellyfin users`);
    return allUsers;
  }

  if (memberIds.length === 0) {
    log('[proof][seed] household: no groups in config; using ALL Jellyfin users');
    return allUsers;
  }

  const memberSet = new Set(memberIds);
  const scoped = allUsers.filter((u) => memberSet.has(u.id));
  if (scoped.length === 0) {
    log(`[proof][seed] household: config GUIDs matched no live users (${memberIds.length} ids); falling back to ALL users`);
    return allUsers;
  }

  const dropped = allUsers.filter((u) => !memberSet.has(u.id)).map((u) => u.name);
  log(
    `[proof][seed] household: scoped to ${scoped.length} viewer(s) [${scoped.map((u) => u.name).join(', ')}]` +
    (dropped.length ? ` (excluded ${dropped.join(', ')})` : ''),
  );
  return scoped;
}
