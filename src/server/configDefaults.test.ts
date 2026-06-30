import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { EXAMPLE_CONFIG } from './configDefaults';

// Resolved at module load, before any test mutates process.cwd(). Tests run from
// the repo root (/app), where deploy/config.example.json lives.
const examplePath = path.resolve(process.cwd(), 'deploy', 'config.example.json');

// Drift guard: the committed deployer example must be the generated output of
// EXAMPLE_CONFIG. If this fails, someone edited config defaults without
// regenerating — run `npm run gen:config-example` and commit the result.
test('deploy/config.example.json deep-equals EXAMPLE_CONFIG', () => {
  const committed = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  assert.deepEqual(
    committed,
    EXAMPLE_CONFIG,
    'deploy/config.example.json is out of sync with EXAMPLE_CONFIG — run `npm run gen:config-example` and commit the result.',
  );
});
