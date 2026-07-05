---
prompt_id: 019f2fcd-5ccf-7cbc-bec2-d9eff9226016
target_agent: gogglebox-builder
effort_path: efforts/auth-refactor/AuthRefactor.md
output_path: efforts/auth-refactor/.outputs/019f2fcd-5ccf-7cbc-bec2-d9eff9226016.md
base_tag: handoff/019f2fcd-5ccf-7cbc-bec2-d9eff9226016
session_name: auth-refactor.1783213415717
---

First instruction: `cd` into `./sessions/auth-refactor.1783213415717` before
anything else. Run all commands and commits from there.

## Context

Effort spec: `efforts/auth-refactor/AuthRefactor.md`. Implementation is already
merged and passing typecheck/tests. Two prover passes have visually confirmed
criteria 1, 3, and 4. Criteria 2, 5, and the UAT half of criterion 6 remain only
partially proved because the e2e flows are missing specific coverage. Full
detail is in `efforts/auth-refactor/.outputs/019f2fb4-4adf-79a5-bab4-a0b51709881a.md`
— read it first.

## What to add (test/e2e code only — no application logic changes expected)

1. **Criterion 2** (`e2e/flows/group-pin.mjs` or wherever login happens): add a
   step that submits a deliberately invalid access token, asserts the login
   request is rejected with a clear error (4xx + visible `.error`-style text)
   and that the login form is still shown (no token persisted), and screenshots
   that error state.
2. **Criterion 5** (`e2e/flows/group-pin.mjs`, `confirmPinsAndMixed()` or
   equivalent): add one `shoot(page, 'group-pin-mixed-warning')` call right
   before/instead of the immediate "Confirm" click on the mixed-group warning
   modal, so there's a human-readable screenshot of the warning itself, not
   just a passing DOM assertion.
3. **Criterion 6 UAT half**: the existing `group-alias` flow hard-codes a
   two-primary sandbox fixture (fails against the real UAT config, which has
   one primary); `player-focus` hits a Playwright strict-mode selector
   ambiguity (two Play/Resume buttons match) against the real, larger library.
   Add or adjust a flow so a `player-handoff`-style click-through can complete
   against real UAT data without assuming sandbox-only fixture shapes or an
   unambiguous single Play/Resume button — e.g. scope the locator more
   specifically (by title/card) or pick the first match deliberately, and avoid
   asserting a fixed primary-user count.

## Constraints

- Don't change the login/warning/token application logic — these criteria are
  about the app already doing the right thing; you're closing gaps in what the
  e2e suite exercises and screenshots.
- Verify your changes actually run: `docker compose run --rm check`,
  `docker compose run --rm test`, and a sandbox run
  (`./scripts/sbx.sh run --rm proof` with the relevant `PROOF_FLOW`) at minimum.
  UAT verification against the real Jellyfin is a bonus if reachable from this
  environment, but sandbox-clean is the bar.

## Output

Write your final summary — what you changed, what you verified, and any
criterion still not closeable and why — to
`efforts/auth-refactor/.outputs/019f2fcd-5ccf-7cbc-bec2-d9eff9226016.md`.
