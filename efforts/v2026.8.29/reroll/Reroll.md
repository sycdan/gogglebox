# Reroll (Withdrawn)

## Overview

**This effort is dissolved.** The 2026-07 Judgement Day design exploration
replaced the reroll concept entirely with deck mechanics: a deterministic
seeded deck dealt from the top-K score-weighted candidates, deck advancement,
and an explicit "deal new deck" on exhaustion (logged as a strong
dissatisfaction fact). That resolves the old determinism-vs-reroll
contradiction. The behavior now lives in
[recommendation-core](../recommendation-core/RecommendationCore.md) (deck
contract) and [recommendation-rail](../recommendation-rail/RecommendationRail.md)
(deck position and deal-new-deck surface). See the parent
[Judgement Day](../V2026.8.29.md) spec.

This spec is kept for history only. There is no live work here.

## Nongoals

- Everything previously in scope: the dice action, randomized re-draws, and
  channel-bounded randomization are all withdrawn.

## Acceptance Criteria

The former acceptance criteria (dice action; different set across repeated
rerolls; draws only from enabled channels) are withdrawn unproven — the effort
was dissolved before any were checked, and no proof will be produced. Its
replacement is covered by the deck-contract and deck-surface acceptance
criteria in recommendation-core and recommendation-rail.
