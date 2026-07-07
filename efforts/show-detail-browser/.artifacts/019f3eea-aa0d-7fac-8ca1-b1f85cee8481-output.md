## Show Detail Browser — prover run summary

### Status: pass — all four acceptance criteria proved by UI screenshot + assertion

### Stack / data used

- **sbx** (seeded, offline sandbox Jellyfin), freshly provisioned for this
  session (no pre-existing sandbox volumes under this session's compose
  project name, so I ran the full bring-up from `tools/sandbox/README.md`):
  1. `./scripts/sbx.sh up -d jellyfin-sandbox`
  2. `./scripts/sbx.sh run --rm sandbox-generate`
  3. `./scripts/sbx.sh run --rm sandbox-provision`
  4. `./scripts/sbx.sh up -d` (server + client + proxy)
- Party driven: all 4 sandbox viewers (Alice, Bob, Carol, Dave) — the
  "Everyone" preset via `pickEveryonePartyAndContinue`.
- Show fixture: seeded **"Normal Show"** (`tools/sandbox/fixtures.mjs`
  `SHOWS[0]`) — 2 seasons, S1×4 episodes (incl. "Pilot"), S2×3 episodes. Also
  incidentally exercised the "Near Finale" fixture as the continue-watching
  click-site for AC1's second entry point.
- Keyword used for AC4: `"Pilot"` — unique to Normal Show S01E01, present in
  no other seeded show's episode titles.

### What I drove

Added a new e2e flow module, `e2e/flows/show-detail-browser.mjs` (wired into
`e2e/run.mjs`'s `flows` array as `show-detail-browser`), since no existing
flow covered this feature (`show-cross-episode.mjs` is unrelated — it proves
the continue-watching fan-out/ignore behavior, not the show detail modal).
The new flow drives, in one Playwright session:

1. **AC1** — opens the show modal by clicking a media-card title, asserts
   `role="dialog"`/`aria-modal="true"`/`aria-label`, asserts page
   section-headings are unchanged before vs. after open+close, then
   separately opens the modal a second way via a continue-watching card's
   series-name link.
2. **AC2** — asserts the `.season-filter-row` buttons match the fixture's
   seasons, clicks "Season 2", and asserts the visible episode-row count and
   titles narrow correctly with no cross-season leakage.
3. **AC3** — seeds a **mixed** watched state via the sandbox Jellyfin API
   directly (`resetAllPlayedState` then `markPlayed` for Alice only on
   S01E01 "Pilot") so the per-viewer pill evidence is a genuine
   watched/unwatched mix rather than "everyone unwatched"; asserts 4 pills
   (one per party viewer) with the correct per-viewer state, and confirms
   clicking a pill does not toggle it (read-only, per the nongoal).
4. **AC4** — types the unique keyword into the in-modal "Search episodes in
   Normal Show" field, asserts only the matching episode of THIS show
   remains, and does a before/after snapshot of the completely separate
   top-level toolbar search box value + its results rail to prove the
   in-modal search never touches/becomes a global search.

Ran via:

```
./scripts/sbx.sh run --rm -e PROOF_RUN_ID=2026-07-07T23-34-52Z-show-detail -e PROOF_FLOW=show-detail-browser proof
```

Exit was clean (`[proof] OK`), and every flow-internal assertion logged PASS
(no `fail()`/non-zero exit was hit on the final run).

### Screenshots

Written under
`./artifacts/2026-07-07T23-34-52Z-show-detail/2026-07-07T23-38-26-206Z-show-detail-browser/`
during the run; the ones cited by proof docs were copied into this effort's
`.artifacts/` directory (see the four proof docs below) so they survive
session teardown. Full raw set from the run (for reference, NOT durable —
only the copies under `.artifacts/` are guaranteed to persist):

- `show-detail-browser-01-before-open-mediacard.png`
- `show-detail-browser-02-authenticated.png`
- `show-detail-browser-02-modal-open-mediacard.png` /
  `-02-modal-open-mediacard-full.png`
- `show-detail-browser-03-after-close-mediacard.png`
- `show-detail-browser-04-before-open-cwcard.png`
- `show-detail-browser-05-modal-open-cwcard.png`
- `show-detail-browser-08-all-seasons.png`
- `show-detail-browser-09-season2-filtered.png`
- `show-detail-browser-11-episode-row-pills.png` /
  `-11-pills-closeup.png`
- `show-detail-browser-13-episode-search-results.png`
- `show-detail-browser-14-global-search-untouched.png`

### Proof docs written this pass

- `efforts/show-detail-browser/.artifacts/019f2aa8-4939-7df8-b837-de245fa41849-proof.md`
  (AC1 — pass) + 4 copied PNGs.
- `efforts/show-detail-browser/.artifacts/019f2aa8-493a-7ef9-958a-cfcc7486cdd8-proof.md`
  (AC2 — pass) + 2 copied PNGs.
- `efforts/show-detail-browser/.artifacts/019f2aa8-493c-7830-b953-38a8a7ed72ab-proof.md`
  (AC3 — pass) + 2 copied PNGs.
- `efforts/show-detail-browser/.artifacts/019f2aa8-493e-7583-8889-4e701cc2bc20-proof.md`
  (AC4 — pass) + 2 copied PNGs.

### Flakiness / gaps

- None encountered on the run whose logs/screenshots are cited above. One
  earlier iteration of my own flow had an overly-strict AC4 assertion (it
  wrongly required the top-level global "Search results" section to be
  entirely ABSENT while the modal search was active, but that section was
  legitimately present from an earlier step in the same flow where I used
  the toolbar search to locate the "Normal Show" card in the first place —
  a flow-authoring mistake on my part, not a product bug). I fixed the flow
  to instead snapshot-and-diff the global search box value + its results
  before/after the in-modal search, which is the correct, unambiguous
  assertion; the corrected flow is what produced the passing run and
  screenshots cited in the four proof docs.
- AC1's continue-watching click-site (AC1b) depended on this party actually
  having an in-progress show on the Continue-watching rail with a
  clickable series-name link; the sandbox happened to have one ("Near
  Finale") for this party, so it was exercised directly rather than needing
  a fallback/skip path.
- No source changes were made — I am read-only on `src/`. My only edits were
  the new `e2e/flows/show-detail-browser.mjs` module and its one-line wiring
  into `e2e/run.mjs`.

### New/modified files (e2e harness only, not `src/`)

- `e2e/flows/show-detail-browser.mjs` (new)
- `e2e/run.mjs` (added import + registration for the new flow)
