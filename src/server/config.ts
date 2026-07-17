import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

import { resolveAccountTiers } from './accounts';
import { AccountV2, AppConfig, ConfigUser, FamilyMember } from './types';
import { CONFIG_DEFAULTS } from './configDefaults';
import {
  CURRENT_SCHEMA_VERSION,
  MigrationContext,
  SchemaV2Config,
  deepMergeConfig,
  hashRawConfig,
  runMigrationChain,
} from './configMigrations';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// The raw config file shape, before migration/validation/normalization. Any
// schemaVersion (or none) is accepted here; the migration chain forwards it to
// the current shape (accounts may be a v1 array or a v2 record, hence unknown).
interface RawConfigFile {
  schemaVersion?: number;
  playback?: { watchedThreshold?: number };
  recommendations?: { count?: number };
  users?: ConfigUser[];
  accounts?: unknown;
  access_tokens?: unknown;
  [key: string]: unknown;
}

// The image's bundled seed for the CURRENT shape. Defaults are seeded from
// CONFIG_DEFAULTS (the single source of truth in ./configDefaults), then the
// migrated user overrides are layered on top. Bundled as a constant (not a
// file) because the Docker runtime image does not copy config.example.json.
const BUNDLED_EXAMPLE: SchemaV2Config = {
  ...CONFIG_DEFAULTS,
  users: [],
  accounts: {},
  access_tokens: {},
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
    return CONFIG_DEFAULTS.recommendations.count;
  }

  return Math.min(24, Math.max(1, Math.trunc(value)));
}

function defaultWarn(message: string): void {
  console.warn(`[config] ${message}`);
}

// Normalize + skip+warn validate a migrated/merged v2 config against the live
// Jellyfin user list. An unresolved reference is DROPPED with a warning rather
// than crashing startup:
//   - a users[] entry whose name has no Jellyfin match is dropped (warn);
//   - an unknown Jellyfin name in an explicit tier list is dropped (warn);
//   - a name claimed by multiple explicit tiers keeps the highest tier
//     (primary > secondary > tertiary) with a warning;
//   - an EXPLICIT tertiary (guest) with no configured pin warns (they can
//     never be added — the runtime pin-filter excludes them);
//   - an account whose RESOLVED tiers are all empty is dropped (warn);
//   - an access_tokens entry pointing at a missing account is dropped (warn);
//   - an account with no surviving token warns (unreachable) but is kept.
// Fails fast ONLY when the result is unusable: zero accounts OR zero access
// tokens survive. Returns the cleaned users/accounts/accessTokens on success.
export function validateAndResolveConfig(
  config: SchemaV2Config,
  jellyfinUsers: FamilyMember[],
  warn: (message: string) => void = defaultWarn,
): { users: ConfigUser[]; accounts: Record<string, AccountV2>; accessTokens: Record<string, string> } {
  const jellyfinNames = new Set(jellyfinUsers.map((user) => user.name));
  const allJellyfinNames = jellyfinUsers.map((user) => user.name);

  // Normalize users[] (the pin registry): trim, drop blank names, de-dupe,
  // drop names with no Jellyfin match (warn each). The viewer universe is ALL
  // live Jellyfin users, so an empty users[] is fine — it only means no pins.
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

  const users = [...usersByName.values()];

  // Normalize accounts: clean each explicit tier list (null/omitted stays null
  // — a WILDCARD resolved live at request time), enforce tier precedence
  // across explicit lists, and drop accounts whose resolved tiers are all empty.
  const accounts: Record<string, AccountV2> = {};
  for (const [rawKey, rawAccount] of Object.entries(config.accounts ?? {})) {
    const accountKey = rawKey.trim();
    if (!accountKey || !rawAccount || typeof rawAccount !== 'object') {
      warn('dropped a malformed accounts entry (blank key or non-object value).');
      continue;
    }

    // Clean one explicit list: trim names, drop blanks/dupes/unknown Jellyfin
    // names (warn). null/undefined passes through as null (wildcard semantics).
    const cleanList = (list: string[] | null | undefined, label: string): string[] | null => {
      if (list === undefined || list === null) {
        return null;
      }
      if (!Array.isArray(list)) {
        warn(`account "${accountKey}": ${label} must be a list of Jellyfin names; treating as omitted.`);
        return null;
      }
      const out: string[] = [];
      for (const entry of list) {
        const name = typeof entry === 'string' ? entry.trim() : '';
        if (!name) {
          warn(`account "${accountKey}": dropped a blank ${label} entry.`);
          continue;
        }
        if (out.includes(name)) {
          warn(`account "${accountKey}": dropped a duplicate ${label} entry "${name}".`);
          continue;
        }
        if (!jellyfinNames.has(name)) {
          warn(`account "${accountKey}": dropped ${label} "${name}" (no matching Jellyfin user).`);
          continue;
        }
        out.push(name);
      }
      return out;
    };

    const primary = cleanList(rawAccount.primary_users, 'primary_users');
    let secondary = cleanList(rawAccount.secondary_users, 'secondary_users');
    let tertiary = cleanList(rawAccount.tertiary_users, 'tertiary_users');

    // Precedence across EXPLICIT lists: primary > secondary > tertiary. Keep
    // the highest tier, warn about the shadowed entries. (Wildcard lists
    // subtract higher tiers by definition — see resolveAccountTiers.)
    const primarySet = new Set(primary ?? []);
    if (secondary) {
      secondary = secondary.filter((name) => {
        if (primarySet.has(name)) {
          warn(`account "${accountKey}": "${name}" is listed as both primary and secondary; keeping primary.`);
          return false;
        }
        return true;
      });
    }
    if (tertiary) {
      const secondarySet = new Set(secondary ?? []);
      tertiary = tertiary.filter((name) => {
        if (primarySet.has(name) || secondarySet.has(name)) {
          warn(`account "${accountKey}": "${name}" is listed in multiple tiers; keeping the higher tier.`);
          return false;
        }
        return true;
      });
      // An explicitly-listed guest with no configured pin can never be added
      // (the guest flow requires their pin) — warn, the pin-filter excludes them.
      for (const name of tertiary) {
        if (!usersByName.get(name)?.pin) {
          warn(
            `account "${accountKey}": tertiary user "${name}" has no pin in users[] ` +
            'and can never be added as a guest — configure a pin for them.',
          );
        }
      }
    }

    const cleaned: AccountV2 = {
      primary_users: primary,
      secondary_users: secondary,
      tertiary_users: tertiary,
    };

    // Drop an account whose resolved tiers are ALL empty — it could log in but
    // never see a single viewer.
    const resolved = resolveAccountTiers(cleaned, allJellyfinNames, users);
    if (resolved.primary.length + resolved.secondary.length + resolved.tertiary.length === 0) {
      warn(`dropped account "${accountKey}": no viewers remain after tier resolution.`);
      continue;
    }

    accounts[accountKey] = cleaned;
  }

  // Normalize access_tokens: token -> account_key. Drop blanks and tokens
  // pointing at a missing (or dropped) account.
  const accessTokens: Record<string, string> = {};
  for (const [rawToken, rawAccountKey] of Object.entries(config.access_tokens ?? {})) {
    const token = rawToken.trim();
    const accountKey = typeof rawAccountKey === 'string' ? rawAccountKey.trim() : '';
    if (!token || !accountKey) {
      warn('dropped a malformed access_tokens entry (blank token or account key).');
      continue;
    }
    if (!accounts[accountKey]) {
      warn(`dropped an access token for unknown account "${accountKey}".`);
      continue;
    }
    accessTokens[token] = accountKey;
  }

  // An account without a token is unreachable — warn but keep it (the deployer
  // may add a token without touching the account definition).
  const tokenedAccounts = new Set(Object.values(accessTokens));
  for (const accountKey of Object.keys(accounts)) {
    if (!tokenedAccounts.has(accountKey)) {
      warn(`account "${accountKey}" has no access token and cannot be logged into.`);
    }
  }

  // Fail fast only when the result is unusable.
  if (Object.keys(accounts).length === 0) {
    throw new Error(
      'Config is unusable after auto-migration: no accounts remain. ' +
      'Check your accounts tier lists against Jellyfin admin -> Users.',
    );
  }
  if (Object.keys(accessTokens).length === 0) {
    throw new Error(
      'Config is unusable after auto-migration: no access tokens remain. ' +
      'Check that access_tokens entries point at existing account keys.',
    );
  }

  return { users, accounts, accessTokens };
}

// Resolve ALL live Jellyfin users to a name -> viewer map the app keeps in its
// own writable state (the read-only config never holds ids). The whole live
// list — not just users[] — because v2 wildcard tiers can include unconfigured
// users (pins still only come from users[]). Insertion order == Jellyfin list
// order, which wildcard tier resolution preserves.
export function resolveViewers(jellyfinUsers: FamilyMember[]): Record<string, FamilyMember> {
  const viewersByName: Record<string, FamilyMember> = {};

  for (const user of jellyfinUsers) {
    viewersByName[user.name] = user;
  }

  return viewersByName;
}

// The provenance stamped onto the cached effective config in /data.
export interface EffectiveConfigProvenance {
  schemaVersion: number;
  builtForPackage: string;
  sourceHash: string;
}

// The cached effective config: the validated users/accounts/accessTokens plus
// the playback/recommendations the migrated+merged config resolved to, with
// provenance.
export interface EffectiveConfig extends EffectiveConfigProvenance {
  users: ConfigUser[];
  accounts: Record<string, AccountV2>;
  accessTokens: Record<string, string>;
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
    // Legacy PORTAL_* creds are consulted ONLY by the 0 -> 1 migration step (to
    // synthesize a v1 account for a pre-versioned config); the running app's
    // auto-login is the ACCESS_TOKEN env var (see loadConfig).
    portalUsername: process.env.PORTAL_USERNAME?.trim(),
    portalPassword: process.env.PORTAL_PASSWORD?.trim(),
    warn: (message) => warn(message),
  };

  const migrated = runMigrationChain(rawConfig as Record<string, unknown>, migrationContext);
  const merged = deepMergeConfig(BUNDLED_EXAMPLE, migrated);

  const { users, accounts, accessTokens } = validateAndResolveConfig(merged, ctx.jellyfinUsers, warn);

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    builtForPackage: packageVersion,
    sourceHash,
    users,
    accounts,
    accessTokens,
    watchedThreshold: clampThreshold(
      Number(process.env.WATCHED_THRESHOLD ?? merged.playback?.watchedThreshold ?? 0.9),
    ),
    recommendationCount: clampRecommendationCount(
      Number(merged.recommendations?.count ?? CONFIG_DEFAULTS.recommendations.count),
    ),
  };
}

// Load the static, Jellyfin-free part of the app config from env. The
// users/accounts/accessTokens/viewersByName + recommendation/threshold derived
// values are filled in later by the async effective-config build at startup
// (which needs the Jellyfin user list).
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
    // Auto-login token: an empty login body falls back to this (see server.ts).
    envAccessToken: process.env.ACCESS_TOKEN?.trim() || null,
    jellyfinUrl: jellyfinUrl.replace(/\/$/, ''),
    jellyfinApiKey,
    recommendations: { count: CONFIG_DEFAULTS.recommendations.count },
    users: [],
    accounts: {},
    accessTokens: {},
    viewersByName: {},
  };
}
