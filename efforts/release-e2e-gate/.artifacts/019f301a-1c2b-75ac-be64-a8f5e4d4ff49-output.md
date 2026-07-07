# Output: AC1 + AC2 of release-e2e-gate

## Status: done (AC1 implemented + exercised against sandbox; AC2 verified)

## What changed and why

`e2e/run.mjs` only. No changes to `e2e/lib/`, `e2e/flows/`, sandbox
provisioning, or `docker-compose*.yml` — none were needed.

- Added a reserved `PROOF_FLOW=all` value (`ALL_FLOWS_TOKEN`). When
  `PROOF_FLOW` equals `all`, `run.mjs` dispatches to a new `runAllFlows()`
  function instead of the (renamed, behavior-preserving)
  `runSingleFlowInvocation()`. Single-flow invocations are byte-for-byte
  unaffected: same outDir layout, same shared page/session, same `match`
  regex dispatch loop as before this change (just moved into a named
  function; no logic changed).
- The `flows` array entries were changed from bare namespace-import values
  (`groupAlias`, `groupPin`, ...) to `{ name, mod }` pairs, e.g.
  `{ name: 'group-alias', mod: groupAlias }`. `mod` is the same module
  object used before (`mod.match`, `mod.run`); `name` is a new canonical id
  used ONLY by all-flows mode to pick each flow's own `flowName` and
  screenshot subdirectory. Single-flow mode still keys entirely off the
  `PROOF_FLOW` string tested against each flow's own `match` regex, exactly
  as before — `name` is not consulted there.
- `runAllFlows()` iterates the `flows` array in the existing dispatch order
  (unchanged from the original file) and, for EACH flow:
  - creates a fresh output subdirectory `./artifacts/<batch>/<flow-name>/`
    (or `.../<PROOF_RUN_ID>/<batch>/<flow-name>/` when `PROOF_RUN_ID` is
    set) — this also fixes a screenshot-collision issue that would otherwise
    exist in an all-flows mode: several flows use `${flowName}-...` as their
    screenshot prefix, which would all resolve to the same literal (e.g.
    `all`) and collide in one shared directory. Giving each flow its own
    `flowName` (== its own canonical name) and its own subdirectory removes
    that collision entirely, matching the filenames each flow already
    produces in single-flow mode.
  - calls `startSession({ url, accessToken, flowName: <flow's own name>,
    shoot, fail })` FRESH — this launches a brand-new Playwright `browser`
    (and therefore a brand-new default `BrowserContext`/page under the
    hood) and re-runs the full login/auth-check path, then closes that
    browser in a `finally` block once the flow finishes (pass or fail)
    before moving to the next flow.
  - runs `flow.mod.run(page, ctx)` against that fresh page/session.

## Isolation mechanism (why a fresh browser per flow is sufficient)

Each flow in all-flows mode gets a brand-new `chromium.launch()` (via
`startSession`), not just a new page in a shared browser. A fresh browser
process trivially cannot carry over:
- cookies / localStorage / sessionStorage (new profile every time — this is
  what `player-handoff`'s seeded `jellyfin_credentials`/`_deviceId2`/
  `enableAutoLogin` and `group-pin`'s persisted-token check depend on being
  clean),
- `page.route()` interceptors (this is what `group-pin`'s
  `/api/session` → `portalAutoLoginEnabled: false` patch depends on not
  leaking into the next flow, which needs REAL auto-login to still work),
- the logged-in account (each flow's `startSession` re-runs auto-login from
  scratch as the sbx `household` account; `group-pin` then explicitly logs
  out and logs back in as `visitor` — a fresh browser guarantees the
  logout/relogin starts from a truly clean slate rather than depending on a
  timing race against another flow's residual DOM/network state).

`player-handoff`'s requirement to run against the same-origin proxy target
is unaffected: all-flows mode reads the SAME `PROOF_URL` env var as
single-flow mode, so `-e PROOF_URL=http://proxy:8080 -e PROOF_FLOW=all`
gives every flow (including `player-handoff`) the same origin single-flow
mode would.

## Exact all-flows invocation

```
./scripts/sbx.sh run --rm -e PROOF_URL=http://proxy:8080 -e PROOF_FLOW=all proof
```

(same shape as the existing single-flow invocation documented in AGENTS.md,
just `PROOF_FLOW=all` instead of a specific flow name.)

## Evidence the isolation requirement holds

Exercised locally against the sbx stack (provisioned fresh in this session's
worktree: `jellyfin-sandbox` up → `sandbox-generate` → `sandbox-provision` →
`sandbox-reset`, then `server`+`client`+`proxy` up). Host port 8080 was
already bound by another running gogglebox stack in this environment, so
verification used a throwaway local-only compose override
(`docker-compose.local-noport.yml`, NOT committed, deleted after
verification) that dropped the `proxy` service's host port publish — the
`proof` container still reached it internally as `http://proxy:8080` over
the compose network exactly as `publish.yml`'s future e2e job will.

**Run 1 (clean sandbox state):**
`docker compose ... run --rm -e PROOF_URL=http://proxy:8080 -e PROOF_FLOW=all proof`
completed all 15 flows in dispatch order
(group-alias, group-pin, player-handoff, player-uat, player-focus,
continue-watching, recommendations, ignore-shows, search, viewer-watched,
mark-all-watched, card-order, movie-least-watched, show-cross-episode,
rail-pagination), logging `[proof] OK — all flows passed`, exit code 0.
Screenshots landed under
`artifacts/2026-07-05T02-37-48-628Z-all/<flow-name>/...` — one subdirectory
per flow, e.g. `artifacts/.../group-pin/group-pin-success.png` and
`artifacts/.../player-handoff/player-handoff-jellyfin-loggedin.png`, with no
filename collisions across flows despite several flows using
`${flowName}-...`-based names.

**Isolation check, specifically group-pin (which patches `/api/session`)
and player-handoff (which requires the proxy origin):** both ran to full
completion, back-to-back with `group-alias` immediately before `group-pin`
(group-alias creates/reuses a managed group as the `household` account,
which would corrupt group-pin's explicit-visitor-login flow if the
`/api/session` patch or the household session leaked forward). `group-pin`
produced `group-pin-success.png` (the correct-PIN retry path forming the
group as `visitor`/Carol), proving its fresh `startSession` login (household
→ explicit logout → explicit visitor relogin) was unaffected by
group-alias's prior mutations or any residual route interception.
`player-handoff` (running right after `group-pin`, which had JUST disabled
auto-login via its `/api/session` patch) correctly saw
`app auto-login enabled = true` again on its own fresh browser/session —
proving group-pin's patched route did not leak forward.

**Run 2 (after Run 1's state changes, before a reset):** `player-focus`
genuinely failed
(`FAIL: player-focus: found no Play/Resume button to open the modal` —
Playwright strict-mode violation because more than one media-card had a
visible Play/Resume button, a PRE-EXISTING flow-authoring bug unrelated to
all-flows mode). The whole all-flows process exited non-zero immediately at
that point (did not continue to later flows), confirming AC1's "completes
with a non-zero exit only when a flow genuinely fails" requirement in the
failure direction too. Confirmed this was a real, pre-existing bug and NOT
an all-flows isolation regression by running `PROOF_FLOW=player-focus`
alone (single-flow mode) against the same sandbox state: it failed
IDENTICALLY with the same strict-mode-violation message and the same
non-zero exit. `player-uat.mjs`'s own file header already documents this
exact class of bug ("`player-focus` locates a Play/Resume button with an
`.or()` across the WHOLE page, which is ambiguous ... once a larger real
library renders more than one media-card with a Play/Resume button") as
something it was written to avoid — `player-focus.mjs` itself was never
fixed. Per this handoff's scope ("avoid touching flow authoring behavior")
this was left as-is and reported here rather than fixed.

**Run 3 (after `sandbox-reset` to clear watched/continue-watching state):**
re-ran the exact same `PROOF_FLOW=all` invocation; completed with exit code
0, confirming the Run-2 failure was data-state-dependent flow flakiness, not
an all-flows/isolation defect, and that all-flows mode reliably passes when
every flow itself would pass.

## AC2 findings — fail() exit-code propagation (verified, not assumed)

Read `e2e/lib/harness.mjs`:
```js
export function fail(message, error) {
  console.error(`[proof] FAIL: ${message}`);
  if (error) console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
}
```
`fail()` calls `process.exit(1)` directly — it does not throw, so there is
no reliance on an uncaught-exception handler or a catch block re-raising;
the moment any flow calls `fail(...)`, the Node process terminates
immediately with exit code 1, whatever else is on the call stack.

Verified this empirically (not just by reading the source) with a scratch
script that imported `fail` from `e2e/lib/harness.mjs` and called it
directly, run via `docker compose run --rm check node
/app/e2e/ac2-check.scratch.mjs` (temporary file, deleted after the check;
not part of this commit):
```
[ac2-check] about to call fail()
[proof] FAIL: deliberate AC2 verification failure

EXIT_CODE=1
```
The line after `fail()` (`'THIS LINE MUST NEVER PRINT'`) never printed, and
the shell's `$?` (and therefore `docker compose run`'s own exit code) was
`1`. Separately, both the all-flows Run 2 (above) and a standalone
`PROOF_FLOW=player-focus` invocation against the same broken sandbox state
exited non-zero (`docker compose run --rm ... proof` itself returned exit
code 1 in both cases, captured directly via `$?` after redirecting output).

**Conclusion: AC2 is confirmed as a pre-existing fact requiring zero new
code.** No error-propagation plumbing was added in this handoff — `fail()`
was already sufficient, in both single-flow and (now) all-flows mode.

## Scope notes

- Did not touch `.github/workflows/publish.yml` (AC3-7, separate phase, out
  of scope per this handoff).
- Did not touch sandbox provisioning (`tools/sandbox/`,
  `docker-compose.sbx.yml`) — the existing generate/provision/reset
  commands ran correctly as-is on this session's fresh worktree; nothing
  there blocked all-flows mode.
- The only file left dirty in the worktree is `e2e/run.mjs` (`git status
  --short` confirms). The throwaway `docker-compose.local-noport.yml` used
  to route around a host port 8080 conflict from an unrelated already-running
  gogglebox stack in this environment was deleted before finishing; it is
  NOT needed by CI (`publish.yml`'s future e2e job, AC3, will have the
  runner to itself — no port conflict expected there) and was purely a
  local verification convenience in this shared-host sandbox environment.
- `docker compose run --rm check` and `docker compose run --rm test` both
  pass (145 tests, 0 failures).

## Files touched

- `e2e/run.mjs` — added all-flows dispatch mode (`PROOF_FLOW=all`) with
  per-flow browser/session isolation; single-flow mode behavior unchanged.
