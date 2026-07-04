# Recommendation Core

## Overview

Define and implement the first backend recommendation contract so the UI can
request explainable, deterministic recommendations without knowing the ranking
strategy internals.

## Goals

- Document the first recommendation strategy, inputs, ranking rules, and output
  response shape.
- Expose a backend endpoint that works against the seeded sandbox dataset.
- Include stable explanation data for each returned recommendation.

## Nongoals

- Do not add paid external recommendation or AI services.
- Do not build channel configuration UI.
- Do not randomize results; reroll behavior belongs to the reroll effort.

## Acceptance Criteria

1. [ ] [proof](./.proofs/019f2aa8-493f-7133-bde8-7c73e61e8d6d.md) that the effort documents the first recommendation strategy, including inputs, ranking rules, and expected API response shape.
2. [ ] [proof](./.proofs/019f2aa8-4941-7582-a896-943dd69b5c03.md) that the backend exposes a recommendation endpoint that returns deterministic recommendations for a seeded sandbox dataset.
3. [ ] [proof](./.proofs/019f2aa8-4943-74fe-9945-dad3754c53a2.md) that each recommendation response item includes enough structured explanation data for the client to render a user-facing reason.
