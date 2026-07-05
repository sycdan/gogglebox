// Generate a RFC 9562 UUIDv7 (time-ordered) for effort .prompts/.outputs/.proofs
// filenames and prompt_id/base_tag values. Run via the npm script:
//
//   npm run gen:uuid7
//
// Never hand-pick or reuse a UUIDv7 (unless specifically referencing a generated one),
// always generate a fresh one here so ordering and uniqueness guarantees hold.

import { uuidv7 } from 'uuidv7';

console.log(uuidv7());
