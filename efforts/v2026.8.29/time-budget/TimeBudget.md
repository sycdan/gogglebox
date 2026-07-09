# Time Budget

## Overview

Let the room say how much time it has tonight and make the deck respect it.
Budget input is direct in v1: a stepper operated by button presses — no text
input, per the controller-first bans in
[input-model](../input-model/InputModel.md). The budget acts twice: as a hard
pre-score cutoff filter (items that cannot fit tonight never enter the deck)
and as the soft fits-time-budget signal in
[recommendation-core](../recommendation-core/RecommendationCore.md) (items
that fit comfortably score better, with a renderable reason). Inferring the
budget from playback-history session rhythms is v2.

## Goals

- Direct budget input via a stepper — button presses only, no text entry.
- Hard time-budget cutoff as a pre-score filter.
- Soft fits-time-budget signal contributing to the score with a reason.

## Nongoals

- No inferred budgets from playback-history session rhythms — recorded here as
  the v2 direction, not part of this effort.
- No watch-plan (score-maximal multi-episode sequences under the budget) —
  deferred per the parent ledger.
- No free-text or clock-time entry UI.

## Acceptance Criteria

1. [ ] [proof](./.artifacts/019f46d2-e57a-752b-a962-d8965b3ddd2b-proof.md) that the party can set tonight's time budget with a stepper operated entirely by button presses (controller and keyboard), with no text input involved.
2. [ ] [proof](./.artifacts/019f46d2-e6b3-73a4-9313-d02fed6afc66-proof.md) that the hard time-budget cutoff runs as a pre-score filter: items that cannot fit the budget never appear in the dealt deck.
3. [ ] [proof](./.artifacts/019f46d2-e7f2-72a8-81a4-ea3532dbca39-proof.md) that a soft fits-time-budget signal is registered in the signal registry and contributes to scoring with a renderable reason on items it favors.
