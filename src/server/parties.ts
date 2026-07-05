// Managed-party pure logic: visibility filtering, alias generation, and the
// reuse-vs-create decision. Jellyfin-free so it can be unit tested without
// booting the server. A "managed party" is a persisted gbx-owned player user
// (appState.getPartyPlayerUsers()) keyed by the deterministic, order-independent
// derivePartyKey of its member Jellyfin user ids. Parties were formerly called
// "groups" — the persisted state, derived keys, and Jellyfin username format
// are unchanged by this rename (see appState.ts / jellyfin.ts for the
// compatibility read paths).

import { derivePartyKey } from './partyKey';
import { PartyPlayerUser } from './appState';
import { VisibleViewer } from './accounts';

// A managed party as exposed to the client: identified by its partyKey, with a
// human-readable alias (NEVER the raw gbx-grp-<hash> name) plus the member ids
// and their display names in the account's visible-user order.
export interface VisibleParty {
  partyKey: string;
  alias: string;
  memberIds: string[];
  memberNames: string[];
}

// Build a default alias from member display names joined with " + ", ordered to
// match the account's visible-user order (e.g. "Alice + Bob"). Members not
// resolvable in the visible list fall to the end (defensive; normally unreachable).
export function buildPartyAlias(memberIds: string[], visible: VisibleViewer[]): string {
  const orderedNames: string[] = [];
  const memberSet = new Set(memberIds);
  for (const viewer of visible) {
    if (memberSet.has(viewer.id)) {
      orderedNames.push(viewer.name);
    }
  }
  return orderedNames.join(' + ');
}

// Whether every member id of a managed party is within the account's visible
// users. A party is shown to an account iff ALL its members are visible to it.
export function isPartyVisibleToAccount(memberIds: string[], visible: VisibleViewer[]): boolean {
  if (memberIds.length === 0) {
    return false;
  }
  const visibleIds = new Set(visible.map((viewer) => viewer.id));
  return memberIds.every((id) => visibleIds.has(id));
}

// Resolve the managed parties VISIBLE to an account (all members ⊆ visible) into
// client-facing shapes. The alias is taken from the stored aliases map, falling
// back to a derived alias when none is stored (backfill so the UI never shows a
// raw gbx-grp-<hash> name). memberIds/memberNames are ordered to match the
// account's visible-user order.
export function visiblePartiesForAccount(
  players: Record<string, PartyPlayerUser>,
  visible: VisibleViewer[],
  aliases: Record<string, string>,
): VisibleParty[] {
  const out: VisibleParty[] = [];
  for (const [partyKey, player] of Object.entries(players)) {
    if (!isPartyVisibleToAccount(player.memberIds, visible)) {
      continue;
    }
    // Order member ids/names by the account's visible-user order.
    const orderedIds: string[] = [];
    const orderedNames: string[] = [];
    const memberSet = new Set(player.memberIds);
    for (const viewer of visible) {
      if (memberSet.has(viewer.id)) {
        orderedIds.push(viewer.id);
        orderedNames.push(viewer.name);
      }
    }
    const alias = aliases[partyKey]?.trim() || buildPartyAlias(player.memberIds, visible);
    out.push({ partyKey, alias, memberIds: orderedIds, memberNames: orderedNames });
  }
  return out;
}

// The reuse-vs-create decision for a selected member combination. Derives the
// deterministic key and reports whether a managed party with that key already
// exists. Same set of people -> same key -> reuse (never a duplicate); a brand
// new combination -> create.
export function resolvePartyForMembers(
  memberJellyfinUserIds: string[],
  players: Record<string, PartyPlayerUser>,
): { partyKey: string; exists: boolean } {
  const partyKey = derivePartyKey(memberJellyfinUserIds);
  return { partyKey, exists: Object.prototype.hasOwnProperty.call(players, partyKey) };
}
