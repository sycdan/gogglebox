import fs from 'node:fs';
import path from 'node:path';

// One ignored item/scope for a group. `key` is the exact id being matched
// (episode id, series id, or movie id, depending on scope). `matchSeriesId`
// is true only for whole-show scope: it additionally hides every OTHER episode
// of that series (matched via item.seriesId), not just the item at `key`
// itself. `label` is the display string captured at ignore-time (from the
// card that was ignored) so the client never needs a separate name lookup.
// `ignoredAt` is Date.now() ms, used to order the ignored panel most-recent-first.
export interface IgnoreEntry {
  key: string;
  matchSeriesId: boolean;
  label: string;
  ignoredAt: number;
}

// Stage A/B: the persisted record for a group's gbx-owned player user. Holds the
// minted Jellyfin user id AND the member ids (the active viewers' Jellyfin user
// ids) to fan watched-state out to. IDs ONLY — passwords are never stored.
export interface GroupPlayerUser {
  jellyfinUserId: string;
  memberIds: string[];
}

// The cached "effective config" derived from the read-only config.json: the
// migrated + merged + validated users/accounts plus provenance for cache
// invalidation. We re-derive (and overwrite this) when sourceHash changes (the
// user edited config.json) OR builtForPackage != the running package version (a
// new/rolled-back image whose migrations may differ).
export interface CachedEffectiveConfig {
  schemaVersion: number;
  builtForPackage: string;
  sourceHash: string;
  users: unknown[];
  accounts: unknown[];
  watchedThreshold: number;
  recommendationCount: number;
}

// Writable runtime state — distinct from the read-only config.json. Stores a map
// of groupKey -> ignored item entries (shows, single episodes, and movies).
// Lives at a host-mounted location so it survives redeploys.
interface AppStateFile {
  ignoredItems?: Record<string, IgnoreEntry[] | string[]>;
  // Legacy key (pre-rename, flat string[] shape). Read as a fallback; never written.
  ignoredShows?: Record<string, string[]>;
  // Stage A/B: map of groupKey -> the gbx-owned player user record. A Stage A
  // state file may have stored a bare string (the jellyfinUserId); normalizeGroupPlayerUsers
  // upgrades that shape on read so old files keep working.
  groupPlayerUsers?: Record<string, GroupPlayerUser | string>;
  // Human-readable alias per managed group (groupKey -> alias, e.g. "Alice + Bob").
  // IDs/keys only, no secrets. Shown wherever a group surfaces so the UI never
  // renders the raw gbx-grp-<hash> name. A group with no stored alias falls back
  // to a derived alias on read (see groups.ts), so this is best-effort.
  groupAliases?: Record<string, string>;
  // The cached effective config + provenance (see CachedEffectiveConfig). Re-
  // derived on startup when the source hash or package version changed.
  effectiveConfig?: CachedEffectiveConfig;
}

// Normalize the groupAliases map: drop non-string / empty entries so callers
// always get a clean groupKey -> alias record.
function normalizeGroupAliases(
  raw: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [groupKey, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'string' && value.trim()) {
      out[groupKey] = value;
    }
  }
  return out;
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

// One legacy flat id (from `ignoredItems: string[]` or the even-older
// `ignoredShows`) becomes a whole-series-scoped entry: `matchSeriesId: true`
// preserves old behavior exactly, because the OLD client `ignorableId` helper
// always stored a show's SERIES id (never an episode id), so every legacy
// show-ignore was already whole-series scope. `ignoredAt: 0` sorts legacy
// entries last (oldest) under "most recent first", since we don't know their
// real time.
function migrateLegacyEntry(id: string): IgnoreEntry {
  return { key: id, matchSeriesId: true, label: id, ignoredAt: 0 };
}

// Normalize one group's stored ignore list to the rich IgnoreEntry[] shape,
// migrating the legacy flat string[] shape losslessly.
function normalizeIgnoreEntries(raw: IgnoreEntry[] | string[] | undefined): IgnoreEntry[] {
  if (!raw) {
    return [];
  }
  return raw.map((entry) => (typeof entry === 'string' ? migrateLegacyEntry(entry) : entry));
}

// Prefer the new key; fall back to the legacy `ignoredShows` key so a
// pre-rename state file keeps working with zero data loss until its first write.
// Normalizes every group's entries to the rich IgnoreEntry[] shape.
function ignoredItemsFrom(state: AppStateFile): Record<string, IgnoreEntry[]> {
  const raw = state.ignoredItems ?? state.ignoredShows ?? {};
  const out: Record<string, IgnoreEntry[]> = {};
  for (const [groupKey, entries] of Object.entries(raw)) {
    out[groupKey] = normalizeIgnoreEntries(entries as IgnoreEntry[] | string[]);
  }
  return out;
}

// Most-recent-first: higher ignoredAt sorts first.
function sortMostRecentFirst(entries: IgnoreEntry[]): IgnoreEntry[] {
  return [...entries].sort((a, b) => b.ignoredAt - a.ignoredAt);
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

  // A group's ignore entries, most-recent-first (highest ignoredAt first;
  // migrated legacy entries carry ignoredAt: 0 and so sort last).
  getIgnoreEntries(groupKey: string): IgnoreEntry[] {
    const state = readState(this.filePath);
    return sortMostRecentFirst(ignoredItemsFrom(state)[groupKey] ?? []);
  }

  // Upsert an ignore entry: a repeat ignore of the same `key` bumps its
  // ignoredAt to now and refreshes label/matchSeriesId rather than duplicating.
  // Returns the group's remaining entries, most-recent-first.
  ignoreItem(
    groupKey: string,
    entry: { key: string; matchSeriesId: boolean; label: string },
  ): IgnoreEntry[] {
    const state = readState(this.filePath);
    const ignoredItems = ignoredItemsFrom(state);
    const current = (ignoredItems[groupKey] ?? []).filter((existing) => existing.key !== entry.key);
    current.push({ ...entry, ignoredAt: Date.now() });
    ignoredItems[groupKey] = current;
    writeState(this.filePath, state, { ignoredItems });
    return sortMostRecentFirst(ignoredItems[groupKey]);
  }

  // Remove an ignore entry by key, pruning the group when it becomes empty.
  // Returns the group's remaining entries, most-recent-first.
  unignoreItem(groupKey: string, key: string): IgnoreEntry[] {
    const state = readState(this.filePath);
    const ignoredItems = ignoredItemsFrom(state);
    const next = (ignoredItems[groupKey] ?? []).filter((entry) => entry.key !== key);
    if (next.length > 0) {
      ignoredItems[groupKey] = next;
    } else {
      delete ignoredItems[groupKey];
    }
    writeState(this.filePath, state, { ignoredItems });
    return sortMostRecentFirst(next);
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

  // The stored human-readable alias for a managed group, or undefined when none
  // has been persisted (callers derive a fallback from member names on read).
  getGroupAlias(groupKey: string): string | undefined {
    const state = readState(this.filePath);
    return normalizeGroupAliases(state.groupAliases)[groupKey];
  }

  // All persisted group aliases, normalized (groupKey -> alias). IDs/keys only.
  getGroupAliases(): Record<string, string> {
    const state = readState(this.filePath);
    return normalizeGroupAliases(state.groupAliases);
  }

  // Persist a human-readable alias for a managed group. No-op for an empty alias.
  setGroupAlias(groupKey: string, alias: string): void {
    const trimmed = alias.trim();
    if (!trimmed) {
      return;
    }
    const state = readState(this.filePath);
    const groupAliases: Record<string, string> = {
      ...normalizeGroupAliases(state.groupAliases),
      [groupKey]: trimmed,
    };
    writeState(this.filePath, state, { groupAliases });
  }

  // The cached effective config, or undefined when none has been derived yet.
  getEffectiveConfig(): CachedEffectiveConfig | undefined {
    const state = readState(this.filePath);
    return state.effectiveConfig;
  }

  // Whether the cached effective config can be reused: present AND derived from
  // the same source (sourceHash) by the same image (builtForPackage). A mismatch
  // (user edited config.json, or a new/rolled-back image) means re-derive.
  isEffectiveConfigFresh(sourceHash: string, packageVersion: string): boolean {
    const cached = this.getEffectiveConfig();
    return Boolean(
      cached &&
      cached.sourceHash === sourceHash &&
      cached.builtForPackage === packageVersion,
    );
  }

  // Persist the derived effective config + provenance (write-then-rename via
  // writeState; other state fields are preserved).
  setEffectiveConfig(effectiveConfig: CachedEffectiveConfig): void {
    const state = readState(this.filePath);
    writeState(this.filePath, state, { effectiveConfig });
  }
}
