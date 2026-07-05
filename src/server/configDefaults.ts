// Single source of truth for config defaults. Two consumers derive from this:
//   - the runtime (src/server/config.ts) seeds shape-defaults from CONFIG_DEFAULTS;
//   - the deployer example (deploy/config.example.json) is GENERATED from
//     EXAMPLE_CONFIG via scripts/gen-config-example.mjs.
// A drift test (configDefaults.test.ts) asserts the committed example file
// deep-equals EXAMPLE_CONFIG, so editing defaults without regenerating fails CI.
//
// Keep these plain JSON-serializable objects (no functions/dates) — the
// generator stringifies EXAMPLE_CONFIG directly.

import { CURRENT_SCHEMA_VERSION, SchemaV2Config } from './configMigrations';

// The shape-defaults the runtime seeds from before overlaying user overrides.
// schemaVersion auto-tracks the image's current schema (never hard-coded).
export const CONFIG_DEFAULTS = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  playback: { watchedThreshold: 0.9 },
  recommendations: { count: 8 },
} as const;

// The human-facing deployer config example. house1 shows fully-explicit tier
// lists (Dave is a pin-gated guest); house2 shows the wildcard style — with
// secondary_users/tertiary_users omitted, every other live Jellyfin user is a
// secondary and the leftover (none here) are guest candidates.
export const EXAMPLE_CONFIG: SchemaV2Config = {
  ...CONFIG_DEFAULTS,
  users: [
    { jellyfin_name: 'Alice', pin: '1234' },
    { jellyfin_name: 'Bob', pin: '5678' },
    { jellyfin_name: 'Carol' },
    { jellyfin_name: 'Dave', pin: '2468' },
  ],
  accounts: {
    house1: {
      primary_users: ['Alice', 'Bob'],
      secondary_users: ['Carol'],
      tertiary_users: ['Dave'],
    },
    house2: {
      primary_users: ['Dave'],
    },
  },
  access_tokens: {
    'replace-with-a-long-random-token-1': 'house1',
    'replace-with-a-long-random-token-2': 'house2',
  },
};
