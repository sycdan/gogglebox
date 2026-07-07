---
prompt_id: 019f2f9e-2acd-735e-bbce-7af071a5a490
target_agent: gogglebox-verifier
effort_path: efforts/auth-refactor/AuthRefactor.md
output_path: efforts/auth-refactor/.artifacts/019f2f9e-2acd-735e-bbce-7af071a5a490-output.md
base_tag: handoff/019f2f9e-2acd-735e-bbce-7af071a5a490
session_name: auth-refactor.1783210322614
---

First instruction: `cd` into `./sessions/auth-refactor.1783210322614` before doing
anything else. Make all commands and any commits from there.

## Context

Effort spec: `efforts/auth-refactor/AuthRefactor.md`. An implementation for this
effort already exists (previously done on an off-convention branch, now brought
into this session branch by the orchestrator per the standard worktree
convention). Your job is verification only — you do not implement anything new.

## Acceptance criteria in scope

1. Config supports `accounts[account_key] = account_config` and
   `access_tokens[token] = account_key`, validates token uniqueness, and
   migrates older supported config versions automatically on startup.
2. Portal login accepts a valid access token, rejects invalid tokens with a
   clear error, and stores the token locally until logout clears it.
3. Account users render as primary users selected by default with avatars,
   secondary users visible and unselected by default, and an add-guest control
   matching avatar sizing.
4. The add-guest flow lists eligible tertiary users, requires PIN entry for
   each selected guest that needs one, and prevents confirmation until required
   PINs are valid.
5. Continuing with a group that contains non-primary users shows a
   confirmation warning that watch progress will be affected for every user in
   the group.
6. Existing group selection and Jellyfin player handoff continue to work for
   token-authenticated accounts in both sandbox proof and real-data UAT where
   available.

## Phase: verification

Run typecheck and unit tests via the base Docker compose services
(`docker compose run --rm check`, `docker compose run --rm test`). You are
read-only on source — do not edit application code. If failures are found,
report them precisely (failing file, test name, error text) so the orchestrator
can route a fix back to `gogglebox-builder`.

## Output

Write your final summary — pass/fail status, and any failing
check/test detail — to `efforts/auth-refactor/.artifacts/019f2f9e-2acd-735e-bbce-7af071a5a490-output.md`.
