import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLAY_BUTTON_SELECTORS,
  ClickableEl,
  DocumentLike,
  clickEl,
  describeEl,
  discoverPlayControl,
  isPlaybackStarted,
} from './playerLaunch';

// --- tiny fake-DOM helpers -------------------------------------------------

interface FakeOpts {
  tag?: string;
  text?: string;
  disabled?: boolean;
  attrs?: Record<string, string>;
  rect?: { width: number; height: number };
  container?: string | null;
  children?: { _sel: string; textContent: string }[];
}

interface FakeEl extends ClickableEl {
  _clicks?: number;
  _dispatched?: number;
}

function el(opts: FakeOpts = {}): FakeEl {
  const attrs = opts.attrs ?? {};
  const children = opts.children ?? [];
  const container = opts.container ?? null;
  const node: FakeEl = {
    tagName: opts.tag ?? 'BUTTON',
    textContent: opts.text ?? '',
    disabled: opts.disabled ?? false,
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    getBoundingClientRect: () => opts.rect ?? { width: 100, height: 40 },
    closest: (sel: string) => (container === sel ? ({ tagName: 'DIV' } as ClickableEl) : null),
    querySelector: (sel: string) => {
      const found = children.find((c) => c._sel === sel);
      return found ? ({ textContent: found.textContent } as ClickableEl) : null;
    },
    click: () => {
      node._clicks = (node._clicks ?? 0) + 1;
    },
    dispatchEvent: () => {
      node._dispatched = (node._dispatched ?? 0) + 1;
      return true;
    },
  };
  return node;
}

function icon(text: string) {
  return { _sel: '.material-icons', textContent: text };
}

function makeDoc(registry: Record<string, ClickableEl[]>): DocumentLike {
  return {
    querySelector: (sel: string) => (registry[sel] && registry[sel][0]) || null,
    querySelectorAll: (sel: string) => registry[sel] ?? [],
  };
}

// --- isPlaybackStarted -----------------------------------------------------

test('isPlaybackStarted: OSD present counts as started', () => {
  assert.equal(isPlaybackStarted({ video: null, osdPresent: true }), true);
});

test('isPlaybackStarted: a playing video (currentTime>0, not paused) counts', () => {
  assert.equal(isPlaybackStarted({ video: { paused: false, currentTime: 0.5 }, osdPresent: false }), true);
});

test('isPlaybackStarted: a paused or unstarted video does NOT count', () => {
  assert.equal(isPlaybackStarted({ video: { paused: true, currentTime: 5 }, osdPresent: false }), false);
  assert.equal(isPlaybackStarted({ video: { paused: false, currentTime: 0 }, osdPresent: false }), false);
  assert.equal(isPlaybackStarted({ video: null, osdPresent: false }), false);
});

// --- discoverPlayControl ---------------------------------------------------

test('discoverPlayControl: finds a HEADER class-selector control and reports selector counts', () => {
  const btn = el({ attrs: { class: 'btnPlay' }, container: '.mainDetailButtons' });
  const doc = makeDoc({ '.btnPlay': [btn], 'button, a, [data-action]': [btn], 'button, a': [btn] });

  const res = discoverPlayControl(doc);
  assert.ok(res.candidate);
  assert.equal(res.candidate?.el, btn);
  assert.match(res.candidate!.via, /^selector:\.btnPlay$/);
  assert.equal(res.selectorCounts['.btnPlay'], 1);
  assert.equal(res.enumerated, null);
});

test('discoverPlayControl: finds an ICON-ONLY HEADER play button via play_arrow material-icon', () => {
  const iconBtn = el({
    tag: 'BUTTON',
    attrs: { class: 'paper-icon-button-light' },
    children: [icon('play_arrow')],
    container: '.detailPagePrimaryContainer',
  });
  const doc = makeDoc({ 'button, a, [data-action]': [iconBtn], 'button, a': [iconBtn] });

  const res = discoverPlayControl(doc);
  assert.ok(res.candidate, 'should discover the icon-only header play button');
  assert.equal(res.candidate?.el, iconBtn);
  assert.equal(res.candidate?.via, 'heuristic:play-like');
});

test('discoverPlayControl: matches a HEADER control by aria-label and by data-action', () => {
  const ariaBtn = el({ attrs: { 'aria-label': 'Play Episode 1' }, container: '.mainDetailButtons' });
  const docAria = makeDoc({ 'button, a, [data-action]': [ariaBtn], 'button, a': [ariaBtn] });
  assert.ok(discoverPlayControl(docAria).candidate);

  const actionBtn = el({ attrs: { 'data-action': 'resume' }, container: '.detailButtons' });
  const docAction = makeDoc({
    '[data-action="resume"]': [actionBtn],
    'button, a, [data-action]': [actionBtn],
    'button, a': [actionBtn],
  });
  const r = discoverPlayControl(docAction);
  assert.ok(r.candidate);
  assert.match(r.candidate!.via, /resume/);
});

test('discoverPlayControl: REJECTS a play control outside the detail header', () => {
  const stray = el({ attrs: { class: 'btnPlay', 'aria-label': 'Play' } }); // no container
  const doc = makeDoc({ '.btnPlay': [stray], 'button, a, [data-action]': [stray], 'button, a': [stray] });

  const res = discoverPlayControl(doc);
  assert.equal(res.candidate, null);
  assert.equal(res.selectorCounts['.btnPlay'], 1); // raw count still reported
});

// BUG 1 regression: the details page has BOTH a header .btnPlay (the hash item)
// AND card-overlay resume buttons in the "More from Season N" episode rail. The
// header one MUST win; the card-overlay ones MUST be ignored (they launch the
// wrong episode, e.g. S01E01 instead of the hash item S01E02).
test('discoverPlayControl: chooses the HEADER play over card-overlay resume buttons', () => {
  const headerPlay = el({ attrs: { class: 'btnPlay' }, container: '.mainDetailButtons' });
  const cardResume = el({
    attrs: { class: 'cardOverlayButton cardOverlayFab-primary', 'data-action': 'resume' },
    container: '.cardOverlayFab',
  });
  const cardResumeIcon = el({
    attrs: { class: 'cardOverlayButton', 'data-action': 'resume' },
    container: '.itemsContainer',
    children: [icon('play_arrow')],
  });

  const doc = makeDoc({
    '.btnPlay': [headerPlay],
    '[data-action="resume"]': [cardResume, cardResumeIcon],
    'button, a, [data-action]': [headerPlay, cardResume, cardResumeIcon],
    'button, a': [headerPlay, cardResume, cardResumeIcon],
  });

  const res = discoverPlayControl(doc);
  assert.ok(res.candidate);
  assert.equal(res.candidate?.el, headerPlay, 'header .btnPlay must be chosen, not a card-overlay resume');
  assert.match(res.candidate!.via, /\.btnPlay/);
});

test('discoverPlayControl: uses a hidden HEADER control as a last-resort fallback', () => {
  const hidden = el({ attrs: { class: 'btnPlay' }, rect: { width: 0, height: 0 }, container: '.mainDetailButtons' });
  const disabled = el({ attrs: { class: 'btnPlay', disabled: 'disabled' }, disabled: true, container: '.mainDetailButtons' });
  const doc = makeDoc({
    '.btnPlay': [hidden, disabled],
    'button, a, [data-action]': [hidden, disabled],
    'button, a': [hidden, disabled],
  });

  const res = discoverPlayControl(doc);
  assert.equal(res.candidate?.el, hidden);
  assert.match(res.candidate!.via, /^hidden-selector:/);
  assert.equal(res.enumerated, null);
});

test('discoverPlayControl: prefers a visible HEADER control over a hidden fallback', () => {
  const hidden = el({ attrs: { class: 'btnPlay' }, rect: { width: 0, height: 0 }, container: '.mainDetailButtons' });
  const visible = el({ attrs: { class: 'btnPlay' }, container: '.mainDetailButtons' });
  const doc = makeDoc({
    '.btnPlay': [hidden, visible],
    'button, a, [data-action]': [hidden, visible],
    'button, a': [hidden, visible],
  });

  const res = discoverPlayControl(doc);
  assert.equal(res.candidate?.el, visible);
  assert.match(res.candidate!.via, /^selector:/);
});

test('discoverPlayControl: no candidate enumerates all buttons/anchors for diagnostics', () => {
  const a = el({ tag: 'BUTTON', attrs: { class: 'btnMore', title: 'More' }, text: 'More' });
  const b = el({ tag: 'A', attrs: { class: 'navlink' }, text: 'Home' });
  const doc = makeDoc({ 'button, a, [data-action]': [a, b], 'button, a': [a, b] });

  const res = discoverPlayControl(doc);
  assert.equal(res.candidate, null);
  assert.equal(res.enumerated?.length, 2);
  assert.match(res.enumerated![0], /class="btnMore"/);
  assert.match(res.enumerated![0], /title="More"/);
});

test('discoverPlayControl: a throwing querySelectorAll for one selector does not abort', () => {
  const good = el({ attrs: { 'data-action': 'play' }, container: '.mainDetailButtons' });
  const doc: DocumentLike = {
    querySelector: () => null,
    querySelectorAll: (sel: string) => {
      if (sel === PLAY_BUTTON_SELECTORS[0]) throw new Error('boom');
      if (sel === '[data-action="play"]') return [good];
      if (sel === 'button, a, [data-action]') return [good];
      return [];
    },
  };
  const res = discoverPlayControl(doc);
  assert.ok(res.candidate);
  assert.equal(res.candidate?.el, good);
});

// --- clickEl + describeEl --------------------------------------------------

test('clickEl: fires one native click without also dispatching a MouseEvent', () => {
  const node = el({ attrs: { class: 'btnPlay' } });
  const result = clickEl(node, () => ({}));
  assert.equal(result, true);
  assert.equal(node._clicks, 1);
  assert.equal(node._dispatched ?? 0, 0);
});

test('clickEl: falls back to realm MouseEvent dispatch if native click fails', () => {
  const node = el({ attrs: { class: 'btnPlay' } });
  node.click = () => {
    throw new Error('wrong realm');
  };
  const result = clickEl(node, () => ({}));
  assert.equal(result, true);
  assert.equal(node._clicks ?? 0, 0);
  assert.equal(node._dispatched, 1);
});

test('describeEl: produces a readable tag/class/title/aria/action/text summary', () => {
  const node = el({
    tag: 'BUTTON',
    attrs: { class: 'btnPlay', title: 'Play', 'aria-label': 'Play', 'data-action': 'play' },
    text: 'Play',
  });
  const desc = describeEl(node);
  assert.match(desc, /^<button /);
  assert.match(desc, /class="btnPlay"/);
  assert.match(desc, /data-action="play"/);
});
