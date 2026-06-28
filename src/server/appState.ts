import fs from 'node:fs';
import path from 'node:path';

// Stage A/B: the persisted record for a group's gbx-owned player user. Holds the
// minted Jellyfin user id AND the member ids (the active viewers' Jellyfin user
// ids) to fan watched-state out to. IDs ONLY — passwords are never stored.
export interface GroupPlayerUser {
  jellyfinUserId: string;
  memberIds: string[];
}

// Writable runtime state — distinct from the read-only config.json. Stores a map
// of groupKey -> ignored item ids (shows and movies). Lives at a host-mounted
// location so it survives redeploys.
interface AppStateFile {
  ignoredItems?: Record<string, string[]>;
  // Legacy key (pre-rename). Read as a fallback; never written.
  ignoredShows?: Record<string, string[]>;
  // Stage A/B: map of groupKey -> the gbx-owned player user record. A Stage A
  // state file may have stored a bare string (the jellyfinUserId); normalizeGroupPlayerUsers
  // upgrades that shape on read so old files keep working.
  groupPlayerUsers?: Record<string, GroupPlayerUser | string>;
}

// Normalize the groupPlayerUsers map to the rich {jellyfinUserId, memberIds}
// shape, upgrading any legacy bare-string (Stage A) values (no member ids yet).
function normalizeGroupPlayerUsers(
  raw: Record<string, GroupPlayerUser | string> | undefined,
): Record<string, GroupPlayerUser> {
  const out: Record<string, GroupPlayerUser> = {};
  for (const [groupKey, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'string') {
      out[groupKey] = { jellyfinUserId: value, memberIds: [] };
    } else if (value && typeof value === 'object' && typeof value.jellyfinUserId === 'string') {
      out[groupKey] = {
        jellyfinUserId: value.jellyfinUserId,
        memberIds: Array.isArray(value.memberIds) ? value.memberIds : [],
      };
    }
  }
  return out;
}

const STATE_PATH = '/data/state.json';

function readState(filePath: string): AppStateFile {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as AppStateFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A corrupt state file should not take the server down; start fresh.
    return {};
  }
}

// Prefer the new key; fall back to the legacy `ignoredShows` key so a
// pre-rename state file keeps working with zero data loss until its first write.
function ignoredItemsFrom(state: AppStateFile): Record<string, string[]> {
  return state.ignoredItems ?? state.ignoredShows ?? {};
}

// Write-then-rename so a concurrent reader never observes a truncated file.
// Always normalizes to the new `ignoredItems` key (migrating the legacy
// `ignoredShows` key transparently) and preserves any other state fields
// (e.g. groupPlayerUsers) via the spread.
function writeState(filePath: string, state: AppStateFile, patch: Partial<AppStateFile>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const { ignoredShows: _legacy, ...rest } = state;
  const next: AppStateFile = { ignoredItems: ignoredItemsFrom(state), ...rest, ...patch };
  const tempPath = path.join(dir, `.state-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(next, null, 2));
  fs.renameSync(tempPath, filePath);
}

export class AppState {
  constructor(private readonly filePath: string = STATE_PATH) {}

  getIgnoredItems(groupKey: string): string[] {
    const state = readState(this.filePath);
    return ignoredItemsFrom(state)[groupKey] ?? [];
  }

  ignoreItem(groupKey: string, itemId: string): string[] {
    const state = readState(this.filePath);
    const ignoredItems = ignoredItemsFrom(state);
    const current = new Set(ignoredItems[groupKey] ?? []);
    current.add(itemId);
    ignoredItems[groupKey] = [...current];
    writeState(this.filePath, state, { ignoredItems });
    return ignoredItems[groupKey];
  }

  unignoreItem(groupKey: string, itemId: string): string[] {
    const state = readState(this.filePath);
    const ignoredItems = ignoredItemsFrom(state);
    const next = (ignoredItems[groupKey] ?? []).filter((id) => id !== itemId);
    if (next.length > 0) {
      ignoredItems[groupKey] = next;
    } else {
      delete ignoredItems[groupKey];
    }
    writeState(this.filePath, state, { ignoredItems });
    return next;
  }

  // The persisted gbx-owned Jellyfin user id for a group, or undefined if none
  // has been minted yet.
  getGroupPlayerUserId(groupKey: string): string | undefined {
    const state = readState(this.filePath);
    return normalizeGroupPlayerUsers(state.groupPlayerUsers)[groupKey]?.jellyfinUserId;
  }

  // Persist the group -> {jellyfinUserId, memberIds} mapping (IDs only, never
  // passwords). memberIds are the active viewers' Jellyfin user ids the Stage B
  // poller fans watched-state out to.
  setGroupPlayerUser(groupKey: string, jellyfinUserId: string, memberIds: string[]): void {
    const state = readState(this.filePath);
    const current = normalizeGroupPlayerUsers(state.groupPlayerUsers);
    const groupPlayerUsers: Record<string, GroupPlayerUser> = {
      ...current,
      [groupKey]: { jellyfinUserId, memberIds: [...new Set(memberIds)] },
    };
    writeState(this.filePath, state, { groupPlayerUsers });
  }

  // All persisted group player users, normalized. The Stage B poller uses this
  // to map a Jellyfin session's UserId (a group player user) -> member ids.
  getGroupPlayerUsers(): Record<string, GroupPlayerUser> {
    const state = readState(this.filePath);
    return normalizeGroupPlayerUsers(state.groupPlayerUsers);
  }
}
