// Stage A/B handoff: drive Jellyfin-web (rendered in a SAME-ORIGIN iframe) into
// actual VIDEO PLAYBACK.
//
// Why this exists: opening `/player/web/index.html#/details?id=...` only lands on
// the item DETAILS page — jellyfin-web has no reliable URL/route that auto-STARTS
// playback (the /video route is just the OSD for an already-playing item; play is
// triggered by JS `playbackManager.play()`, normally from a click). Because gbx
// and Jellyfin-web are the SAME ORIGIN, the parent can reach into the iframe's
// document and dispatch a real click on the details page's primary Play button.
//
// The details page's primary play control in JF 10.9.11 is an ICON-ONLY button
// (no "Play" text), so class-selector matching alone is brittle. We discover it
// by class selectors OR a play_arrow material-icon OR aria-label/title ~ /play|
// resume/ OR data-action in {play,resume,playallfromhere}, preferring a VISIBLE,
// enabled control inside the detail header / .mainDetailButtons.
//
// This module is the pure, DOM-surface-only logic (no React, no real window) so
// it can be unit-tested against a fake document.

// Class selectors for the details PRIMARY play/resume control. These are scoped
// to the detail HEADER at match time (see HEADER_CONTAINERS) so we never pick up
// the per-episode card-overlay play buttons in the "More from Season N" rail.
export const PLAY_BUTTON_SELECTORS = [
  '.btnPlay',
  '[data-action="resume"]',
  '[data-action="play"]',
  '[data-action="playallfromhere"]',
  '.detailFloatingButton',
  'button[title="Play"]',
  '.mainDetailButtons .btnPlay',
];

// The detail-header scopes that hold the PRIMARY item actions. A play candidate
// MUST live inside one of these — this is what distinguishes the header play
// button (the hash item) from episode/card-rail overlay play buttons.
const HEADER_CONTAINERS = [
  '.mainDetailButtons',
  '.detailPagePrimaryContainer',
  '.detailButtons',
];

// Containers that mean "this is a CARD/RAIL control, NOT the header play". A
// candidate inside any of these is rejected even if it also matches a play
// selector — e.g. the cardOverlayFab "resume" button on an episode card would
// otherwise launch the wrong episode (S01E01 instead of the hash item).
const EXCLUDED_CONTAINERS = [
  '.itemsContainer',
  '.cardOverlayButton',
  '.cardOverlayFab',
  '.cardOverlayButton-br',
  '.card',
  '.verticalSection',
  '.itemsContainer-tv',
  '.scrollSlider',
];

const PLAY_DATA_ACTIONS = new Set(['play', 'resume', 'playallfromhere']);

// Minimal element surface we need — keeps this testable without a real DOM.
export interface ClickableEl {
  tagName?: string;
  click?: () => void;
  dispatchEvent?: (event: unknown) => boolean;
  getBoundingClientRect?: () => { width: number; height: number };
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => ClickableEl | null;
  querySelector?: (selector: string) => ClickableEl | null;
  disabled?: boolean;
  textContent?: string | null;
  className?: string;
}

export interface DocumentLike {
  querySelector(selector: string): ClickableEl | null;
  querySelectorAll(selector: string): ArrayLike<ClickableEl>;
}

function toArray(list: ArrayLike<ClickableEl> | null | undefined): ClickableEl[] {
  if (!list) return [];
  return Array.prototype.slice.call(list);
}

function attr(el: ClickableEl, name: string): string {
  try {
    return (el.getAttribute?.(name) ?? '') || '';
  } catch {
    return '';
  }
}

function isVisible(el: ClickableEl): boolean {
  if (typeof el.getBoundingClientRect !== 'function') return true; // can't measure -> assume visible
  try {
    const r = el.getBoundingClientRect();
    return !!r && (r.width > 0 || r.height > 0);
  } catch {
    return true;
  }
}

function isEnabled(el: ClickableEl): boolean {
  if (el.disabled === true) return false;
  if (attr(el, 'disabled')) return false;
  if (attr(el, 'aria-disabled') === 'true') return false;
  return true;
}

function inAnyContainer(el: ClickableEl, selectors: string[]): boolean {
  if (typeof el.closest !== 'function') return false;
  for (const sel of selectors) {
    try {
      if (el.closest(sel)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

// A play control is acceptable only if it lives in the detail HEADER and NOT in a
// card/rail container. This is the core fix for "wrong item clicked": the header
// play button targets the hash item; card-overlay play buttons target individual
// episodes.
function isHeaderPlay(el: ClickableEl): boolean {
  if (inAnyContainer(el, EXCLUDED_CONTAINERS)) return false;
  return inAnyContainer(el, HEADER_CONTAINERS);
}

// A compact description of an element for logging.
export function describeEl(el: ClickableEl): string {
  const tag = (el.tagName ?? '').toLowerCase();
  const cls = attr(el, 'class') || el.className || '';
  const title = attr(el, 'title');
  const aria = attr(el, 'aria-label');
  const action = attr(el, 'data-action');
  const text = (el.textContent ?? '').trim().slice(0, 40);
  return `<${tag} class="${cls}" title="${title}" aria-label="${aria}" data-action="${action}" text="${text}">`;
}

// True if this element looks like a play/resume control by icon/aria/title/action.
function looksLikePlay(el: ClickableEl): boolean {
  const action = attr(el, 'data-action').toLowerCase();
  if (PLAY_DATA_ACTIONS.has(action)) return true;

  const aria = attr(el, 'aria-label');
  const title = attr(el, 'title');
  if (/^\s*(play|resume)/i.test(aria) || /^\s*(play|resume)/i.test(title)) return true;

  // Icon-only button: a descendant .material-icons whose text is play_arrow.
  if (typeof el.querySelector === 'function') {
    try {
      const icon = el.querySelector('.material-icons');
      if (icon && (icon.textContent ?? '').trim().toLowerCase() === 'play_arrow') return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export interface PlayCandidate {
  el: ClickableEl;
  via: string; // how it was discovered (selector or heuristic)
  // True when the control lives in the detail header (the primary item action) —
  // always true for a returned candidate, since header scope is now required.
  preferred: boolean;
}

export interface DiscoveryResult {
  candidate: PlayCandidate | null;
  // Per class-selector match counts, for logging.
  selectorCounts: Record<string, number>;
  // When nothing matched: every button/anchor in the doc, described, for logging.
  enumerated: string[] | null;
}

// Find the best play/resume control. Returns the candidate plus diagnostics. Pure
// (no clicking) so it's fully unit-testable and the caller can log before acting.
export function discoverPlayControl(doc: DocumentLike): DiscoveryResult {
  const selectorCounts: Record<string, number> = {};
  const matches: PlayCandidate[] = [];
  const hiddenHeaderMatches: PlayCandidate[] = [];

  // 1. Class selectors — but ONLY accept matches in the detail header (not in a
  // card/rail). selectorCounts records the RAW count for diagnostics.
  for (const selector of PLAY_BUTTON_SELECTORS) {
    let els: ClickableEl[] = [];
    try {
      els = toArray(doc.querySelectorAll(selector));
    } catch {
      els = [];
    }
    selectorCounts[selector] = els.length;
    for (const el of els) {
      if (isVisible(el) && isEnabled(el) && isHeaderPlay(el)) {
        matches.push({ el, via: `selector:${selector}`, preferred: true });
      } else if (isEnabled(el) && isHeaderPlay(el)) {
        hiddenHeaderMatches.push({ el, via: `hidden-selector:${selector}`, preferred: true });
      }
    }
  }

  // 2. Heuristic scan of buttons + anchors for icon/aria/title/data-action —
  // again ONLY within the detail header (excludes card-overlay play buttons).
  let controls: ClickableEl[] = [];
  try {
    controls = toArray(doc.querySelectorAll('button, a, [data-action]'));
  } catch {
    controls = [];
  }
  for (const el of controls) {
    if (!isEnabled(el)) continue;
    if (isVisible(el) && looksLikePlay(el) && isHeaderPlay(el)) {
      matches.push({ el, via: 'heuristic:play-like', preferred: true });
    } else if (looksLikePlay(el) && isHeaderPlay(el)) {
      hiddenHeaderMatches.push({ el, via: 'hidden-heuristic:play-like', preferred: true });
    }
  }

  if (matches.length === 0 && hiddenHeaderMatches.length > 0) {
    return { candidate: hiddenHeaderMatches[0], selectorCounts, enumerated: null };
  }

  if (matches.length === 0) {
    // Enumerate every button/anchor so the caller can log the real controls.
    let all: ClickableEl[] = [];
    try {
      all = toArray(doc.querySelectorAll('button, a'));
    } catch {
      all = [];
    }
    return { candidate: null, selectorCounts, enumerated: all.map(describeEl) };
  }

  // Class-selector matches are listed before heuristic ones; the first is the
  // header's primary play. (All matches are header-scoped by construction.)
  return { candidate: matches[0], selectorCounts, enumerated: null };
}

// Click an element once. Prefer native .click(), which is what Jellyfin's button
// handlers respond to most consistently, and fall back to a bubbling MouseEvent
// bound to the iframe's own realm only if native click fails. Do not fire both:
// Jellyfin can treat that as two play commands and start overlapping streams.
export function clickEl(el: ClickableEl, makeMouseEvent: () => unknown): boolean {
  try {
    el.click?.();
    return true;
  } catch {
    /* fall back to dispatch */
  }
  try {
    el.dispatchEvent?.(makeMouseEvent());
    return true;
  } catch {
    return false;
  }
}

// True if a video is genuinely playing OR the video OSD/player chrome is present.
export interface VideoLike {
  paused?: boolean;
  currentTime?: number;
}
export interface PlaybackProbe {
  video: VideoLike | null;
  osdPresent: boolean;
}
export function isPlaybackStarted(probe: PlaybackProbe): boolean {
  if (probe.osdPresent) return true;
  const v = probe.video;
  return !!v && v.paused === false && typeof v.currentTime === 'number' && v.currentTime > 0;
}
