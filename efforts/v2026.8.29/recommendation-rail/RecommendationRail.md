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

1. [ ] [proof](./.proofs/b95f5631-b7de-4b5a-9071-9ca0f5e8af38.md) that the UI presents recommendations with enough explanation for a household to understand why each item was suggested.
2. [ ] [proof](./.proofs/0407e1d9-9731-4172-b64d-5b9899fee977.md) that continue watching appears as a recommendation channel in the rail instead of as a separate home section.
3. [ ] [proof](./.proofs/f6560f01-dc5d-449a-baaf-1af677c4a888.md) that the rail layout reserves stable top-left, middle, and top-right action slots for reroll, search, and channel preferences.
4. [ ] [proof](./.proofs/f6a52904-0b4d-413c-8d72-30c44d955516.md) that each rail page constrains the visible recommendation count based on responsive layout capacity rather than a hardcoded count, and that a mobile phone viewport shows one recommendation per page.
