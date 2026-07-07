# Builder output — auth-refactor e2e proof-gap closure (prompt 019f2fcd-5ccf-7cbc-bec2-d9eff9226016)

## Summary

Worked from `./sessions/auth-refactor.1783213415717` as instructed. Added the
three e2e test-flow-only additions requested by
`efforts/auth-refactor/.artifacts/019f2fb4-4adf-79a5-bab4-a0b51709881a-output.md` to
close the remaining visual-proof gaps on criteria 2, 5, and the UAT half of 6.
No application/login/warning/token logic was changed — only `e2e/` flow code.

## Changes

- `e2e/flows/group-pin.mjs`:
  - New step **1a**, right after the login form first renders and before the
    real visitor-token login: submits a deliberately invalid access token
    (`not-a-real-token`), asserts the `POST /api/auth/login` response is 4xx,
    asserts a visible `.error` element under `.auth-panel` (the app renders
    `<p className="error">` as a **sibling** of `form.stack`, not nested
    inside it — fixed the locator to `.auth-panel .error` after the first dry
    run failed on that), asserts the login form is still visible (no
    auth/persist), and asserts no token was written to
    `localStorage['gogglebox.accessToken']`. Screenshots
    `group-pin-invalid-token.png`.
  - `confirmPinsAndMixed()`: added `await shoot(page, 'group-pin-mixed-warning')`
    right after the `.confirm-modal` becomes visible and before the `Confirm`
    click, so there is a human-readable screenshot of the mixed-group warning
    itself (title "Shared watch progress", the "HEADS UP" copy, Cancel/Confirm
    buttons), not just a passing DOM assertion.
- `e2e/flows/player-uat.mjs` (new): a `player-handoff`-style click-through
  built specifically to be UAT-safe against a real, larger Jellyfin library:
  - Same-origin-proxy guard (same reasoning/message as `player-handoff`) —
    fails loudly and early if run against the bare `:5173` client instead of
    the proxy, rather than timing out confusingly later.
  - Selects viewers **generically**: keeps whatever primaries already arrive
    preselected as-is (no fixed name/count assumption — the real UAT config
    has exactly one primary, "Alice", vs. sandbox's two), falling back to the
    first viewer card only if nothing is preselected.
  - Avoids the `player-focus` Playwright strict-mode ambiguity: instead of a
    single page-wide `page.locator('.media-card button', {...}).first().or(...)`
    (which throws "strict mode violation" once several cards each have their
    own Play/Resume button in a larger real library), this flow iterates
    `.media-card` instances one at a time and scopes the button search to
    each card individually, deliberately picking the **first** card that has
    a Play or Resume button.
  - Opens the player modal, resolves the Jellyfin `/player` child frame, and
    asserts it settles into a logged-in view (no manual login form) —
    the same handoff guarantee `player-handoff` proves, reusable against any
    account/library shape.
  - Registered in `e2e/run.mjs`'s flow dispatch list (`match =
    /player-uat|uat-player/i`).

## Verification

- `docker compose run --rm check` — pass (tsc client + server configs, no
  errors).
- `docker compose run --rm test` — pass: `# tests 145 / # pass 141 / # fail 0
  / # skipped 4`.
- Sandbox proof (`./scripts/sbx.sh`, fresh-provisioned since this worktree's
  Docker volumes started empty — same as the prior prover's setup notes):
  - `PROOF_FLOW=group-pin` — full pass, including the two new assertions.
    `group-pin-invalid-token.png` shows the login panel with the access-token
    field filled, "Invalid access token" error text visible, and the form
    still present. `group-pin-mixed-warning.png` shows the "Shared watch
    progress" / "HEADS UP" modal with Cancel/Confirm.
  - `PROOF_FLOW=player-uat` — first run against the bare client failed the
    login/settle check as expected per the origin guard's reasoning (Jellyfin
    iframe never resolves logged-in off-proxy); re-run with
    `-e PROOF_URL=http://proxy:8080` passed end-to-end: opened the player
    modal for a real sandbox title and confirmed the Jellyfin iframe settled
    logged-in.
  - A stray already-running `gogglebox-proxy-1` (unrelated main checkout) held
    host port 8080 for the whole session; used the same temporary,
    non-committed `docker-compose.local.yml` override
    (`services: proxy: ports: !override []`) as the prior prover pass to stop
    this worktree's proxy publishing a host port — container-to-container
    `http://proxy:8080` still worked. Deleted before finishing; never touched
    `src/`, `e2e/`, or any tracked file.
- UAT proof (real Jellyfin, `.env.uat`/`config.uat.json`,
  `JELLYFIN_URL=http://htpc.lan:8096`) — bonus verification, also completed:
  `PROOF_FLOW=player-uat` against `-e PROOF_URL=http://proxy:8080` passed
  fully. Confirmed both problems the prior prover hit are resolved: the flow
  correctly kept the real config's single preselected primary (Alice) instead
  of assuming two, chose "(500) Days of Summer" as the first card with a
  Play/Resume button (no strict-mode ambiguity even though this library has
  far more than one playable card), opened the player modal, and the Jellyfin
  iframe settled logged-in with no manual login form —
  `player-uat-06-jellyfin-frame.png` shows the real-data player detail view
  with "NOW PLAYING (500) Days of Summer" and "STARTING PLAYER".

## Environment notes (for whoever runs this next)

- Same as the prior prover pass: this worktree does not carry gitignored
  `.env`, `.env.sbx`, `.env.uat`, `config.sbx.json`, `config.uat.json` /
  `config.json` (git worktrees only contain tracked files). Copied these in
  from the repo root to run the stacks; gitignored, so they never show up in
  `git status` here and were not committed. All copied env/config files and
  the temporary `docker-compose.local.yml` override were deleted again before
  finishing — `git status` in this worktree is clean except for the three
  tracked `e2e/` files.
- Sandbox Docker volumes are per-worktree-directory-name, so this worktree's
  sandbox Jellyfin started empty; ran `sandbox-generate` + `sandbox-provision`
  fresh (this also regenerates `.env.sbx`/`config.sbx.json` with a new API
  key — recreated `server`/`client` with `--force-recreate` afterward to
  pick up the fresh config).
- Both stacks (`sbx`, `uat`) brought up in this worktree were torn down
  (`down --remove-orphans`) before finishing; the unrelated main-checkout
  `gogglebox-*` stack was left untouched throughout.

## Criteria status after this pass

- **Criterion 2** — now closeable: reject-with-clear-error half is visually
  proved (`group-pin-invalid-token.png`), in addition to the previously-proved
  accept path.
- **Criterion 5** — now closeable: the mixed-group warning itself is
  screenshotted (`group-pin-mixed-warning.png`), not just DOM-asserted.
- **Criterion 6** — sandbox half was already proved; UAT half is now closeable
  too — full click-through completed against the real Jellyfin instance
  (`player-uat-06-jellyfin-frame.png`), with the flow generalized so it does
  not depend on a fixed primary count or an unambiguous single Play/Resume
  button.
- Criteria 1, 3, 4 were already proved in the prior prover pass and are
  unaffected by this change.

Nothing here is a blocker; all three requested gaps are closed. Suggest
sending this back through `gogglebox-verifier`/`gogglebox-prover` (durable
proof-doc copies of the new screenshots into
`efforts/auth-refactor/.artifacts/`) and then `gogglebox-approver` for criteria
2, 5, and 6.

## Next action

Land this session's commit onto `main` (tag-bounded squash from
`handoff/019f2fcd-5ccf-7cbc-bec2-d9eff9226016`), then dispatch
`gogglebox-prover` to copy the new screenshots
(`group-pin-invalid-token.png`, `group-pin-mixed-warning.png`,
`player-uat-06-jellyfin-frame.png`, plus the supporting before/after shots)
into the relevant `.artifacts/*.md` docs for criteria 2, 5, and 6, then
`gogglebox-approver` to check those criteria.
