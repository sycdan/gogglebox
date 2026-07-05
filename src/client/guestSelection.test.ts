import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildContinueGuestSubmission,
  guestIdsForPinRetry,
  isGuestConfirmDisabled,
  reconcileContinueGuestSelection,
} from './guestSelection';

test('reconcileContinueGuestSelection removes deselected continue-modal guests from submitted ids', () => {
  const result = reconcileContinueGuestSelection(
    ['primary-a', 'secondary-b', 'guest-carol', 'guest-dave'],
    ['guest-carol', 'guest-dave'],
    ['guest-dave'],
  );

  assert.deepEqual(result, ['primary-a', 'secondary-b', 'guest-dave']);
});

test('reconcileContinueGuestSelection preserves all selected modal guests after PIN confirmation', () => {
  const result = reconcileContinueGuestSelection(
    ['primary-a', 'guest-carol', 'guest-dave'],
    ['guest-carol', 'guest-dave'],
    ['guest-carol', 'guest-dave'],
  );

  assert.deepEqual(result, ['primary-a', 'guest-carol', 'guest-dave']);
});

test('reconcileContinueGuestSelection can remove every modal guest when all are deselected', () => {
  const result = reconcileContinueGuestSelection(
    ['primary-a', 'guest-carol'],
    ['guest-carol'],
    [],
  );

  assert.deepEqual(result, ['primary-a']);
});

test('reconcileContinueGuestSelection can add a confirmed modal guest missing from stale local selection', () => {
  const result = reconcileContinueGuestSelection(
    ['primary-a'],
    ['guest-carol'],
    ['guest-carol'],
  );

  assert.deepEqual(result, ['primary-a', 'guest-carol']);
});

// The submission buildContinueGuestSubmission returns is exactly what the
// confirm click sends to POST /api/party/verify-pins (and, once verified, to
// POST /api/party): reconciled member ids plus pins keyed by jellyfinUserId.
test('buildContinueGuestSubmission collects typed pins keyed by jellyfinUserId', () => {
  const result = buildContinueGuestSubmission({
    selectedViewerIds: ['primary-a', 'guest-carol'],
    pins: {},
    modalGuests: [{ id: 'guest-carol', jellyfinUserId: 'jf-carol' }],
    draftedGuests: [{ id: 'guest-carol', jellyfinUserId: 'jf-carol' }],
    draftPins: { 'guest-carol': '5678' },
  });

  assert.deepEqual(result.memberIds, ['primary-a', 'guest-carol']);
  assert.deepEqual(result.pins, { 'jf-carol': '5678' });
});

test('buildContinueGuestSubmission drops a deselected modal guest and their pin', () => {
  const result = buildContinueGuestSubmission({
    selectedViewerIds: ['primary-a', 'guest-carol', 'guest-dave'],
    pins: { 'jf-carol': 'stale', 'jf-other': 'kept' },
    modalGuests: [
      { id: 'guest-carol', jellyfinUserId: 'jf-carol' },
      { id: 'guest-dave', jellyfinUserId: 'jf-dave' },
    ],
    draftedGuests: [{ id: 'guest-dave', jellyfinUserId: 'jf-dave' }],
    draftPins: { 'guest-dave': '2468' },
  });

  // Carol was deselected in the modal: she leaves the member ids AND her
  // collected pin is dropped; a pin for a non-modal member survives untouched.
  assert.deepEqual(result.memberIds, ['primary-a', 'guest-dave']);
  assert.deepEqual(result.pins, { 'jf-other': 'kept', 'jf-dave': '2468' });
});

test('isGuestConfirmDisabled plain add flow needs a drafted guest and never a pin', () => {
  const base = {
    forContinue: false,
    selectedViewerIds: ['primary-a'],
    candidateIds: ['guest-carol'],
    draftPins: {},
  };

  assert.equal(isGuestConfirmDisabled({ ...base, draftIds: [] }), true);
  // No pin typed — the plain flow is selection-only, so confirm is enabled.
  assert.equal(isGuestConfirmDisabled({ ...base, draftIds: ['guest-carol'] }), false);
});

test('isGuestConfirmDisabled continue flow requires a non-empty pin per drafted guest', () => {
  const base = {
    forContinue: true,
    selectedViewerIds: ['primary-a', 'guest-carol'],
    candidateIds: ['guest-carol'],
    draftIds: ['guest-carol'],
  };

  assert.equal(isGuestConfirmDisabled({ ...base, draftPins: {} }), true);
  assert.equal(isGuestConfirmDisabled({ ...base, draftPins: { 'guest-carol': '   ' } }), true);
  assert.equal(isGuestConfirmDisabled({ ...base, draftPins: { 'guest-carol': '5678' } }), false);
});

test('isGuestConfirmDisabled continue flow may empty the draft only when other members remain', () => {
  // Deselecting every modal guest is fine while a non-modal member survives.
  assert.equal(
    isGuestConfirmDisabled({
      forContinue: true,
      selectedViewerIds: ['primary-a', 'guest-carol'],
      candidateIds: ['guest-carol'],
      draftIds: [],
      draftPins: {},
    }),
    false,
  );
  // ...but confirming away the ENTIRE submitted selection stays blocked.
  assert.equal(
    isGuestConfirmDisabled({
      forContinue: true,
      selectedViewerIds: ['guest-carol'],
      candidateIds: ['guest-carol'],
      draftIds: [],
      draftPins: {},
    }),
    true,
  );
});

test('guestIdsForPinRetry reopens the pin modal for exactly the submitted guest members', () => {
  const viewers = [
    { id: 'primary-a', tier: 'primary' },
    { id: 'secondary-b', tier: 'secondary' },
    { id: 'guest-carol', tier: 'tertiary' },
    { id: 'guest-dave', tier: 'tertiary' },
  ];

  assert.deepEqual(
    guestIdsForPinRetry(['primary-a', 'secondary-b', 'guest-carol'], viewers),
    ['guest-carol'],
  );
  assert.deepEqual(
    guestIdsForPinRetry(['primary-a', 'guest-carol', 'guest-dave'], viewers),
    ['guest-carol', 'guest-dave'],
  );
});

test('guestIdsForPinRetry yields no guests for an all-household party (banner fallback)', () => {
  const viewers = [
    { id: 'primary-a', tier: 'primary' },
    { id: 'guest-carol', tier: 'tertiary' },
  ];

  assert.deepEqual(guestIdsForPinRetry(['primary-a'], viewers), []);
});
