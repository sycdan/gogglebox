import fs from 'node:fs';
import path from 'node:path';

// One ignored item/scope for a party (formerly "group"). `key` is the exact id
// being matched (episode id, series id, or movie id, depending on scope).
// `matchSeriesId` is true only for whole-show scope: it additionally hides
// every OTHER episode of that series (matched via item.seriesId), not just the
// item at `key` itself. `label` is the display string captured at ignore-time
// (from the card that was ignored) so the client never needs a separate name
// lookup. `ignoredAt` is Date.now() ms, used to order the ignored panel
// most-recent-first.
export interface IgnoreEntry {
  key: string;
  matchSeriesId: boolean;
  label: string;
  ignoredAt: number;
}

// Stage A/B: the persisted record for a party's gbx-owned player user. Holds
// the minted Jellyfin user id AND the member ids (the active viewers' Jellyfin
// user ids) to fan watched-state out to. IDs ONLY — passwords are never stored.
export interface PartyPlayerUser {
  jellyfinUserId: string;
  memberIds: string[];
}

// Pre-rename alias kept for any external/compiled consumer still importing the
// old type name. Structurally identical — never diverge these.
export type GroupPlayerUser = PartyPlayerUser;

// The cached "effective config" derived from the read-only config.json: the
// migrated + merged + validated users/accounts/accessTokens plus provenance for
// cache invalidation. We re-derive (and overwrite this) when sourceHash changes
// (the user edited config.json), builtForPackage != the running package version
// (a new/rolled-back image whose migrations may differ), OR schemaVersion !=
// the image's current schema (a cached v1 shape must never be consumed by a v2
// runtime).
export interface CachedEffectiveConfig {
  schemaVersion: number;
  builtForPackage: string;
  sourceHash: string;
  users: unknown[];
  accounts: Record<string, unknown>;
  accessTokens: Record<string, string>;
  watchedThreshold: number;
  recommendationCount: number;
}

// Writable runtime state — distinct from the read-only config.json. Stores a
// map of partyKey -> ignored item entries (shows, single episodes, and
// movies). Lives at a host-mounted location so it survives redeploys.
interface AppStateFile {
  ignoredItems?: Record<string, IgnoreEntry[] | string[]>;
  // Legacy key (pre-rename, flat string[] shape). Read as a fallback; never written.
  ignoredShows?: Record<string, string[]>;
  // Stage A/B: map of partyKey -> the gbx-owned player user record. A Stage A
  // state file may have stored a bare string (the jellyfinUserId); normalizePartyPlayerUsers
  // upgrades that shape on read so old files keep working.
  partyPlayerUsers?: Record<string, PartyPlayerUser | string>;
  // Pre-rename key (formerly "groupPlayerUsers"). Read as a fallback for any
  // state file written before this rename; never written again.
  groupPlayerUsers?: Record<string, PartyPlayerUser | string>;
  // Human-readable alias per managed party (partyKey -> alias, e.g. "Alice + Bob").
  // IDs/keys only, no secrets. Shown wherever a party surfaces so the UI never
  // renders the raw gbx-grp-<hash> name. A party with no stored alias falls back
  // to a derived alias on read (see parties.ts), so this is best-effort.
  partyAliases?: Record<string, string>;
  // Pre-rename key (formerly "groupAliases"). Read as a fallback for any state
  // file written before this rename; never written again.
  groupAliases?: Record<string, string>;
  // The cached effective config + provenance (see CachedEffectiveConfig). Re-
  // derived on startup when the source hash or package version changed.
  effectiveConfig?: CachedEffectiveConfig;
}

// Normalize the partyAliases map: drop non-string / empty entries so callers
// always get a clean partyKey -> alias record.
function normalizePartyAliases(
  raw: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [partyKey, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'string' && value.trim()) {
      out[partyKey] = value;
    }
  }
  return out;
}

// Normalize the partyPlayerUsers map to the rich {jellyfinUserId, memberIds}
// shape, upgrading any legacy bare-string (Stage A) values (no member ids yet).
function normalizePartyPlayerUsers(
  raw: Record<string, PartyPlayerUser | string> | undefined,
): Record<string, PartyPlayerUser> {
  const out: Record<string, PartyPlayerUser> = {};
  for (const [partyKey, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'string') {
      out[partyKey] = { jellyfinUserId: value, memberIds: [] };
    } else if (value && typeof value === 'object' && typeof value.jellyfinUserId === 'string') {
      out[partyKey] = {
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

// Normalize one party's stored ignore list to the rich IgnoreEntry[] shape,
// migrating the legacy flat string[] shape losslessly.
function normalizeIgnoreEntries(raw: IgnoreEntry[] | string[] | undefined): IgnoreEntry[] {
  if (!raw) {
    return [];
  }
  return raw.map((entry) => (typeof entry === 'string' ? migrateLegacyEntry(entry) : entry));
}

// Prefer the new key; fall back to the legacy `ignoredShows` key so a
// pre-rename state file keeps working with zero data loss until its first write.
// Normalizes every party's entries to the rich IgnoreEntry[] shape.
function ignoredItemsFrom(state: AppStateFile): Record<string, IgnoreEntry[]> {
  const raw = state.ignoredItems ?? state.ignoredShows ?? {};
  const out: Record<string, IgnoreEntry[]> = {};
  for (const [partyKey, entries] of Object.entries(raw)) {
    out[partyKey] = normalizeIgnoreEntries(entries as IgnoreEntry[] | string[]);
  }
  return out;
}

// Prefer the new `partyPlayerUsers` key; fall back to the pre-rename
// `groupPlayerUsers` key so a state file written before this rename keeps
// working with zero data loss until its first write under the new key.
function partyPlayerUsersFrom(state: AppStateFile): Record<string, PartyPlayerUser> {
  return normalizePartyPlayerUsers(state.partyPlayerUsers ?? state.groupPlayerUsers);
}

// Prefer the new `partyAliases` key; fall back to the pre-rename `groupAliases`
// key so a state file written before this rename keeps working with zero data
// loss until its first write under the new key.
function partyAliasesFrom(state: AppStateFile): Record<string, string> {
  return normalizePartyAliases(state.partyAliases ?? state.groupAliases);
}

// Most-recent-first: higher ignoredAt sorts first.
function sortMostRecentFirst(entries: IgnoreEntry[]): IgnoreEntry[] {
  return [...entries].sort((a, b) => b.ignoredAt - a.ignoredAt);
}

// Write-then-rename so a concurrent reader never observes a truncated file.
// Always normalizes to the new `ignoredItems`/`partyPlayerUsers`/`partyAliases`
// keys (migrating the legacy `ignoredShows`/`groupPlayerUsers`/`groupAliases`
// keys transparently on first write) and preserves any other state fields via
// the spread.
function writeState(filePath: string, state: AppStateFile, patch: Partial<AppStateFile>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const { ignoredShows: _legacyIgnored, groupPlayerUsers: _legacyPlayers, groupAliases: _legacyAliases, ...rest } = state;
  const next: AppStateFile = {
    ignoredItems: ignoredItemsFrom(state),
    partyPlayerUsers: partyPlayerUsersFrom(state),
    partyAliases: partyAliasesFrom(state),
    ...rest,
    ...patch,
  };
  const tempPath = path.join(dir, `.state-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(next, null, 2));
  fs.renameSync(tempPath, filePath);
}

export class AppState {
  constructor(private readonly filePath: string = STATE_PATH) {}

  // A party's ignore entries, most-recent-first (highest ignoredAt first;
  // migrated legacy entries carry ignoredAt: 0 and so sort last).
  getIgnoreEntries(partyKey: string): IgnoreEntry[] {
    const state = readState(this.filePath);
    return sortMostRecentFirst(ignoredItemsFrom(state)[partyKey] ?? []);
  }

  // Upsert an ignore entry: a repeat ignore of the same `key` bumps its
  // ignoredAt to now and refreshes label/matchSeriesId rather than duplicating.
  // Returns the party's remaining entries, most-recent-first.
  ignoreItem(
    partyKey: string,
    entry: { key: string; matchSeriesId: boolean; label: string },
  ): IgnoreEntry[] {
    const state = readState(this.filePath);
    const ignoredItems = ignoredItemsFrom(state);
    const current = (ignoredItems[partyKey] ?? []).filter((existing) => existing.key !== entry.key);
    current.push({ ...entry, ignoredAt: Date.now() });
    ignoredItems[partyKey] = current;
    writeState(this.filePath, state, { ignoredItems });
    return sortMostRecentFirst(ignoredItems[partyKey]);
  }

  // Remove an ignore entry by key, pruning the party when it becomes empty.
  // Returns the party's remaining entries, most-recent-first.
  unignoreItem(partyKey: string, key: string): IgnoreEntry[] {
    const state = readState(this.filePath);
    const ignoredItems = ignoredItemsFrom(state);
    const next = (ignoredItems[partyKey] ?? []).filter((entry) => entry.key !== key);
    if (next.length > 0) {
      ignoredItems[partyKey] = next;
    } else {
      delete ignoredItems[partyKey];
    }
    writeState(this.filePath, state, { ignoredItems });
    return sortMostRecentFirst(next);
  }

  // The persisted gbx-owned Jellyfin user id for a party, or undefined if none
  // has been minted yet.
  getPartyPlayerUserId(partyKey: string): string | undefined {
    const state = readState(this.filePath);
    return partyPlayerUsersFrom(state)[partyKey]?.jellyfinUserId;
  }

  // Persist the party -> {jellyfinUserId, memberIds} mapping (IDs only, never
  // passwords). memberIds are the active viewers' Jellyfin user ids the Stage B
  // poller fans watched-state out to.
  setPartyPlayerUser(partyKey: string, jellyfinUserId: string, memberIds: string[]): void {
    const state = readState(this.filePath);
    const current = partyPlayerUsersFrom(state);
    const partyPlayerUsers: Record<string, PartyPlayerUser> = {
      ...current,
      [partyKey]: { jellyfinUserId, memberIds: [...new Set(memberIds)] },
    };
    writeState(this.filePath, state, { partyPlayerUsers });
  }

  // All persisted party player users, normalized. The Stage B poller uses this
  // to map a Jellyfin session's UserId (a party player user) -> member ids.
  getPartyPlayerUsers(): Record<string, PartyPlayerUser> {
    const state = readState(this.filePath);
    return partyPlayerUsersFrom(state);
  }

  // The stored human-readable alias for a managed party, or undefined when none
  // has been persisted (callers derive a fallback from member names on read).
  getPartyAlias(partyKey: string): string | undefined {
    const state = readState(this.filePath);
    return partyAliasesFrom(state)[partyKey];
  }

  // All persisted party aliases, normalized (partyKey -> alias). IDs/keys only.
  getPartyAliases(): Record<string, string> {
    const state = readState(this.filePath);
    return partyAliasesFrom(state);
  }

  // Persist a human-readable alias for a managed party. No-op for an empty alias.
  setPartyAlias(partyKey: string, alias: string): void {
    const trimmed = alias.trim();
    if (!trimmed) {
      return;
    }
    const state = readState(this.filePath);
    const partyAliases: Record<string, string> = {
      ...partyAliasesFrom(state),
      [partyKey]: trimmed,
    };
    writeState(this.filePath, state, { partyAliases });
  }

  // The cached effective config, or undefined when none has been derived yet.
  getEffectiveConfig(): CachedEffectiveConfig | undefined {
    const state = readState(this.filePath);
    return state.effectiveConfig;
  }

  // Whether the cached effective config can be reused: present AND derived from
  // the same source (sourceHash) by the same image (builtForPackage) INTO the
  // schema shape this image consumes (schemaVersion). A mismatch (user edited
  // config.json, a new/rolled-back image, or a cached older-schema shape)
  // means re-derive.
  isEffectiveConfigFresh(sourceHash: string, packageVersion: string, schemaVersion: number): boolean {
    const cached = this.getEffectiveConfig();
    return Boolean(
      cached &&
      cached.sourceHash === sourceHash &&
      cached.builtForPackage === packageVersion &&
      cached.schemaVersion === schemaVersion,
    );
  }

  // Persist the derived effective config + provenance (write-then-rename via
  // writeState; other state fields are preserved).
  setEffectiveConfig(effectiveConfig: CachedEffectiveConfig): void {
    const state = readState(this.filePath);
    writeState(this.filePath, state, { effectiveConfig });
  }
}
