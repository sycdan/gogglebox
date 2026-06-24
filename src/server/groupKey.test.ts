import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveGroupKey } from './groupKey';

test('deriveGroupKey is order-independent for the same set of viewers', () => {
  const a = deriveGroupKey(['user-c', 'user-a', 'user-b']);
  const b = deriveGroupKey(['user-a', 'user-b', 'user-c']);
  assert.equal(a, b);
});

test('deriveGroupKey ignores duplicate viewer ids', () => {
  const a = deriveGroupKey(['user-a', 'user-a', 'user-b']);
  const b = deriveGroupKey(['user-a', 'user-b']);
  assert.equal(a, b);
});

test('deriveGroupKey differs for different viewer sets', () => {
  const a = deriveGroupKey(['user-a', 'user-b']);
  const b = deriveGroupKey(['user-a', 'user-c']);
  assert.notEqual(a, b);
});

test('deriveGroupKey returns a 32-char dashless hex string', () => {
  const key = deriveGroupKey(['user-a', 'user-b']);
  assert.match(key, /^[0-9a-f]{32}$/);
});

test('deriveGroupKey is deterministic across calls', () => {
  assert.equal(deriveGroupKey(['x', 'y']), deriveGroupKey(['x', 'y']));
});
