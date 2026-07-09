# Correction Loop

## Overview

Passive correction beats elicitation for effort-to-value, so correction must
be effortless. Every card in the [Judgement Day](../V2026.8.29.md) deck
carries two one-press corrections: "not for us" (permanent-ish — the existing
ignore) and "not tonight" (session-soft). Both land as facts in the
[signal-facts](../signal-facts/SignalFacts.md) store and take effect on the
current deck immediately. In the controller context the X button is the
not-for-us/veto press.

## Goals

- Put one-press "not for us" and "not tonight" on every card.
- Record both corrections as facts with provenance.
- Apply corrections to the current deck immediately — no reload, no re-deal
  required.
- Map X to not-for-us/veto in the controller button map.

## Nongoals

- No attributed multi-pad vetoes — that is v1.5 (see
  [input-model](../input-model/InputModel.md)).
- No elicitation questions — that is
  [elicitation](../elicitation/Elicitation.md).
- No management UI for reviewing or undoing past corrections.

## Acceptance Criteria

1. [ ] [proof](./.artifacts/019f46d2-da6d-7523-84e2-a9d181f6982e-proof.md) that every card offers one-press "not for us" (permanent-ish ignore) and "not tonight" (session-soft), and each press is recorded as a fact with provenance.
2. [ ] [proof](./.artifacts/019f46d2-dba9-717a-83af-22a3631556db-proof.md) that in the controller context the X button triggers not-for-us/veto on the focused card.
3. [ ] [proof](./.artifacts/019f46d2-dcdf-71ff-b8c5-ab3dcb890c8f-proof.md) that a correction takes immediate effect on the current deck: the corrected item leaves the deck and the surface updates without a reload, and "not tonight" suppression lasts only for the session.
