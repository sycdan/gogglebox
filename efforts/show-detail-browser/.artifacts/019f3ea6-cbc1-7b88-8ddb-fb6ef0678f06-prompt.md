---
prompt_id: 019f3ea6-cbc1-7b88-8ddb-fb6ef0678f06
target_agent: gogglebox-builder
effort_path: efforts/show-detail-browser/ShowDetailBrowser.md
output_path: efforts/show-detail-browser/.artifacts/019f3ea6-d169-7524-9656-6ff6269f82db-output.md
base_tag: handoff/019f3ea6-cbc1-7b88-8ddb-fb6ef0678f06
session_name: show-detail-browser.1783462553742
---

First, `cd` into `./sessions/show-detail-browser.1783462553742` before doing
anything else. Make all edits, commands, and commits from there.

## Effort

`efforts/show-detail-browser/ShowDetailBrowser.md` — Show Detail Browser.

Implement all four acceptance criteria:

1. Clicking a show title anywhere it appears opens an accessible show modal
   without breaking the current page state behind it.
2. The modal lists episodes grouped or filterable by season and supports
   selecting a season button to narrow the visible episode list.
3. Each visible episode row shows the watched or unwatched state for every
   watcher in the active group.
4. Jellyfin search can find episodes by keyword scoped to one specific show,
   without surfacing episodes from other shows or becoming a global discovery
   rail search.

Respect the effort's Nongoals: do not replace existing recommendation or
in-progress views, do not add global/discovery-rail/cross-show search UX (that
belongs to Judgement Day), and do not add watched-state editing.

## Scope

You may edit `src/` and other app code needed to implement this feature. Use
the Docker compose stack for all typecheck/test/build commands per the repo's
kb guide — never run `npm`/`node`/`tsc` on the host.

## Phase

This is the **builder** phase: implement the feature end-to-end (server +
client) so it is ready for static verification (typecheck/tests) and later
visual proof. You do not need to write proof docs yourself, but note in your
output which of the four acceptance criteria you believe are functionally
complete and ready for the verifier/prover to confirm.

## Output

When done (or blocked), write your final summary to
`efforts/show-detail-browser/.artifacts/019f3ea6-d169-7524-9656-6ff6269f82db-output.md`
(no frontmatter needed). List what you implemented, any deviations from the
spec, and remaining work or risks for the verifier/prover.
