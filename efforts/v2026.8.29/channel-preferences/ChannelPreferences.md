# Channel Preferences

## Overview

Add a gear-driven configuration surface that lets a household choose which
recommendation channels feed the rail.

## Goals

- Support an arbitrary number of recommendation channels from the backend
  contract.
- Let users enable and disable channels without leaving the home experience.
- Persist the selected channels for the household or group context.

## Nongoals

- Do not define new ranking strategies.
- Do not implement reroll or search behavior.
- Do not add administrator-only configuration.

## Acceptance Criteria

1. [ ] [proof](./.proofs/019f2aa8-491a-7472-b95c-ea38cdb105a0.md) that the recommendation rail has a gear action that opens channel preferences.
2. [ ] [proof](./.proofs/019f2aa8-491b-722a-9393-2183eed11644.md) that channel preferences list all available recommendation channels returned by the backend.
3. [ ] [proof](./.proofs/019f2aa8-491d-7f41-a32d-3085b20856c8.md) that enabling or disabling channels changes which channels contribute to the rail and survives a page reload.
