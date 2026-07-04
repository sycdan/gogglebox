# Recommendation Rail

## Overview

Replace the continue-watching section with the primary discovery rail while
preserving continue-watching as the first recommendation channel. The rail pages
recommendations according to the space available on the current device instead
of using a fixed item count.

## Goals

- Render recommendations from the backend endpoint in the home experience.
- Present clear recommendation explanations on each item.
- Keep the rail ready for channel controls, reroll, and search actions.
- Constrain the number of visible recommendations per page responsively, with a
  mobile phone layout showing one item per page.

## Nongoals

- Do not implement the channel configuration UI.
- Do not implement reroll randomization.
- Do not implement search filtering behavior; that belongs to the discovery rail
  search subeffort.

## Acceptance Criteria

1. [ ] [proof](./.proofs/019f2aa8-490c-726c-86e5-60da55bb52a7.md) that the UI presents recommendations with enough explanation for a household to understand why each item was suggested.
2. [ ] [proof](./.proofs/019f2aa8-490e-7e9a-9076-a4e46383bc11.md) that continue watching appears as a recommendation channel in the rail instead of as a separate home section.
3. [ ] [proof](./.proofs/019f2aa8-490f-76a8-b953-4e54827a0489.md) that the rail layout reserves stable top-left, middle, and top-right action slots for reroll, search, and channel preferences.
4. [ ] [proof](./.proofs/019f2aa8-4911-727c-9df8-6a5d06fd4677.md) that each rail page constrains the visible recommendation count based on responsive layout capacity rather than a hardcoded count, and that a mobile phone viewport shows one recommendation per page.
