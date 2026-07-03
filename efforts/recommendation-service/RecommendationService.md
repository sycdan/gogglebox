# Recommendation Service

## Overview

Shape a recommendation service for Gogglebox that can suggest what a household
or group should watch next.

## Goals

- Define the recommendation inputs, ranking signals, and output contract.
- Keep recommendations explainable enough for users to trust the suggestions.
- Allow the service to evolve without coupling the UI to one ranking strategy.

## Nongoals

- Do not call paid external AI or recommendation APIs unless a later effort
  explicitly approves that dependency.
- Do not replace existing browse and search workflows.

## Acceptance Criteria

1. [ ] The effort documents the first recommendation strategy, including inputs, ranking rules, and expected API response shape. [proof](./proofs/b79272b1-afb6-4d5e-a492-f24d5f0c4401.md)
2. [ ] The backend exposes a recommendation endpoint that returns deterministic recommendations for a seeded sandbox dataset. [proof](./proofs/5eb96ae3-c38f-4847-8a0a-cc86b4f358d3.md)
3. [ ] The UI presents recommendations with enough explanation for a household to understand why each item was suggested. [proof](./proofs/b95f5631-b7de-4b5a-9071-9ca0f5e8af38.md)
