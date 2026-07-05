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

import { AccountV2, ConfigUser } from './types';

// The highest schemaVersion this image understands. The migration chain stops
// here; a source declaring a higher version can't be migrated DOWN, so we fail
// fast (the user must run a newer image).
export const CURRENT_SCHEMA_VERSION = 2;

// ── Historical (schemaVersion 1) shapes ─────────────────────────────────────
// Kept here (not types.ts) because only the migration chain consumes them: the
// running app is v2-shaped. v1 authenticated with username/password and gated
// pins per visible user via pin_required.
export interface VisibleUserV1 {
  jellyfin_name: string;
  pin_required?: boolean;
}

export interface ConfigAccountV1 {
  username: string;
  password: string;
  visible_users: VisibleUserV1[];
}

// The schemaVersion-1 config-file shape: users + credentialed accounts[].
export interface SchemaV1Config {
  schemaVersion: 1;
  playback?: { watchedThreshold?: number };
  recommendations?: { count?: number };
  users: ConfigUser[];
  accounts: ConfigAccountV1[];
}

// The current (schemaVersion 2) config-file shape: token-only login + tiered
// accounts. This is the shape the running app consumes.
export interface SchemaV2Config {
  schemaVersion: 2;
  playback?: { watchedThreshold?: number };
  recommendations?: { count?: number };
  users: ConfigUser[];
  // account_key -> tiered account config (see AccountV2 in types.ts).
  accounts: Record<string, AccountV2>;
  // access token -> account_key. The token is the ONLY login credential.
  access_tokens: Record<string, string>;
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
// obsolete; we warn about it from server startup, not here. A schemaVersion-0
// source may spell this preset list `parties[]` (post-rename terminology) or
// `groups[]` (pre-rename); both are accepted — see legacyGroupsFrom below.
interface LegacyGroup {
  id?: string;
  name?: string;
  memberIds?: unknown;
}

interface LegacyConfig {
  household?: { username?: string; password?: string };
  groups?: LegacyGroup[];
  // Alias for `groups[]` using the current "party" terminology. A source
  // written by/for a post-rename deployer may use this key instead; if BOTH
  // are present, `parties` wins (it is the more specific/intentional key).
  parties?: LegacyGroup[];
  playback?: { watchedThreshold?: number };
  recommendations?: { count?: number };
}

// The legacy preset list, accepting either spelling: `parties[]` (current
// terminology) takes precedence when present, else the pre-rename `groups[]`.
function legacyGroupsFrom(legacy: LegacyConfig): LegacyGroup[] {
  return legacy.parties ?? legacy.groups ?? [];
}

// ── Migration 0 -> 1: legacy household/groups (UUIDs) -> users/accounts ─────
// Pure (ctx supplies the Jellyfin user list). Maps each legacy party memberId
// UUID to its Jellyfin user NAME, unions them into users[] (no pins existed),
// synthesizes a single account from the household/portal creds, carries over
// playback/recommendations, and drops the obsolete groups[]/parties[] presets.
export function migrate0to1(
  rawConfig: Record<string, unknown>,
  ctx: MigrationContext,
): SchemaV1Config {
  const legacy = rawConfig as LegacyConfig;
  const nameById = new Map(ctx.jellyfinUsers.map((user) => [user.id, user.name]));
  const legacyGroups = legacyGroupsFrom(legacy);

  // Union of resolved user names across all legacy parties, in first-seen order.
  const resolvedNames: string[] = [];
  const seen = new Set<string>();
  for (const group of legacyGroups) {
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
  const visibleUsers: VisibleUserV1[] = resolvedNames.map((name) => ({ jellyfin_name: name }));

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

  const accounts: ConfigAccountV1[] = [{ username, password, visible_users: visibleUsers }];

  if (legacyGroups.length > 0) {
    warnWith(ctx, 'dropped obsolete legacy groups[]/parties[] presets (parties are now formed live in the UI).');
  }

  return {
    schemaVersion: 1,
    playback: legacy.playback ? { watchedThreshold: legacy.playback.watchedThreshold } : undefined,
    recommendations: legacy.recommendations ? { count: legacy.recommendations.count } : undefined,
    users,
    accounts,
  };
}

// ── Migration 1 -> 2: credentialed accounts[] -> token-only tiered accounts ──
// Pure. Per v1 account: account_key = username; access token = password (the
// password was already the shared household secret, so it becomes the token).
// A password duplicating an earlier account's token gets `${password}-${username}`
// (tokens must be unique) with a warning. visible_users map by pin rule:
// pin_required => tertiary (guest, pin-gated), otherwise secondary;
// primary_users = []. All THREE tier lists are written EXPLICITLY (never
// omitted) so the v2 wildcard semantics can never widen visibility beyond what
// the v1 config granted. users/playback/recommendations carry through unchanged.
export function migrate1to2(
  rawConfig: Record<string, unknown>,
  ctx: MigrationContext,
): SchemaV2Config {
  const v1 = rawConfig as unknown as SchemaV1Config;

  const accounts: Record<string, AccountV2> = {};
  const accessTokens: Record<string, string> = {};
  const usedTokens = new Set<string>();

  for (const account of Array.isArray(v1.accounts) ? v1.accounts : []) {
    const username = typeof account?.username === 'string' ? account.username.trim() : '';
    const password = typeof account?.password === 'string' ? account.password : '';
    if (!username || !password) {
      warnWith(ctx, 'skipped a v1 account missing username or password.');
      continue;
    }
    if (accounts[username]) {
      warnWith(ctx, `skipped a duplicate v1 account "${username}".`);
      continue;
    }

    const originalToken = password;
    let token = originalToken;
    if (usedTokens.has(token)) {
      const fallbackBase = `${originalToken}-${username}`;
      token = fallbackBase;
      let suffix = 2;
      while (usedTokens.has(token)) {
        token = `${fallbackBase}-${suffix}`;
        suffix += 1;
      }
      warnWith(
        ctx,
        `account "${username}": password duplicates another account's access token; ` +
        `derived a unique token "${token}" from fallback "${fallbackBase}" - ` +
        'share this new token with the account holder.',
      );
    }
    usedTokens.add(token);

    const secondary: string[] = [];
    const tertiary: string[] = [];
    for (const visible of Array.isArray(account.visible_users) ? account.visible_users : []) {
      const name = typeof visible?.jellyfin_name === 'string' ? visible.jellyfin_name.trim() : '';
      if (!name) {
        continue;
      }
      (visible.pin_required === true ? tertiary : secondary).push(name);
    }

    accounts[username] = {
      primary_users: [],
      secondary_users: secondary,
      tertiary_users: tertiary,
    };
    accessTokens[token] = username;
  }

  return {
    schemaVersion: 2,
    playback: v1.playback ? { watchedThreshold: v1.playback.watchedThreshold } : undefined,
    recommendations: v1.recommendations ? { count: v1.recommendations.count } : undefined,
    users: Array.isArray(v1.users) ? v1.users : [],
    accounts,
    access_tokens: accessTokens,
  };
}

// The ordered migration registry, keyed by the version each entry upgrades FROM.
export const MIGRATIONS: Migration[] = [
  { from: 0, migrate: (config, ctx) => migrate0to1(config, ctx) as unknown as Record<string, unknown> },
  { from: 1, migrate: (config, ctx) => migrate1to2(config, ctx) as unknown as Record<string, unknown> },
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
): SchemaV2Config {
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

  return { ...(current as unknown as SchemaV2Config), schemaVersion: CURRENT_SCHEMA_VERSION as 2 };
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
