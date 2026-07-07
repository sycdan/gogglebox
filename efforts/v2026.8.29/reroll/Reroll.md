# Reroll

## Overview

Add a dice action that requests a fresh randomized set of recommendations from
the currently available and enabled channels.

## Goals

- Provide a visible reroll control in the recommendation rail.
- Return a different recommendation set when enough eligible items exist.
- Keep randomization bounded to enabled channels and explainable item data.

## Nongoals

- Do not add channel preference controls.
- Do not replace deterministic default recommendation ordering.
- Do not randomize content outside the recommendation rail.

## Acceptance Criteria

1. [ ] [proof](./.artifacts/019f2aa8-492a-7fcd-bf0a-8e09dbd49299-proof.md) that the recommendation rail has a dice action for rerolling results.
2. [ ] [proof](./.artifacts/019f2aa8-492b-7fdb-9e5a-3e519461a0b4-proof.md) that reroll returns a different recommendation set across repeated uses when the seeded sandbox has enough eligible items.
3. [ ] [proof](./.artifacts/019f2aa8-492d-7967-866a-eeed2808eb5b-proof.md) that reroll only draws from currently enabled recommendation channels.
