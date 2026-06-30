// Single source of truth for config defaults. Two consumers derive from this:
//   - the runtime (src/server/config.ts) seeds shape-defaults from CONFIG_DEFAULTS;
//   - the deployer example (deploy/config.example.json) is GENERATED from
//     EXAMPLE_CONFIG via scripts/gen-config-example.mjs.
// A drift test (configDefaults.test.ts) asserts the committed example file
// deep-equals EXAMPLE_CONFIG, so editing defaults without regenerating fails CI.
//
// Keep these plain JSON-serializable objects (no functions/dates) — the
// generator stringifies EXAMPLE_CONFIG directly.

import { CURRENT_SCHEMA_VERSION, SchemaV1Config } from './configMigrations';

// The shape-defaults the runtime seeds from before overlaying user overrides.
// schemaVersion auto-tracks the image's current schema (never hard-coded).
export const CONFIG_DEFAULTS = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  playback: { watchedThreshold: 0.9 },
  recommendations: { count: 8 },
} as const;

// The human-facing deployer config example.
export const EXAMPLE_CONFIG: SchemaV1Config = {
  ...CONFIG_DEFAULTS,
  users: [
    { jellyfin_name: 'Alice', pin: '1234' },
    { jellyfin_name: 'Bob', pin: '5678' },
    { jellyfin_name: 'Carol' },
    { jellyfin_name: 'Dave' },
  ],
  accounts: [
    {
      username: 'household1',
      password: 'household-password-1',
      visible_users: [
        { jellyfin_name: 'Alice', pin_required: true },
        { jellyfin_name: 'Bob', pin_required: true },
        { jellyfin_name: 'Carol' },
      ],
    },
    {
      username: 'household2',
      password: 'household-password-2',
      visible_users: [
        { jellyfin_name: 'Carol', pin_required: true },
        { jellyfin_name: 'Dave' },
      ],
    },
  ],
};
