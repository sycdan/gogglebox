# Release E2E Gate

## Overview

`.github/workflows/publish.yml` is the only place images get built and pushed
to GHCR: a version bump lands on main, its `test` job runs `npm run check` +
`npm test` (typecheck + unit tests only), and `publish` (`needs: test`) builds
and pushes on success. The full e2e/visual-proof flow suite
(`e2e/run.mjs` + the 14 flows under `e2e/flows/`) proves real user-facing
behavior against a running stack — auth, playback handoff, recommendations,
pagination, etc. — but today it is never run in CI at all: it's invoked
manually by a human or a prover agent against the sandbox (`./scripts/sbx.sh`)
or UAT (`./scripts/uat.sh`) stack during a specific feature's work. A published
image today is only proven not to fail typecheck/unit tests; it has never been
proven to actually work end to end before landing in the registry.

There is also a live footgun: `e2e/run.mjs` defaults `PROOF_FLOW` to `"app"`
when unset, and none of the 14 flows' `match` regexes match the literal string
`"app"` — so an argument-less proof invocation silently matches zero flows and
exits 0. There is no "run every flow in one invocation" mode today. This
effort adds one, and wires it into `publish.yml` so a broken flow blocks
publish exactly like a broken unit test does today.

**Job placement decision: a new `e2e` job, not folded into the existing
`test` job.** Today the actual pipeline is serialized as `gate -> test ->
publish`; there is no e2e job. This effort changes the proposed publish path
so both `test` and `e2e` depend on `gate`, and `publish` depends on both
(`publish: needs: [test, e2e]`). In GitHub Actions, that lets `test` and `e2e`
run at the same time after `gate` succeeds, subject to runner availability;
`publish` starts only after both have succeeded. The existing `test` job stays
fast and cheap (typecheck + unit tests, no Docker, no Jellyfin) so a quick
regression shows up quickly in the Actions UI without waiting on a slower
sandbox-stack e2e run; the two failure signals also stay easy to tell apart at
a glance (unit-test break vs. flow break) instead of being merged into one
job's log. The tradeoff accepted is using more concurrent runner minutes (two
jobs instead of one serialized), which is judged worth it for the
faster/clearer failure signal.

This effort does not touch `release.yml`, which promotes an already-built,
already-tested prerelease image to a clean `YYYY.M.D` tag without rebuilding
or retesting, and that guarantee (the released bits are byte-identical to
what publish.yml tested) is out of scope and must not change.

## Goals

- `e2e/run.mjs` gains a way to run every flow in the `flows` array in one
  invocation, in the existing dispatch order, without relying on the
  currently-broken `PROOF_FLOW` default. Exact mechanism/name is the
  implementer's call (e.g. a reserved `PROOF_FLOW=all` value that bypasses
  the per-flow `match` regex filter and runs every flow unconditionally);
  whatever is chosen must not change the meaning of any existing single-flow
  invocation (`PROOF_FLOW=<name>` for one of the 14 flows keeps working
  exactly as it does today). The all-flows mode must isolate flows from each
  other: each flow gets a fresh browser page/context/session or an equivalent
  cleanup boundary, so route interception, localStorage/session state, selected
  account, and per-flow mutations cannot leak into the next flow. This is
  especially important for `group-pin`, which intentionally patches
  `/api/session`, and for `player-handoff`, which requires the proxy origin.
- `publish.yml` gains a new `e2e` job (parallel to `test`, both `needs: gate`)
  that:
  - bootstraps the sandbox from a clean CI runner by running the existing
    sandbox commands in order: bring up `jellyfin-sandbox`, run
    `sandbox-generate`, run `sandbox-provision` to create `.env.sbx` and
    `config.sbx.json`, then run `sandbox-reset` before the proof suite,
  - brings up the sandbox stack (`docker-compose.yml` + `docker-compose.sbx.yml`,
    equivalent to `./scripts/sbx.sh up -d`) only after that generated sandbox
    config exists,
  - waits for the client's existing healthcheck to report healthy before
    proceeding (no fixed sleep as the sole wait strategy),
  - runs the full flow suite in one invocation via the new all-flows mode
    using the same-origin proxy target required by `player-handoff`
    (equivalent to
    `./scripts/sbx.sh run --rm -e PROOF_URL=http://proxy:8080 -e PROOF_FLOW=<all-mode> proof`),
    and fails the job if that process exits non-zero,
  - uploads `./artifacts/**` as a build artifact on failure so screenshots
    from a broken CI run are inspectable from the Actions UI,
  - tears down the sandbox stack afterward regardless of pass/fail (e.g. an
    `if: always()` teardown step or equivalent),
  - runs under a concrete, documented timeout. Initial value: `timeout-minutes:
    60` for the `e2e` job, covering sandbox bootstrap plus 14 sequential
    Playwright flows against sandbox Jellyfin. This is intentionally a tunable
    starting value, not a measured permanent constant; tighten or raise it
    after real CI timing is known.
- `publish`'s `needs:` is extended to include `e2e` alongside the existing
  `test`, so neither a unit-test failure nor an e2e-flow failure can result in
  a published image.
- Confirm (not re-derive from scratch, but explicitly verify in this repo)
  that a flow's existing `fail()` path already yields a non-zero `e2e/run.mjs`
  process exit, so the CI step needs no new error-propagation plumbing beyond
  invoking the script and checking its exit code the normal way a CI step
  does.

## Nongoals

- Do not change `release.yml`'s no-retest promotion behavior in any way — it
  continues to promote an already-built, already-tested image without
  rebuilding or retesting.
- Do not add the e2e/proof suite as a gate anywhere except the `publish.yml`
  path (no new gate on PRs, other workflows, or branches other than what
  `publish.yml` already triggers on).
- Do not change sandbox provisioning or seeding semantics (`tools/sandbox/`,
  `docker-compose.sbx.yml` contents, `.env.sbx`/`config.sbx.json`
  generation) unless the existing commands cannot run correctly on a clean
  GitHub Actions runner. The intended path is to consume the existing
  generate/provision/reset workflow as-is; if a pipeline-only fix is necessary,
  keep it narrowly scoped and call it out in the proof.
- Do not change how individual flows are authored, or require any change to
  the process for adding a new flow in the future — existing flows simply
  get run together in CI; nothing about flow authoring changes.
- Do not change the UAT stack or make CI use real Jellyfin.
- Do not attempt to parallelize the 14 flows against each other; running them
  sequentially in one invocation (matching how a human prover runs a batch
  today) is in scope, not a concurrent/sharded runner.

## Acceptance Criteria

1. [x] [proof](./.artifacts/019943aa-1a1b-70dc-8b0d-3d1f5e2b8a01-proof.md) that `e2e/run.mjs` supports an all-flows invocation that runs every flow in the `flows` array in existing dispatch order, isolates each flow with a fresh page/context/session or equivalent cleanup boundary, is exercised locally (or in a scratch CI run) against the sandbox stack through `PROOF_URL=http://proxy:8080`, completes with a non-zero exit only when a flow genuinely fails, and leaves every existing single-flow `PROOF_FLOW=<name>` invocation unaffected.
2. [x] [proof](./.artifacts/019943aa-1a1c-73e1-9f2a-6b4c9d0e7f12-proof.md) that a flow's existing `fail()` call (assertion failure) is confirmed to propagate as a non-zero process exit from `e2e/run.mjs` today, with no new error-propagation code required — documented as a verified fact, not an assumption.
3. [x] [proof](./.artifacts/019943aa-1a1d-7a52-8c3d-2e5f7b91a4d3-proof.md) that `publish.yml` gains a new `e2e` job (parallel to `test`, both gated on `gate`) which bootstraps the sandbox on a clean runner (`jellyfin-sandbox` up, `sandbox-generate`, `sandbox-provision`, `sandbox-reset`), brings up the full sandbox stack only after `.env.sbx` and `config.sbx.json` exist, waits for the client healthcheck before running proof, and runs the full flow suite via the new all-flows mode through `PROOF_URL=http://proxy:8080`.
4. [x] [proof](./.artifacts/019943aa-1a1e-7f83-b4e1-9a6d2c8f5b34-proof.md) that the `e2e` job uploads `./artifacts/**` as a build artifact when the flow run fails, and that this artifact is confirmed retrievable from a real (or dry-run) Actions run showing the failure screenshots.
5. [x] [proof](./.artifacts/019943aa-1a1f-7c94-a5f2-8b7e3d9c6a45-proof.md) that the `e2e` job tears down the sandbox stack after it finishes regardless of pass/fail (e.g. via `if: always()`), leaving no dangling containers on the runner.
6. [x] [proof](./.artifacts/019943aa-1a20-7de5-b6a3-9c8f4e0d7b56-proof.md) that the `e2e` job runs under `timeout-minutes: 60`, documented in the workflow comment as an initial tunable value covering sandbox bootstrap plus 14 sequential Playwright flows against the sandbox stack rather than a permanent constant.
7. [x] [proof](./.artifacts/019943aa-1a21-7ef6-a7b4-8d9c5f1e2a67-proof.md) that `publish`'s `needs:` includes both `test` and `e2e`, and that a deliberately-broken flow (temporary local/dry-run repro, reverted after proving) causes `publish` to be skipped exactly as a deliberately-broken unit test does today, while `release.yml`'s promotion behavior is unchanged (no retest, no rebuild).
