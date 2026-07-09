# Recommendation Rail

## Overview

Build the proposal-deck surface for [Judgement Day](../V2026.8.29.md): the
algorithm makes its argument on one hero card at a time instead of a
capacity-paged rail. The hero card takes ~70-80% of the screen — art, title,
runtime, legible-from-couch reasons, and member vote pips. An on-deck strip
shows the next 3-5 deck items as small thumbnails (art + title only) for
recognition ("that one!") and calibration; on a phone the strip collapses to
pure one-at-a-time. A persistent resume slot sits outside the deck flow so
resume is always one action away, never buried. Pressing Start plays the hero
immediately — the north-star interaction.

This replaces the old slot-based action layout and the responsive
capacity-count paging model: the hero is always exactly one item and the strip
is simple overflow.

## Goals

- Render the hero card with everything a couch needs to say yes: art, title,
  runtime, reasons, member vote pips.
- Show the on-deck strip and collapse it cleanly on phones.
- Keep resume persistent, fixed, and outside the deck flow, with coherent
  mixed card semantics — episode cards (progress, Resume, scoped ignore) vs
  title cards (Start).
- Show deck position ("3 of 7") and offer deal-new-deck on exhaustion.
- Wire "Press Start plays the hero" end-to-end.
- Surface correction affordances on every card.

## Nongoals

- No channel configuration UI (dropped effort; see the parent ledger).
- No reroll control — deck advancement and deal-new-deck replace it.
- No infinite browse or autoplay dark patterns.
- Correction behavior (fact writes, deck effect) is specced in
  [correction-loop](../correction-loop/CorrectionLoop.md); this effort only
  guarantees the affordances are present on cards.
- Search result presentation belongs to
  [jellyfin-search](../jellyfin-search/JellyfinSearch.md).

## Acceptance Criteria

1. [ ] [proof](./.artifacts/019f46d2-d315-7d29-a871-a9d84a211fc8-proof.md) that the hero card occupies roughly 70-80% of the screen and renders art, title, runtime, legible-from-couch reasons, and member vote pips.
2. [ ] [proof](./.artifacts/019f46d2-d446-72f1-9e1a-1aedf163fc05-proof.md) that an on-deck strip shows the next 3-5 deck items as small thumbnails (art + title only), and that on a phone viewport the strip collapses to pure one-at-a-time.
3. [ ] [proof](./.artifacts/019f46d2-d57f-70fa-bb25-12e7672d477d-proof.md) that a persistent resume slot with fixed placement sits outside the deck flow whenever the party has in-progress items, with coherent mixed card semantics: episode cards show progress, Resume, and scoped ignore; title cards show Start.
4. [ ] [proof](./.artifacts/019f46d2-d6b9-727d-9d9d-3b15c412c149-proof.md) that the surface shows the deck position (e.g. "3 of 7") and, when the deck is exhausted, offers an explicit "deal new deck" action.
5. [ ] [proof](./.artifacts/019f46d2-d801-7418-8bcb-a4c2ea8008af-proof.md) that Press Start plays the hero end-to-end: from login, one Start press begins playback of the top recommendation.
6. [ ] [proof](./.artifacts/019f46d2-d938-76c2-9346-48d9c91b84d4-proof.md) that every card visibly carries the one-press correction affordances ("not for us" and "not tonight").
