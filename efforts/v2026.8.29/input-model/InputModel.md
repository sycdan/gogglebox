# Input Model

## Overview

[Judgement Day](../V2026.8.29.md) is controller-first: one **spatial focus
engine** with two adapters — keyboard (arrows/Enter) and gamepad — while
mouse/touch remain progressive enhancement. Gamepads use the W3C Gamepad API;
Xbox-style pads get the `"standard"` mapping, polled via requestAnimationFrame
with edge detection and key-repeat for held d-pad, behind a "press any button"
gate that satisfies Chrome's gesture requirement. Controller-first bans
hover-dependent UI and text-input-dependent flows: elicitation answers are
button presses, never text; budget input is a stepper.

Navigation is **one driver, N voters**: single shared focus, driven by the
last-active pad; parallel multi-pad input happens only at explicit vote/answer
moments (v1.5). The handoff seam is explicit: gamepad support ends at the
`/player` Jellyfin-web boundary — Jellyfin-web's own gamepad behavior is
unverified, pads are expected to go down after choosing anyway, and playback
control may be keyboard/mouse/remote.

## Goals

- One spatial focus engine, adapters for keyboard and gamepad, mouse/touch as
  progressive enhancement.
- Gamepad support: standard mapping, rAF polling with edge detection and
  key-repeat, press-any-button gate.
- Button map: d-pad = deck nav, A = play focused, B = back, X =
  not-for-us/veto, Start = play the hero immediately, LB/RB = page where
  applicable.
- One-driver rule: last-active pad drives the single shared focus.
- Enforce the hover-ban and text-input-ban as testable constraints.
- State and verify the `/player` handoff seam.

## Nongoals

Deferred to v1.5 (specced here for later ordering, not part of this effort's
done-ness):

- Claim-to-join party formation ("Alice — press A to join"): pad index bound
  to a viewer, giving facts `own-pad` provenance.
- Parallel elicitation answers across pads.
- Attributed vetoes per pad.

Also out of scope:

- Phone-as-controller (v1.5+ per the parent ledger).
- Gamepad support inside Jellyfin-web beyond the `/player` seam.
- Swipe/Tinder-style gesture protocol (dropped).

## Acceptance Criteria

1. [ ] [proof](./.artifacts/019f46d2-de19-74f8-b576-f600bfb841fd-proof.md) that a single spatial focus engine drives the deck surface through both a keyboard adapter (arrows/Enter) and a gamepad adapter, with mouse/touch still working as progressive enhancement, and that no flow in the deck surface depends on hover or free-text input (elicitation answers are button presses; budget input is a stepper).
2. [ ] [proof](./.artifacts/019f46d2-df4e-72b1-99a7-5c8d6a4e5539-proof.md) that gamepad input uses the W3C Gamepad API with the `"standard"` mapping for Xbox-style pads, polled via requestAnimationFrame with edge detection and key-repeat for held d-pad, behind a press-any-button gate that satisfies the browser gesture requirement.
3. [ ] [proof](./.artifacts/019f46d2-e08d-7869-88f7-2fccfcfebd0c-proof.md) that the button map works end-to-end: d-pad navigates the deck, A plays the focused item, B goes back, X triggers not-for-us/veto, Start immediately plays the hero, and LB/RB page where applicable.
4. [ ] [proof](./.artifacts/019f46d2-e1c2-7fe3-a69e-444a49d720f2-proof.md) that with multiple pads connected the one-driver rule holds: the last-active pad drives one shared focus, with no parallel navigation outside explicit vote/answer moments.
5. [ ] [proof](./.artifacts/019f46d2-e307-7d9b-8c2c-f51912363b06-proof.md) that the `/player` handoff seam is explicitly documented (gamepad support ends at the Jellyfin-web boundary) and that Jellyfin-web's own gamepad behavior has been checked against the sandbox with the observed result recorded.
