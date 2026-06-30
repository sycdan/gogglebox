// Versioned config-migration engine. The mounted config.json is a READ-ONLY
// source of overrides. On startup we detect its integer `schemaVersion` (missing
// => 0, the legacy wild config), migrate it FORWARD through an ordered registry
// of pure functions to the shape this image expects, seed defaults from the
// bundled example, overlay the migrated overrides, and validate with skip+warn
// (rather than fail-fast) so a stale reference never takes the server down.
//
// All functions here are pure-ish (no Jellyfin IO): the only external input is a
// MigrationContext carrying the Jellyfin user list so migrate0to1 can resolve
// legacy UUIDs back to Jellyfin user names. Keep it that way so the engine is
// unit-testable without booting the server.

import crypto from 'node:crypto';

import { ConfigAccount, ConfigUser, VisibleUser } from './types';

// The highest schemaVersion this image understands. The migration chain stops
// here; a source declaring a higher version can't be migrated DOWN, so we fail
// fast (the user must run a newer image).
export const CURRENT_SCHEMA_VERSION = 1;

// The current (schemaVersion 1) config-file shape: users/accounts + playback/
// recommendations. This is the shape the running app consumes.
export interface SchemaV1Config {
  schemaVersion: 1;
  playback?: { watchedThreshold?: number };
  recommendations?: { count?: number };
  users: ConfigUser[];
  accounts: ConfigAccount[];
}

// Context a migration may need. ctx.jellyfinUsers lets migrate0to1 map legacy
// member UUIDs back to Jellyfin user NAMES (config v1+ is name-keyed).
export interface MigrationContext {
  jellyfinUsers: { id: string; name: string }[];
  // Portal creds from PORTAL_USERNAME/PORTAL_PASSWORD, used to synthesize a
  // login account when the legacy config has no household creds of its own.
  portalUsername?: string;
  portalPassword?: string;
  // Sink for human-readable migration warnings (defaults to console.warn).
  warn?: (message: string) => void;
}

function warnWith(ctx: MigrationContext, message: string): void {
  (ctx.warn ?? ((msg: string) => console.warn(`[config-migration] ${msg}`)))(message);
}

// A migration upgrades a config FROM `from` to `from + 1`. Keyed by `from` in
// the registry so the runner can walk the chain.
export interface Migration {
  from: number;
  migrate: (config: Record<string, unknown>, ctx: MigrationContext) => Record<string, unknown>;
}

// ── Legacy (schemaVersion 0) shapes ────────────────────────────────────────
// The pre-users/accounts config: a single household + groups[] whose memberIds
// are Jellyfin UUIDs. PORTAL_AUTO_LOGIN lived in .env (not the file) and is
// obsolete; we warn about it from server startup, not here.
interface LegacyGroup {
  id?: string;
  name?: string;
  memberIds?: unknown;
}

interface LegacyConfig {
  household?: { username?: string; password?: string };
  groups?: LegacyGroup[];
  playback?: { watchedThreshold?: number };
  recommendations?: { count?: number };
}

// ── Migration 0 -> 1: legacy household/groups (UUIDs) -> users/accounts ─────
// Pure (ctx supplies the Jellyfin user list). Maps each legacy group memberId
// UUID to its Jellyfin user NAME, unions them into users[] (no pins existed),
// synthesizes a single account from the household/portal creds, carries over
// playback/recommendations, and drops the obsolete groups[] presets.
export function migrate0to1(
  rawConfig: Record<string, unknown>,
  ctx: MigrationContext,
): SchemaV1Config {
  const legacy = rawConfig as LegacyConfig;
  const nameById = new Map(ctx.jellyfinUsers.map((user) => [user.id, user.name]));

  // Union of resolved user names across all legacy groups, in first-seen order.
  const resolvedNames: string[] = [];
  const seen = new Set<string>();
  for (const group of legacy.groups ?? []) {
    const memberIds = Array.isArray(group.memberIds) ? group.memberIds : [];
    for (const memberId of memberIds) {
      if (typeof memberId !== 'string') {
        continue;
      }
      const name = nameById.get(memberId);
      if (!name) {
        warnWith(ctx, `skipped legacy member id "${memberId}" (no matching Jellyfin user).`);
        continue;
      }
      if (!seen.has(name)) {
        seen.add(name);
        resolvedNames.push(name);
      }
    }
  }

  const users: ConfigUser[] = resolvedNames.map((name) => ({ jellyfin_name: name }));

  // Visible to the synthesized account: all resolved users, none pin_required
  // (no pins existed in the legacy model).
  const visibleUsers: VisibleUser[] = resolvedNames.map((name) => ({ jellyfin_name: name }));

  // Account creds: prefer the legacy household, else PORTAL_* env, else a
  // sensible default (warn).
  const householdUser = legacy.household?.username?.trim();
  const householdPass = legacy.household?.password;
  let username: string;
  let password: string;
  if (householdUser && householdPass) {
    username = householdUser;
    password = householdPass;
  } else if (ctx.portalUsername && ctx.portalPassword) {
    username = ctx.portalUsername;
    password = ctx.portalPassword;
  } else {
    username = 'household';
    password = 'change-me';
    warnWith(
      ctx,
      'no legacy household creds and no PORTAL_USERNAME/PORTAL_PASSWORD; ' +
      'synthesized a default account "household"/"change-me" — set a real password.',
    );
  }

  const accounts: ConfigAccount[] = [{ username, password, visible_users: visibleUsers }];

  if ((legacy.groups?.length ?? 0) > 0) {
    warnWith(ctx, 'dropped obsolete legacy groups[] presets (groups are now formed live in the UI).');
  }

  return {
    schemaVersion: 1,
    playback: legacy.playback ? { watchedThreshold: legacy.playback.watchedThreshold } : undefined,
    recommendations: legacy.recommendations ? { count: legacy.recommendations.count } : undefined,
    users,
    accounts,
  };
}

// The ordered migration registry, keyed by the version each entry upgrades FROM.
export const MIGRATIONS: Migration[] = [
  { from: 0, migrate: (config, ctx) => migrate0to1(config, ctx) as unknown as Record<string, unknown> },
];

// The declared schemaVersion of a raw config object. Missing/invalid => 0 (the
// legacy wild config).
export function detectSchemaVersion(rawConfig: Record<string, unknown>): number {
  const value = rawConfig.schemaVersion;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

// Walk the migration chain from the source's schemaVersion up to the highest
// version reachable (the image's CURRENT_SCHEMA_VERSION). Throws ONLY when the
// source declares a version GREATER than this image can produce (can't migrate
// down — the user must run a newer image).
export function runMigrationChain(
  rawConfig: Record<string, unknown>,
  ctx: MigrationContext,
): SchemaV1Config {
  const sourceVersion = detectSchemaVersion(rawConfig);
  if (sourceVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `config schemaVersion ${sourceVersion} is newer than this image supports ` +
      `(max ${CURRENT_SCHEMA_VERSION}). Config is auto-migrated forward only — ` +
      'run a newer Gogglebox image to use this config.',
    );
  }

  const byFrom = new Map(MIGRATIONS.map((migration) => [migration.from, migration]));
  let current = rawConfig;
  let version = sourceVersion;
  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = byFrom.get(version);
    if (!migration) {
      // No migration for the next step — stop at this ceiling.
      break;
    }
    current = migration.migrate(current, ctx);
    version += 1;
  }

  if (sourceVersion !== CURRENT_SCHEMA_VERSION || version !== CURRENT_SCHEMA_VERSION) {
    if (sourceVersion < CURRENT_SCHEMA_VERSION) {
      warnWith(
        ctx,
        `config schemaVersion ${sourceVersion} detected; auto-migrated to ${version}; ` +
        'review the derived accounts/pins.',
      );
    }
  }

  return { ...(current as unknown as SchemaV1Config), schemaVersion: CURRENT_SCHEMA_VERSION as 1 };
}

// A stable hash of the raw config source, used as a cache-invalidation key for
// the derived effective config in /data.
export function hashRawConfig(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Deep-merge migrated user overrides on top of the bundled example defaults.
// Arrays are REPLACED wholesale (users[]/accounts[] are user-owned lists, not
// element-wise patches); plain objects merge key-by-key; scalars overwrite.
export function deepMergeConfig<T extends object>(base: T, override: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override) as [string, unknown][]) {
    if (value === undefined) {
      continue;
    }
    const existing = out[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMergeConfig(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}
