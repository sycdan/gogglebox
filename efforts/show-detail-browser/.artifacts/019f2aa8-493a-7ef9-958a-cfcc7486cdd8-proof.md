## AC2 — Modal lists episodes groupable/filterable by season; selecting a season narrows the list

### Status: PASS (ui-tested)

### Stack / data

Same run as AC1: `./scripts/sbx.sh` sandbox stack, `e2e/flows/show-detail-browser.mjs`
via `PROOF_FLOW=show-detail-browser`, party = all 4 sandbox viewers, show =
seeded fixture **"Normal Show"** (Season 1: 4 episodes — Pilot, Second Wind,
Third Time, Four Square; Season 2: 3 episodes — Return, Resettle, Reckoning).

### What was driven

1. With the "Normal Show" detail modal open, confirmed a `.season-filter-row`
   rendered with a button row: `["All seasons", "Season 1", "Season 2"]`
   (`role="group"`, `aria-label="Filter by season"`).
2. With "All seasons" selected (default), counted 7 visible `.episode-card`
   rows — the full combined S1+S2 list.
3. Clicked the "Season 2" button.
4. Re-counted the visible episode rows: 3 rows, titled
   `["Return", "Resettle", "Reckoning"]` — exactly Season 2's episode set,
   narrower than the all-seasons count (7 → 3).
5. Confirmed every visible row's `S0xE0y` eyebrow label matched `S02` — no
   Season 1 episodes leaked into the filtered view.

### Evidence (screenshots copied into this effort's `.artifacts/`)

- `efforts/show-detail-browser/.artifacts/019f2aa8-493a-7ef9-958a-cfcc7486cdd8-proof-01-all-seasons.png`
  — modal with "All seasons" selected, showing `S01 E01 Pilot` then
  `S01 E02 Second Wind` at the top of the full 7-episode list, and the
  `["All seasons", "Season 1", "Season 2"]` button row.
- `efforts/show-detail-browser/.artifacts/019f2aa8-493a-7ef9-958a-cfcc7486cdd8-proof-02-season2-filtered.png`
  — same modal after clicking "Season 2" (now highlighted/selected): the
  visible list narrows to `S02 E01 Return`, `S02 E02 Resettle` (and
  `S02 E03 Reckoning` below the fold) — no Season 1 episodes present.

### Proof-run log excerpts

```
[proof] show-detail-browser: season filter buttons = ["All seasons","Season 1","Season 2"]
[proof] show-detail-browser: "All seasons" episode count = 7
[proof] show-detail-browser: Season 2 filtered episode count = 3, titles = ["Return","Resettle","Reckoning"]
[proof] show-detail-browser: Season 2 filtered row labels = ["S02 E01","S02 E02","S02 E03"]
[proof] show-detail-browser: PASS (AC2) — Season 2 button narrowed the episode list to only S02 episodes.
```

### Judgement

Proved. The season-filter-row correctly derives one button per season present
in the loaded episode list, plus "All seasons", and selecting "Season 2"
narrows the visible episode rows from 7 (all seasons) to exactly the 3 Season
2 episodes, with no cross-season leakage.
