---
prompt_id: 019f301a-1c2b-75ac-be64-a8f5e4d4ff49
target_agent: gogglebox-builder
effort_path: efforts/release-e2e-gate/ReleaseE2eGate.md
output_path: efforts/release-e2e-gate/.artifacts/019f301a-1c2b-75ac-be64-a8f5e4d4ff49-output.md
base_tag: handoff/019f301a-1c2b-75ac-be64-a8f5e4d4ff49
session_name: release-e2e-gate.1783218456534
---

First: `cd ./sessions/release-e2e-gate.1783218456534` before doing anything
else. Make all edits, commands, and commits from inside that worktree.

# Phase: implement AC1 + AC2 of release-e2e-gate

Read `efforts/release-e2e-gate/ReleaseE2eGate.md` in full for context
(Overview, Goals, Nongoals) before starting. This handoff covers only these
two acceptance criteria:

**AC1** — `e2e/run.mjs` supports an all-flows invocation that runs every flow
in the `flows` array in existing dispatch order. Requirements:
- Must not change the meaning of any existing single-flow invocation
  (`PROOF_FLOW=<name>` for one of the 14 flows keeps working exactly as
  today).
- Exact mechanism/name is your call (e.g. a reserved `PROOF_FLOW=all` value
  that bypasses the per-flow `match` regex filter and runs every flow
  unconditionally).
- Must isolate each flow: fresh browser page/context/session (or equivalent
  cleanup boundary) per flow, so route interception, localStorage/session
  state, selected account, and per-flow mutations from one flow cannot leak
  into the next. Pay particular attention to `group-pin` (patches
  `/api/session`) and `player-handoff` (requires the same-origin proxy
  target).
- Exercise the all-flows mode locally (or in a scratch CI run) against the
  sandbox stack through `PROOF_URL=http://proxy:8080` and confirm it
  completes with a non-zero exit only when a flow genuinely fails.

**AC2** — Confirm (don't just assume) that a flow's existing `fail()` call
(assertion failure) already propagates as a non-zero process exit from
`e2e/run.mjs` today, with no new error-propagation code required. This is a
verification task: read the code path, and/or deliberately trigger a `fail()`
in a scratch run and observe the exit code, then document what you found.

## Scope

You may edit `e2e/run.mjs`, files under `e2e/lib/`, and files under
`e2e/flows/` only if strictly necessary to satisfy isolation (avoid touching
flow authoring behavior per the effort's Nongoals — flows should not need to
change just because all-flows mode exists). Do not touch
`.github/workflows/publish.yml` (that's AC3-7, a separate phase). Do not
touch sandbox provisioning (`tools/sandbox/`, `docker-compose.sbx.yml`)
unless something there genuinely blocks running all-flows mode — if so, keep
it minimal and call it out explicitly in your output.

Use `./scripts/sbx.sh` for all sandbox stack commands, per AGENTS.md. Never
run `npm`/`node`/`tsc` on the host.

## Output

When AC1 and AC2 are satisfied (or you are blocked), write your final summary
to `efforts/release-e2e-gate/.artifacts/019f301a-1c2b-75ac-be64-a8f5e4d4ff49-output.md`.
Include: what you changed and why, the exact all-flows invocation syntax you
landed on, evidence the isolation requirement holds (especially for
`group-pin` and `player-handoff`), and your findings for AC2 (fail() exit
code confirmation). Do not write proof files under `.artifacts/` yourself —
that's the approver's job after visual proof; just report your findings in
the output file.
