// Config v2 pure logic: access-token authentication, tier resolution
// (wildcards + precedence + pin-filter), visible-viewer projection, and group
// pin verification. These are Jellyfin-free so they can be unit tested without
// booting the server.

import { AccountV2, ConfigUser, FamilyMember } from './types';

export type ViewerTier = 'primary' | 'secondary' | 'tertiary';

// A visible user as exposed to the client for the logged-in account: the
// resolved Jellyfin viewer plus this account's tier for them. Never carries the
// pin itself. pinRequired is a client convenience — in v2 it is exactly
// tier === 'tertiary' (guests are the only pin-gated tier).
export interface VisibleViewer extends FamilyMember {
  tier: ViewerTier;
  pinRequired: boolean;
}

// The tier lists of an account resolved against the live Jellyfin user list:
// explicit lists keep config order; wildcard-resolved names keep Jellyfin list
// order. Names only — callers project to viewers via viewersByName.
export interface ResolvedTiers {
  primary: string[];
  secondary: string[];
  tertiary: string[];
}

// Find the account for an access token, or null. Exact string match only —
// no trimming/casing, and an empty token never matches (defense against an
// empty-string access_tokens key).
export function accountForToken(
  accessTokens: Record<string, string>,
  accounts: Record<string, AccountV2>,
  token: string | undefined,
): { accountKey: string; account: AccountV2 } | null {
  if (!token) {
    return null;
  }

  const accountKey = accessTokens[token];
  if (!accountKey) {
    return null;
  }

  const account = accounts[accountKey];
  return account ? { accountKey, account } : null;
}

// Resolve an account's tier lists against the live Jellyfin user universe.
// Rules (see AccountV2 in types.ts):
//   - primary: explicit list only; omitted/null => [].
//   - secondary: omitted/null => WILDCARD (all live users minus primaries minus
//     EXPLICIT tertiaries); explicit list keeps config order.
//   - tertiary: omitted/null => WILDCARD (leftover after primaries+secondaries);
//     explicit list keeps config order. Either way, a candidate with NO
//     configured pin in users[] is EXCLUDED — the guest flow could never verify
//     them (startup validation warns about explicitly-listed pin-less guests).
//   - Precedence primary > secondary > tertiary: a name already claimed by a
//     higher tier is dropped from lower explicit lists (validation warns).
// Unknown names in explicit lists are skipped (validation already warned).
export function resolveAccountTiers(
  account: AccountV2,
  allJellyfinNames: string[],
  users: ConfigUser[],
): ResolvedTiers {
  const known = new Set(allJellyfinNames);
  const pinByName = new Map(users.map((user) => [user.jellyfin_name, user.pin]));

  const primary = (account.primary_users ?? []).filter((name) => known.has(name));
  const primarySet = new Set(primary);

  // The secondary WILDCARD subtracts only EXPLICIT tertiaries (a wildcard
  // tertiary tier is by definition the leftover after secondaries resolve, so
  // it can never subtract from them).
  const explicitTertiary = new Set(account.tertiary_users ?? []);
  let secondary: string[];
  if (account.secondary_users === undefined || account.secondary_users === null) {
    secondary = allJellyfinNames.filter(
      (name) => !primarySet.has(name) && !explicitTertiary.has(name),
    );
  } else {
    secondary = account.secondary_users.filter(
      (name) => known.has(name) && !primarySet.has(name),
    );
  }
  const secondarySet = new Set(secondary);

  let tertiary: string[];
  if (account.tertiary_users === undefined || account.tertiary_users === null) {
    tertiary = allJellyfinNames.filter(
      (name) => !primarySet.has(name) && !secondarySet.has(name),
    );
  } else {
    tertiary = account.tertiary_users.filter(
      (name) => known.has(name) && !primarySet.has(name) && !secondarySet.has(name),
    );
  }
  // Pin-filter: a guest with no configured pin can never be added.
  tertiary = tertiary.filter((name) => Boolean(pinByName.get(name)));

  return { primary, secondary, tertiary };
}

// Resolve an account's visible users to client-facing viewers (resolved
// Jellyfin id/avatar + this account's tier). Order: primaries, then
// secondaries, then tertiaries (the guest candidates). viewersByName holds ALL
// live Jellyfin users in Jellyfin list order (see resolveViewers), so its keys
// are the wildcard universe.
export function visibleViewersForAccount(
  account: AccountV2,
  viewersByName: Record<string, FamilyMember>,
  users: ConfigUser[],
): VisibleViewer[] {
  const tiers = resolveAccountTiers(account, Object.keys(viewersByName), users);

  const out: VisibleViewer[] = [];
  const push = (names: string[], tier: ViewerTier) => {
    for (const name of names) {
      const viewer = viewersByName[name];
      if (!viewer) {
        // Defensive: the tier resolved against viewersByName keys, so a miss
        // is unreachable.
        continue;
      }
      out.push({ ...viewer, tier, pinRequired: tier === 'tertiary' });
    }
  };

  push(tiers.primary, 'primary');
  push(tiers.secondary, 'secondary');
  push(tiers.tertiary, 'tertiary');
  return out;
}

// Verify that every selected member that resolves to the TERTIARY tier for this
// account has the correct pin supplied (a pin is required iff the member is a
// guest for this account). Returns { ok: true } when all required pins match,
// otherwise { ok: false, error } describing the first failure. Pins are a map
// of jellyfinUserId -> supplied pin, verified against the users[] pin registry.
export function verifyGroupPins(
  account: AccountV2,
  users: ConfigUser[],
  allJellyfinNames: string[],
  selectedViewers: FamilyMember[],
  suppliedPins: Record<string, string>,
): { ok: true } | { ok: false; error: string } {
  const tiers = resolveAccountTiers(account, allJellyfinNames, users);
  const tertiary = new Set(tiers.tertiary);
  const usersByName = new Map(users.map((user) => [user.jellyfin_name, user]));

  for (const viewer of selectedViewers) {
    if (!tertiary.has(viewer.name)) {
      continue;
    }

    const configured = usersByName.get(viewer.name)?.pin;
    if (!configured) {
      // Should be unreachable (pin-less guests are excluded from the tier),
      // but guard anyway.
      return { ok: false, error: `No pin is configured for ${viewer.name}.` };
    }

    const supplied = suppliedPins[viewer.jellyfinUserId];
    if (!supplied || supplied !== configured) {
      return { ok: false, error: `Incorrect or missing pin for ${viewer.name}.` };
    }
  }

  return { ok: true };
}

// Validate that a set of selected member ids is well-formed and visible to the
// account, then verify any required pins (required iff the member resolves to
// the tertiary/guest tier for this account). Returns the resolved member
// viewers on success, or a { status, error } the caller should send (400 for
// member problems, 403 for a pin verdict). Pure — config is passed in — so the
// verdict shared by /api/group, /api/group/verify-pins and /api/player/session
// is unit-testable without booting the server. Verifies only; it never
// activates or persists anything.
export function resolveGroupMemberSelection(
  account: AccountV2,
  viewersByName: Record<string, FamilyMember>,
  users: ConfigUser[],
  memberIds: string[],
  pins: Record<string, string>,
): { ok: true; members: FamilyMember[] } | { ok: false; status: number; error: string } {
  if (!memberIds.length) {
    return { ok: false, status: 400, error: 'Choose at least one viewer' };
  }

  // Members must be among THIS account's visible viewers (any tier).
  const visible = visibleViewersForAccount(account, viewersByName, users);
  const visibleById = new Map(visible.map((viewer) => [viewer.id, viewer]));
  const members: FamilyMember[] = [];
  for (const memberId of memberIds) {
    const viewer = visibleById.get(memberId);
    if (!viewer) {
      return { ok: false, status: 400, error: `Unknown or not-visible viewer: ${memberId}` };
    }
    members.push(viewer);
  }

  const pinCheck = verifyGroupPins(account, users, Object.keys(viewersByName), members, pins);
  if (!pinCheck.ok) {
    // Never clear pin-gating with a wrong/missing required pin.
    return { ok: false, status: 403, error: pinCheck.error };
  }

  return { ok: true, members };
}
