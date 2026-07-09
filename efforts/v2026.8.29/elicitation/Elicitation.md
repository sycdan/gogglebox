# Elicitation

## Overview

Ask the room at most one micro-question at login time, answerable with one
button press, skippable forever without nagging. Question selection targets
the highest-value gap: highest candidacy × fewest facts for the present
members. Answers land as `elicited-*` facts in
[signal-facts](../signal-facts/SignalFacts.md) and affect the very next
recommendation request — no daemon, no batch job. Elicitation is deliberately
last among the [Judgement Day](../V2026.8.29.md) subefforts: it needs facts,
the deck, and the correction loop live first, and passive correction beats
elicitation for effort-to-value.

## Goals

- One optional micro-question at login, maximum one per login.
- One-press answers only — never text (controller-first constraint).
- Skippable forever with zero nagging or repeated pestering.
- Select the question by highest candidacy × fewest facts for present members.
- Answers recorded as facts and reflected in the next request.

## Nongoals

- No questionnaires, onboarding wizards, or multi-question flows.
- No mandatory answers — the zero-config floor means never blocking on a
  question.
- No parallel multi-pad answers — v1.5 (see
  [input-model](../input-model/InputModel.md)).

## Acceptance Criteria

1. [ ] [proof](./.artifacts/019f46d2-e933-7de3-b256-b34c28b93001-proof.md) that login surfaces at most one micro-question, answerable with a single button press, and that skipping is one press, permanent for that question, and never produces nagging on later logins.
2. [ ] [proof](./.artifacts/019f46d2-ea90-706f-b0db-f188f437618e-proof.md) that question selection picks the highest candidacy × fewest facts question for the present members.
3. [ ] [proof](./.artifacts/019f46d2-ebd8-75d5-b0ea-7a6d32cafc85-proof.md) that an answer lands as an `elicited-*` fact and measurably affects the very next recommendation request.
