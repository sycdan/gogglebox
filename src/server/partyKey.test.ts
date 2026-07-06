import assert from 'node:assert/strict';
import test from 'node:test';

import { derivePartyKey } from './partyKey';

test('derivePartyKey is order-independent for the same set of viewers', () => {
  const a = derivePartyKey(['user-c', 'user-a', 'user-b']);
  const b = derivePartyKey(['user-a', 'user-b', 'user-c']);
  assert.equal(a, b);
});

test('derivePartyKey ignores duplicate viewer ids', () => {
  const a = derivePartyKey(['user-a', 'user-a', 'user-b']);
  const b = derivePartyKey(['user-a', 'user-b']);
  assert.equal(a, b);
});

test('derivePartyKey differs for different viewer sets', () => {
  const a = derivePartyKey(['user-a', 'user-b']);
  const b = derivePartyKey(['user-a', 'user-c']);
  assert.notEqual(a, b);
});

test('derivePartyKey returns a 32-char dashless hex string', () => {
  const key = derivePartyKey(['user-a', 'user-b']);
  assert.match(key, /^[0-9a-f]{32}$/);
});

test('derivePartyKey is deterministic across calls', () => {
  assert.equal(derivePartyKey(['x', 'y']), derivePartyKey(['x', 'y']));
});

// Golden-value regression test: pins derivePartyKey's output for fixed inputs
// to specific, pre-computed hex strings. PARTY_NAMESPACE is baked into every
// already-persisted deployment's keys and Jellyfin usernames (see the "must
// NEVER change" comment in partyKey.ts) — unlike the tests above, which only
// check internal self-consistency, these assertions fail if PARTY_NAMESPACE
// or the derivation algorithm ever changes, even though such a change would
// still satisfy determinism/order-independence/dedup/format checks.
test('derivePartyKey golden values match pre-computed hex strings', () => {
  assert.equal(derivePartyKey(['user-a']), 'dd73cc99d93b5b219b5a520361778e43');
  assert.equal(derivePartyKey(['user-a', 'user-b']), 'f4f932ec88cf54989bd67d1a27eff523');
  assert.equal(
    derivePartyKey(['viewer-1', 'viewer-2', 'viewer-3']),
    '8fb7b620553c52a3ac6f772fb33751ab',
  );
});
