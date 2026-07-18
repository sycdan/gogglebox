import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addTonightSentiment,
  createTonightNineState,
  currentTonightLeader,
  dismissFocusedTonightCard,
  isTonightExhausted,
  moveTonightFocus,
  visibleTonightIds,
} from './tonightsNine';

const items = Array.from({ length: 9 }, (_, index) => ({ id: `item-${index + 1}` }));

test('createTonightNineState puts the top pick in the center with two visible neighbors', () => {
  const state = createTonightNineState(items);

  assert.deepEqual(state.slots, {
    left: 'item-2',
    center: 'item-1',
    right: 'item-3',
  });
  assert.deepEqual(state.after, ['item-4', 'item-5', 'item-6', 'item-7', 'item-8', 'item-9']);
});

test('moveTonightFocus lets the room scroll away and back through the finite nine', () => {
  const initial = createTonightNineState(items);
  const movedRight = moveTonightFocus(initial, 'right');
  const movedBack = moveTonightFocus(movedRight, 'left');

  assert.deepEqual(movedRight.slots, {
    left: 'item-1',
    center: 'item-3',
    right: 'item-4',
  });
  assert.deepEqual(movedBack.slots, initial.slots);
});

test('dismissFocusedTonightCard keeps visible neighbors stable and injects an offscreen replacement', () => {
  const state = createTonightNineState(items);
  const dismissed = dismissFocusedTonightCard(state);

  assert.equal(dismissed.slots.left, 'item-2');
  assert.equal(dismissed.slots.right, 'item-3');
  assert.equal(dismissed.slots.center, 'item-4');
  assert.deepEqual(dismissed.dismissed, ['item-1']);
});

test('currentTonightLeader names the strongest positive sentiment without needing raw counts', () => {
  const state = createTonightNineState(items);
  const supportedLeft = addTonightSentiment(moveTonightFocus(state, 'left'));
  const supportedCenter = addTonightSentiment(addTonightSentiment(moveTonightFocus(supportedLeft, 'right')));

  assert.equal(currentTonightLeader(supportedCenter), 'item-1');
});

test('isTonightExhausted becomes true after every card is dismissed', () => {
  let state = createTonightNineState(items.slice(0, 3));
  while (!isTonightExhausted(state)) {
    state = dismissFocusedTonightCard(state);
    if (state.slots.center === null && state.slots.left) {
      state = moveTonightFocus(state, 'left');
    } else if (state.slots.center === null && state.slots.right) {
      state = moveTonightFocus(state, 'right');
    }
  }

  assert.deepEqual(visibleTonightIds(state), []);
});
