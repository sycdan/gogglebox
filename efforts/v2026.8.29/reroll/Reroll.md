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

1. [ ] [proof](./.proofs/25b5a009-7ad6-412f-9f86-f0c75bf9272f.md) that the recommendation rail has a dice action for rerolling results.
2. [ ] [proof](./.proofs/7baf1308-366a-4c84-a7d8-bcf660ba3b90.md) that reroll returns a different recommendation set across repeated uses when the seeded sandbox has enough eligible items.
3. [ ] [proof](./.proofs/d430bba4-9b08-48b6-bbaa-156429de9d2e.md) that reroll only draws from currently enabled recommendation channels.
