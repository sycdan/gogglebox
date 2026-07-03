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

1. [ ] [proof](./.proofs/b79272b1-afb6-4d5e-a492-f24d5f0c4401.md) that the effort documents the first recommendation strategy, including inputs, ranking rules, and expected API response shape.
2. [ ] [proof](./.proofs/5eb96ae3-c38f-4847-8a0a-cc86b4f358d3.md) that the backend exposes a recommendation endpoint that returns deterministic recommendations for a seeded sandbox dataset.
3. [ ] [proof](./.proofs/68401bcb-6fe4-44c8-9a3c-ab7ae493167b.md) that each recommendation response item includes enough structured explanation data for the client to render a user-facing reason.
