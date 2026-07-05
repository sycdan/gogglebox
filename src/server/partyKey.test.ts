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
