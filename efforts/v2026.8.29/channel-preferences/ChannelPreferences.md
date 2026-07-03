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

1. [ ] [proof](./.proofs/049ae954-eb57-4ddf-ad76-c1495eaba9ac.md) that the recommendation rail has a gear action that opens channel preferences.
2. [ ] [proof](./.proofs/2997c7bc-5373-468d-84f5-533b42c40326.md) that channel preferences list all available recommendation channels returned by the backend.
3. [ ] [proof](./.proofs/b3e1ba45-fbfa-491a-8381-091ca5807a21.md) that enabling or disabling channels changes which channels contribute to the rail and survives a page reload.
