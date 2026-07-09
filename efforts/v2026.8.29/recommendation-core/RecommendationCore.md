# Recommendation Core

## Overview

Implement the scoring pipeline of [Judgement Day](../V2026.8.29.md): facts →
signal plugins → party aggregation → deterministic score → seeded deck. Each
signal implements `score(item, partyContext) -> { value: 0..1, reason?: string } | null`,
where `null` means abstain and weights renormalize over non-abstaining signals
so missing data never punishes an item. Signals live in one registry; adding a
signal is one module + one registry entry + one config weight. The initial
signal set: recently-watched-by-another-member, liked-by-trusted-user (trust
explicitly declared in v1, inferred later), highly-rated, newly-added (ranked
high — the owner added it on purpose, a uniquely strong home-library signal),
most-watched, least-watched, fits-time-budget.

Hard filters (kind, genre, kids-only, hard time-budget cutoff) run pre-score
and are not signals. Scoring is on-demand — no long-running ranking daemon;
only expensive Jellyfin aggregates (watch counts, watched unions) may be
cached or precomputed. Elicitation answers affect the very next request. The
deck contract: score all candidates deterministically → top-K (~20) →
score-weighted shuffle with a per-session seed → deal "tonight's deck" (~7),
finite, positioned, reload-stable, with an explicit deal-new-deck that
excludes seen items and logs a strong dissatisfaction fact. This replaces the
old reroll concept and resolves the determinism-vs-reroll contradiction.

## Goals

- Define and implement the signal plugin contract, registry, and
  abstain/renormalize semantics.
- Aggregate per-member scores per signal: least-misery (min) for veto-shaped
  signals (kid-safe, hated-genre, disliked), mean for taste-shaped signals,
  with negative facts (disliked/ignored/skipped/not-tonight) weighted roughly
  2-3x positives.
- Expose deterministic scoring and seeded deck dealing as the API contract:
  deck id, deck position, and deal-new-deck.
- Return a per-item explanation payload (top ~2 contributing reasons by
  weight × value).
- Keep rewatch possible: watched-by-all items must be recommendable via the
  rewatch/liked fact path.
- Guarantee a zero-config cold-start default that never surfaces an
  unexplainable item.
- Build the offline eval harness and make it the gate for adding signals.

## Nongoals

- No paid external recommendation or AI services.
- No channel configuration or channel toggles — candidate sources feed one
  ranker; provenance surfaces as explanations only.
- No long-running ranking daemon or background scoring service.
- No UI work — surfaces belong to
  [recommendation-rail](../recommendation-rail/RecommendationRail.md).
- Inferred trust between members is later; v1 trust is explicitly declared.

## Acceptance Criteria

1. [ ] [proof](./.artifacts/019f46d2-cb8f-7b69-9bca-31e4d46001f1-proof.md) that the signal plugin contract (`score(item, partyContext) -> { value, reason? } | null`) and single registry are implemented with abstain/renormalize semantics, the initial signal set is registered, and adding a signal requires only one module, one registry entry, and one config weight.
2. [ ] [proof](./.artifacts/019f46d2-ccdb-7ffb-b068-299aaf926eb6-proof.md) that party aggregation blends present members per signal using each signal's declared aggregator — least-misery (min) for veto-shaped signals, mean for taste-shaped signals — and that negative facts weigh roughly 2-3x positives in scoring.
3. [ ] [proof](./.artifacts/019f46d2-ce11-796a-8386-4f4fdde8d788-proof.md) that the backend deck API deterministically scores candidates, deals a seeded top-K score-weighted deck (~7 from ~20) with a deck id and position, is reload-stable for the same session seed against the seeded sandbox, and supports deal-new-deck that excludes seen items and logs a strong dissatisfaction fact.
4. [ ] [proof](./.artifacts/019f2aa8-4943-74fe-9945-dad3754c53a2-proof.md) that each recommendation response item includes enough structured explanation data (top ~2 contributing reasons by weight × value) for the client to render a user-facing reason.
5. [ ] [proof](./.artifacts/019f46d2-cf64-77da-a1bf-d8a9295afd54-proof.md) that a watched-by-all item can still be recommended through the rewatch/liked fact path, so comfort rewatches are not excluded by the watched-union.
6. [ ] [proof](./.artifacts/019f46d2-d0a3-7d8b-96fd-c01728631a9b-proof.md) that a fresh deploy with no facts and no answered questions gets a sensible cold-start deck (high-rated unwatched in dominant library genres) and never surfaces an item without a renderable reason.
7. [ ] [proof](./.artifacts/019f46d2-d1d5-796f-b68d-e699ffd62068-proof.md) that an offline replay eval harness runs deterministically against the sandbox — holding out each party's last watch and measuring hit-rate@10 over the fact history, also tracking Start-press acceptance — and that the documented rule "no new signal without a named failure it fixes and an eval delta showing it" gates signal additions.
