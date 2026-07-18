export type TonightSlot = 'left' | 'center' | 'right';

export interface TonightCardRef {
  id: string;
}

export interface TonightSlots {
  left: string | null;
  center: string | null;
  right: string | null;
}

export interface TonightNineState {
  slots: TonightSlots;
  before: string[];
  after: string[];
  dismissed: string[];
  sentiment: Record<string, number>;
}

export type TonightDirection = 'left' | 'right';

export function createTonightNineState(items: TonightCardRef[]): TonightNineState {
  const ids = items.map((item) => item.id);
  return {
    slots: {
      left: ids[1] ?? null,
      center: ids[0] ?? null,
      right: ids[2] ?? null,
    },
    before: [],
    after: ids.slice(3),
    dismissed: [],
    sentiment: {},
  };
}

export function visibleTonightIds(state: TonightNineState): string[] {
  return [state.slots.left, state.slots.center, state.slots.right].filter((id): id is string => Boolean(id));
}

export function moveTonightFocus(state: TonightNineState, direction: TonightDirection): TonightNineState {
  if (direction === 'left') {
    if (!state.slots.left) return state;
    const before = [...state.before];
    const nextLeft = before.pop() ?? null;
    return {
      ...state,
      before,
      after: [state.slots.right, ...state.after].filter((id): id is string => Boolean(id)),
      slots: {
        left: nextLeft,
        center: state.slots.left,
        right: state.slots.center,
      },
    };
  }

  if (!state.slots.right) return state;
  const [nextRight = null, ...after] = state.after;
  return {
    ...state,
    before: [state.slots.left, ...state.before].filter((id): id is string => Boolean(id)),
    after,
    slots: {
      left: state.slots.center,
      center: state.slots.right,
      right: nextRight,
    },
  };
}

export function addTonightSentiment(state: TonightNineState, amount = 1): TonightNineState {
  const focused = state.slots.center;
  if (!focused) return state;
  return {
    ...state,
    sentiment: {
      ...state.sentiment,
      [focused]: (state.sentiment[focused] ?? 0) + amount,
    },
  };
}

export function dismissFocusedTonightCard(state: TonightNineState): TonightNineState {
  const focused = state.slots.center;
  if (!focused) return state;
  const [replacementFromAfter = null, ...after] = state.after;
  const before = [...state.before];
  const replacement = replacementFromAfter ?? before.pop() ?? null;
  const sentiment = { ...state.sentiment };
  delete sentiment[focused];

  return {
    ...state,
    before,
    after,
    dismissed: state.dismissed.includes(focused) ? state.dismissed : [...state.dismissed, focused],
    sentiment,
    slots: {
      ...state.slots,
      center: replacement,
    },
  };
}

export function currentTonightLeader(state: TonightNineState): string | null {
  let leader: string | null = null;
  let leaderScore = 0;
  for (const [id, score] of Object.entries(state.sentiment)) {
    if (score > leaderScore) {
      leader = id;
      leaderScore = score;
    }
  }
  return leader;
}

export function isTonightExhausted(state: TonightNineState): boolean {
  return visibleTonightIds(state).length === 0 && state.after.length === 0 && state.before.length === 0;
}
