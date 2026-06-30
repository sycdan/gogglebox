// Generate deploy/config.example.json from the single source of truth
// (EXAMPLE_CONFIG in src/server/configDefaults.ts). Run via the npm script:
//
//   npm run gen:config-example
//
// The drift test (src/server/configDefaults.test.ts) asserts the committed file
// is byte-for-byte this generated output, so re-run this whenever defaults change.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { EXAMPLE_CONFIG } from '../src/server/configDefaults.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(repoRoot, 'deploy', 'config.example.json');

// Pretty JSON, 2-space indent, trailing newline — must match the drift test.
const json = `${JSON.stringify(EXAMPLE_CONFIG, null, 2)}\n`;

writeFileSync(outPath, json);
console.log(`Wrote ${outPath}`);
