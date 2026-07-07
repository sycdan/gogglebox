---
prompt_id: 019f2fdc-11a5-7efd-ac59-5d17f3e8b0a1
target_agent: gogglebox-prover
effort_path: efforts/auth-refactor/AuthRefactor.md
output_path: efforts/auth-refactor/.artifacts/019f2fdc-11a5-7efd-ac59-5d17f3e8b0a1-output.md
base_tag: handoff/019f2fdc-11a5-7efd-ac59-5d17f3e8b0a1
session_name: auth-refactor.1783214379729
---

First instruction: `cd` into `./sessions/auth-refactor.1783214379729` before
anything else. Run all commands from there.

## Context

`gogglebox-builder` just closed the remaining e2e coverage gaps for
`efforts/auth-refactor/AuthRefactor.md` (see
`efforts/auth-refactor/.artifacts/019f2fcd-5ccf-7cbc-bec2-d9eff9226016-output.md`):

- `e2e/flows/group-pin.mjs` now has an invalid-access-token rejection step
  (screenshot `group-pin-invalid-token.png`) and a `shoot()` call before the
  mixed-group warning modal's confirm click (`group-pin-mixed-warning.png`).
- A new flow `e2e/flows/player-uat.mjs` completes a player click-through
  against real UAT Jellyfin data (`player-uat-06-jellyfin-frame.png` + others),
  verified by the builder against both sandbox and the real UAT Jellyfin
  (`.env.uat`/`config.uat.json`, `htpc.lan:8096`).

The builder verified these pass but, being read-only-on-`efforts/`-only for
proof docs, left the actual proof-doc updates and durable evidence to you. As
before: **copy every screenshot PNG you rely on into
`efforts/auth-refactor/.artifacts/` itself** (not gitignored) and reference that
copied path from the proof doc — never the ephemeral `./artifacts` path.

## What to close

1. **Criterion 2** — update
   `efforts/auth-refactor/.artifacts/019f2aa8-4931-7a1c-86ba-4785a38163c3-proof.md` to
   also cover invalid-token rejection using the new flow step. Run
   `PROOF_FLOW=group-pin` (sandbox), copy the invalid-token screenshot into
   `.artifacts/`, update the doc.
2. **Criterion 5** — update
   `efforts/auth-refactor/.artifacts/019f2aa8-4936-7965-b407-de265936e392-proof.md` with
   the new mixed-warning modal screenshot, copied into `.artifacts/`.
3. **Criterion 6** — update
   `efforts/auth-refactor/.artifacts/019f2aa8-4937-78c2-84fc-7c0eadca4372-proof.md` to
   cover the UAT half using the new `player-uat` flow. Run it against both
   sandbox and (if reachable from this environment) the real UAT Jellyfin at
   `.env.uat`/`config.uat.json`, copy the resulting screenshot(s) into
   `.artifacts/`, and update the doc to state clearly that both sandbox and UAT
   player click-through are now proved (or explain precisely what's still
   missing if UAT isn't reachable this time).

Criteria 1, 3, and 4 are already fully proved with durable evidence from the
prior pass — leave those proof docs as-is unless you spot something wrong.

## Output

Write your final summary — what you proved, which proof docs/PNGs you updated,
and whether all six criteria are now fully provable — to
`efforts/auth-refactor/.artifacts/019f2fdc-11a5-7efd-ac59-5d17f3e8b0a1-output.md`.
