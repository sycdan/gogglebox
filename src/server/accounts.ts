// Config v2 pure logic: account authentication, visible-user resolution, and
// pin-required determination. These are Jellyfin-free so they can be unit
// tested without booting the server.

import { ConfigAccount, ConfigUser, FamilyMember, VisibleUser } from './types';

// A visible user as exposed to the client for the logged-in account: the
// resolved Jellyfin viewer plus this account's pin_required flag. Never carries
// the pin itself.
export interface VisibleViewer extends FamilyMember {
  pinRequired: boolean;
}

// Find the account matching the given credentials, or null. Plain-text compare
// (config holds plain-text passwords, same as the v1 household model).
export function authenticateAccount(
  accounts: ConfigAccount[],
  username: string | undefined,
  password: string | undefined,
): ConfigAccount | null {
  if (!username || !password) {
    return null;
  }

  return accounts.find((account) => account.username === username && account.password === password) ?? null;
}

// Whether adding the given user (by Jellyfin name) to a group requires a pin
// from this account. True only when the account marks the user pin_required.
export function isPinRequiredForAccount(account: ConfigAccount, jellyfinName: string): boolean {
  return account.visible_users.some(
    (visible) => visible.jellyfin_name === jellyfinName && visible.pin_required === true,
  );
}

// The visible_users entry for a name within an account, or undefined when the
// account cannot see that user.
export function visibleEntryFor(account: ConfigAccount, jellyfinName: string): VisibleUser | undefined {
  return account.visible_users.find((visible) => visible.jellyfin_name === jellyfinName);
}

// Resolve an account's visible users to client-facing viewers (resolved
// Jellyfin id/avatar + this account's pin_required flag). A visible name with no
// resolved viewer is skipped (validation makes this unreachable at startup).
export function visibleViewersForAccount(
  account: ConfigAccount,
  viewersByName: Record<string, FamilyMember>,
): VisibleViewer[] {
  const out: VisibleViewer[] = [];
  for (const visible of account.visible_users) {
    const viewer = viewersByName[visible.jellyfin_name];
    if (!viewer) {
      continue;
    }
    out.push({ ...viewer, pinRequired: visible.pin_required === true });
  }
  return out;
}

// Verify that every selected member that this account marks pin_required has the
// correct pin supplied. Returns { ok: true } when all required pins match,
// otherwise { ok: false, error } describing the first failure. Selected member
// ids are Jellyfin user ids; pins is a map of jellyfinUserId -> supplied pin.
export function verifyGroupPins(
  account: ConfigAccount,
  users: ConfigUser[],
  selectedViewers: FamilyMember[],
  suppliedPins: Record<string, string>,
): { ok: true } | { ok: false; error: string } {
  const usersByName = new Map(users.map((user) => [user.jellyfin_name, user]));

  for (const viewer of selectedViewers) {
    if (!isPinRequiredForAccount(account, viewer.name)) {
      continue;
    }

    const configured = usersByName.get(viewer.name)?.pin;
    if (!configured) {
      // Should be unreachable after startup validation, but guard anyway.
      return { ok: false, error: `No pin is configured for ${viewer.name}.` };
    }

    const supplied = suppliedPins[viewer.jellyfinUserId];
    if (!supplied || supplied !== configured) {
      return { ok: false, error: `Incorrect or missing pin for ${viewer.name}.` };
    }
  }

  return { ok: true };
}
