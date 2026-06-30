import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

import { AppConfig, ConfigAccount, ConfigUser, FamilyMember, VisibleUser } from './types';
import { CONFIG_DEFAULTS } from './configDefaults';
import {
  CURRENT_SCHEMA_VERSION,
  MigrationContext,
  SchemaV1Config,
  deepMergeConfig,
  hashRawConfig,
  runMigrationChain,
} from './configMigrations';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// The raw config file shape, before migration/validation/normalization. Any
// schemaVersion (or none) is accepted here; the migration chain forwards it to
// the current shape.
interface RawConfigFile {
  schemaVersion?: number;
  playback?: { watchedThreshold?: number };
  recommendations?: { count?: number };
  users?: ConfigUser[];
  accounts?: ConfigAccount[];
  [key: string]: unknown;
}

// The image's bundled seed for the CURRENT shape. Defaults are seeded from
// CONFIG_DEFAULTS (the single source of truth in ./configDefaults), then the
// migrated user overrides are layered on top. Bundled as a constant (not a
// file) because the Docker runtime image does not copy config.example.json.
const BUNDLED_EXAMPLE: SchemaV1Config = {
  ...CONFIG_DEFAULTS,
  users: [],
  accounts: [],
};

function readRequiredJsonFile<T>(filePath: string): { value: T; raw: string } {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required config file: ${filePath}. Copy config.example.json to config.json and fill it in.`);
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    throw new Error(`Config file is empty: ${filePath}. Copy config.example.json to config.json and fill it in.`);
  }

  try {
    return { value: JSON.parse(raw) as T, raw };
  } catch (error) {
    throw new Error(`Config file is not valid JSON: ${filePath}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function clampThreshold(value: number): number {
  if (Number.isNaN(value)) {
    return 0.9;
  }

  return Math.min(0.99, Math.max(0.5, value));
}

function clampRecommendationCount(value: number): number {
  if (Number.isNaN(value)) {
    return 8;
  }

  return Math.min(24, Math.max(1, Math.trunc(value)));
}

function defaultWarn(message: string): void {
  console.warn(`[config] ${message}`);
}

// Normalize + skip+warn validate a migrated/merged config against the live
// Jellyfin user list. Unlike the old fail-fast rules, an unresolved reference is
// DROPPED with a warning rather than crashing startup:
//   - a users[] entry whose name has no Jellyfin match is dropped, and cascade-
//     removed from every account's visible_users (warn);
//   - an account left with no visible users is dropped (warn).
// Fails fast ONLY when the result is unusable: zero users OR zero accounts.
// Returns the cleaned users/accounts on success.
export function validateAndResolveConfig(
  config: SchemaV1Config,
  jellyfinUsers: FamilyMember[],
  warn: (message: string) => void = defaultWarn,
): { users: ConfigUser[]; accounts: ConfigAccount[] } {
  const jellyfinNames = new Set(jellyfinUsers.map((user) => user.name));

  // Normalize users[]: trim, drop blank names, de-dupe, drop names with no
  // Jellyfin match (warn each).
  const usersByName = new Map<string, ConfigUser>();
  for (const user of Array.isArray(config.users) ? config.users : []) {
    const name = typeof user?.jellyfin_name === 'string' ? user.jellyfin_name.trim() : '';
    if (!name) {
      warn('dropped a users[] entry with no jellyfin_name.');
      continue;
    }
    if (usersByName.has(name)) {
      warn(`dropped a duplicate users[] entry for "${name}".`);
      continue;
    }
    if (!jellyfinNames.has(name)) {
      warn(`dropped user "${name}": no matching Jellyfin user (check Jellyfin admin -> Users).`);
      continue;
    }
    usersByName.set(name, {
      jellyfin_name: name,
      pin: typeof user.pin === 'string' && user.pin ? user.pin : undefined,
    });
  }

  const keptNames = new Set(usersByName.keys());

  // Normalize accounts[]: trim creds, drop accounts missing creds, cascade-drop
  // visible_users referencing a dropped/unknown user, drop accounts left empty.
  const accounts: ConfigAccount[] = [];
  const accountUsernames = new Set<string>();
  for (const account of Array.isArray(config.accounts) ? config.accounts : []) {
    const username = typeof account?.username === 'string' ? account.username.trim() : '';
    const password = typeof account?.password === 'string' ? account.password : '';
    if (!username || !password) {
      warn('dropped an account missing username or password.');
      continue;
    }
    if (accountUsernames.has(username)) {
      warn(`dropped a duplicate account "${username}".`);
      continue;
    }

    const rawVisible = Array.isArray(account.visible_users) ? account.visible_users : [];
    const visibleUsers: VisibleUser[] = [];
    for (const visible of rawVisible) {
      const name = typeof visible?.jellyfin_name === 'string' ? visible.jellyfin_name.trim() : '';
      if (!name) {
        warn(`account "${username}": dropped a visible_users entry with no jellyfin_name.`);
        continue;
      }
      if (!keptNames.has(name)) {
        warn(`account "${username}": dropped visible user "${name}" (not a resolvable top-level user).`);
        continue;
      }
      // A user marked pin_required must have a pin; if not, downgrade to not
      // required (warn) rather than fail.
      let pinRequired = visible.pin_required === true;
      if (pinRequired && !usersByName.get(name)?.pin) {
        warn(`account "${username}": user "${name}" marked pin_required but has no pin; treating as not required.`);
        pinRequired = false;
      }
      visibleUsers.push({ jellyfin_name: name, pin_required: pinRequired });
    }

    if (visibleUsers.length === 0) {
      warn(`dropped account "${username}": no visible users remain after resolution.`);
      continue;
    }

    accountUsernames.add(username);
    accounts.push({ username, password, visible_users: visibleUsers });
  }

  // Only users actually referenced by a surviving account matter; but keep all
  // resolved users (they may be referenced by future accounts). Fail fast only
  // when the result is unusable.
  const users = [...usersByName.values()];
  if (users.length === 0) {
    throw new Error(
      'Config is unusable after auto-migration: no users resolved to a Jellyfin account. ' +
      'Check your users[] jellyfin_name values against Jellyfin admin -> Users.',
    );
  }
  if (accounts.length === 0) {
    throw new Error(
      'Config is unusable after auto-migration: no login accounts remain. ' +
      'Check your accounts[] credentials and visible_users.',
    );
  }

  return { users, accounts };
}

// Resolve configured user names to Jellyfin viewers (id/avatar). Returns a
// name -> viewer map the app keeps in its own writable state (the read-only
// config never holds ids). Names are expected to already be resolvable
// (validateAndResolveConfig dropped any that weren't); an unexpected miss is
// skipped defensively.
export function resolveViewers(
  users: ConfigUser[],
  jellyfinUsers: FamilyMember[],
): Record<string, FamilyMember> {
  const byName = new Map(jellyfinUsers.map((user) => [user.name, user]));
  const viewersByName: Record<string, FamilyMember> = {};

  for (const user of users) {
    const match = byName.get(user.jellyfin_name);
    if (match) {
      viewersByName[user.jellyfin_name] = match;
    }
  }

  return viewersByName;
}

function readPortalCredentials(): AppConfig['portalCredentials'] {
  const username = process.env.PORTAL_USERNAME?.trim();
  const password = process.env.PORTAL_PASSWORD?.trim();
  if (!username || !password) {
    return null;
  }

  return { username, password };
}

// The provenance stamped onto the cached effective config in /data.
export interface EffectiveConfigProvenance {
  schemaVersion: number;
  builtForPackage: string;
  sourceHash: string;
}

// The cached effective config: the validated users/accounts plus the playback/
// recommendations the migrated+merged config resolved to, with provenance.
export interface EffectiveConfig extends EffectiveConfigProvenance {
  users: ConfigUser[];
  accounts: ConfigAccount[];
  watchedThreshold: number;
  recommendationCount: number;
}

// The stable hash of the raw config source file. Used to decide whether the
// cached effective config in /data is still fresh BEFORE doing the (async) build.
export function readSourceHash(
  configPath: string = path.join(process.cwd(), 'config.json'),
): string {
  const { raw } = readRequiredJsonFile<RawConfigFile>(configPath);
  return hashRawConfig(raw);
}

// Build the EFFECTIVE config from the read-only source file + the live Jellyfin
// user list. Steps:
//   1. Read raw config.json (overrides); detect schemaVersion; hash the raw text.
//   2. Run the migration chain (fails fast only if source > image max).
//   3. Seed defaults from the bundled example; deep-merge migrated overrides.
//   4. Skip+warn validate against Jellyfin users (fail only if unusable).
//   5. Return the derived effective config + provenance.
// The caller (server startup) persists/caches this in /data via AppState.
export function buildEffectiveConfig(
  ctx: { jellyfinUsers: FamilyMember[]; warn?: (message: string) => void },
  packageVersion: string,
  configPath: string = path.join(process.cwd(), 'config.json'),
): EffectiveConfig {
  const warn = ctx.warn ?? defaultWarn;
  const { value: rawConfig, raw } = readRequiredJsonFile<RawConfigFile>(configPath);
  const sourceHash = hashRawConfig(raw);

  const migrationContext: MigrationContext = {
    jellyfinUsers: ctx.jellyfinUsers.map((user) => ({ id: user.jellyfinUserId, name: user.name })),
    portalUsername: process.env.PORTAL_USERNAME?.trim(),
    portalPassword: process.env.PORTAL_PASSWORD?.trim(),
    warn: (message) => warn(message),
  };

  const migrated = runMigrationChain(rawConfig as Record<string, unknown>, migrationContext);
  const merged = deepMergeConfig(BUNDLED_EXAMPLE, migrated);

  const { users, accounts } = validateAndResolveConfig(merged, ctx.jellyfinUsers, warn);

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    builtForPackage: packageVersion,
    sourceHash,
    users,
    accounts,
    watchedThreshold: clampThreshold(
      Number(process.env.WATCHED_THRESHOLD ?? merged.playback?.watchedThreshold ?? 0.9),
    ),
    recommendationCount: clampRecommendationCount(Number(merged.recommendations?.count ?? 8)),
  };
}

// Load the static, Jellyfin-free part of the app config from env. The
// users/accounts/viewersByName + recommendation/threshold derived values are
// filled in later by the async effective-config build at startup (which needs
// the Jellyfin user list).
export function loadConfig(): AppConfig {
  const jellyfinUrl = process.env.JELLYFIN_URL?.trim();
  const jellyfinApiKey = process.env.JELLYFIN_API_KEY?.trim();

  if (!jellyfinUrl || !jellyfinApiKey) {
    throw new Error('Missing JELLYFIN_URL or JELLYFIN_API_KEY in .env');
  }

  return {
    appName: 'Gogglebox',
    port: Number(process.env.PORT ?? 3000),
    sessionSecret: process.env.SESSION_SECRET ?? 'gogglebox-dev-session-secret',
    watchedThreshold: clampThreshold(Number(process.env.WATCHED_THRESHOLD ?? 0.9)),
    portalCredentials: readPortalCredentials(),
    jellyfinUrl: jellyfinUrl.replace(/\/$/, ''),
    jellyfinApiKey,
    recommendations: { count: 8 },
    users: [],
    accounts: [],
    viewersByName: {},
  };
}
