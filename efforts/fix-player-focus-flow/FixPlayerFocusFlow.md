# Fix Player Focus Flow

## Overview

`e2e/flows/player-focus.mjs` proves the iframe-backed player modal is
keyboard-safe: opening it moves focus to the dialog (not the opener button),
locks page scroll, mounts the Jellyfin iframe, Space does not re-trigger the
opener, and Escape closes the modal. None of that behavior is in question.

The flow has a confirmed, pre-existing bug in the step that runs before any of
that verification: it locates its target Play/Resume button with a page-wide
`.or()` locator —

```js
const playButton = page
  .locator('.media-card button', { hasText: /^Play$/ })
  .first()
  .or(page.locator('.media-card button', { hasText: /^Resume$/ }).first());
```

— which becomes an ambiguous Playwright strict-mode match once more than one
`.media-card` on the page simultaneously has a visible Play or Resume button
(e.g. after `mark-all-watched` runs, or against a larger seeded/real library
with several resumable titles). This was reproduced twice with an identical
failure and non-zero exit — once inside `PROOF_FLOW=all` (after other flows
had mutated watched/continue-watching state) and once standalone via
`PROOF_FLOW=player-focus` against the exact same sandbox state — confirming
it is a flow-authoring bug in `player-focus.mjs` itself, not an all-flows
isolation/harness regression. See
`efforts/release-e2e-gate/.outputs/019f301a-1c2b-75ac-be64-a8f5e4d4ff49.md`
for the full repro record.

`e2e/flows/player-uat.mjs` already documents this exact class of bug in its
own file header and adopted a fix: instead of a page-wide `.or()`, it iterates
`.media-card` elements one at a time (`page.locator('.media-card').nth(index)`)
and scopes the Play/Resume button search to a single chosen card
(`card.locator('button', { hasText: /^(Play|Resume)$/ }).first()`), picking
the first card that has one (see `e2e/flows/player-uat.mjs` lines ~85-108).

## Goals

- Make `player-focus.mjs` locate its target Play/Resume button
  unambiguously, mirroring `player-uat.mjs`'s per-card-scoped selection
  pattern, so the flow passes reliably regardless of how many
  watched/resumable cards are present on the page.
- Preserve every behavior `player-focus.mjs` actually verifies after the
  button is located and clicked: dialog receives focus (not the opener),
  page scroll locks, the Jellyfin iframe mounts at the same-origin `/player`
  route, Space does not re-trigger the opener or scroll the page or close/
  reopen the dialog, and Escape closes the dialog and restores scroll.
- Verify the fix against the running sandbox stack in both the
  single-resumable-card case and a multi-resumable-card case (e.g. after
  running `mark-all-watched`), demonstrating the flow now passes reliably in
  both.

## Nongoals

- Changing what `player-focus.mjs` verifies (its focus/scroll-lock/iframe-
  mount/Space/Escape assertions) — only the button-locating step is in scope.
- Changing `player-uat.mjs`, `e2e/run.mjs`, sandbox provisioning, or any
  other flow.
- Adding new keyboard-safety assertions or otherwise expanding the flow's
  purpose beyond fixing the locator ambiguity.

## Acceptance Criteria

1. [x] [proof](./.proofs/019f307b-9663-7ef8-b19e-00344091e9f9.md)
   `player-focus.mjs`'s Play/Resume button lookup is rewritten to scope the
   search to a single chosen `.media-card` at a time (mirroring
   `player-uat.mjs`'s `nth(index)` iteration picking the first card whose
   scoped `button` locator matches `/^(Play|Resume)$/`), replacing the
   page-wide `.or()` locator, with no change to any assertion the flow makes
   after the button is located and clicked (dialog focus, scroll lock,
   iframe mount, Space no-op behavior, Escape close/scroll-restore all
   verified identically to before).
2. [ ] [proof](./.proofs/019f307b-b4d9-7c81-b3c3-32683aa3ffea.md) the fixed
   flow passes against the running sandbox stack in both of the following
   states, run via `PROOF_FLOW=player-focus ./scripts/sbx.sh run --rm proof`:
   (a) the clean/default sandbox state with a single resumable card, and (b)
   a state with multiple simultaneously-resumable cards (e.g. produced by
   running `PROOF_FLOW=mark-all-watched` first, or otherwise seeding more
   than one visible Play/Resume button), confirming the strict-mode
   ambiguity that previously failed the flow no longer occurs.
