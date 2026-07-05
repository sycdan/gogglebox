import { ContinueWatchingItem } from './types';

export interface ContinueWatchingCandidate extends Omit<ContinueWatchingItem, 'sourceViewerId' | 'sourceViewerName'> {
  sourceViewerId: string;
  sourceViewerName: string;
}

// A single ignore entry: see appState.ts IgnoreEntry. Declared structurally here
// (rather than importing AppState) so this module has no dependency on the
// storage layer, only the shape it needs to match against.
export interface IgnoreEntry {
  key: string;
  matchSeriesId: boolean;
  label: string;
  ignoredAt: number;
}

// The stable identity of a continue-watching card: a show is keyed by its
// EXACT episode id (every distinct episode a viewer is on gets its own card —
// no cross-episode collapsing), a movie by its own id.
function keyForCandidate(candidate: ContinueWatchingCandidate): string {
  return `${candidate.type}:${candidate.id}`;
}

// The name a card is sorted/displayed by: a show uses its series name, a movie
// its own name. Used only for the final, stable rail ordering.
function railSortName(candidate: ContinueWatchingCandidate): string {
  if (candidate.type === 'show' && candidate.seriesName) {
    return candidate.seriesName;
  }
  return candidate.name;
}

// Pick which of two candidates for the SAME exact item (episode or movie)
// becomes the party's displayed card. Since both candidates already point at
// the identical id, there is no cross-episode ordering left to consider: prefer
// an actually-resuming candidate (real playback progress) over a NextUp
// placeholder; between two real-progress candidates, the LEAST advanced wins,
// so the shared card always resumes from whoever is furthest behind and no
// one's position gets skipped past or spoiled ahead.
function pickRepresentative(
  current: ContinueWatchingCandidate,
  candidate: ContinueWatchingCandidate,
): ContinueWatchingCandidate {
  const candidateProgress = candidate.playbackPositionTicks > 0 || candidate.progressPercent > 0 ? 1 : 0;
  const currentProgress = current.playbackPositionTicks > 0 || current.progressPercent > 0 ? 1 : 0;
  if (candidateProgress > currentProgress) return candidate;
  if (candidateProgress < currentProgress) return current;
  return candidate.progressPercent < current.progressPercent ? candidate : current;
}

// Merge every viewer's candidates into cards, one per distinct item id.
//
// Unlike the old series-anchored model, a show no longer collapses to a single
// card: each distinct episode any active viewer is currently on (via their own
// Resume/NextUp) becomes its own card. This is what lets an anthology-style
// show (e.g. Ancient Aliens, where episode order is meaningless) show BOTH "up
// next for viewer A" and "up next for viewer B" as separate rail cards, instead
// of forcing everyone through the earliest unwatched episode. A movie still
// naturally collapses to one card per movie id, since movies have no episode
// granularity; when several viewers are mid-movie, pickRepresentative resolves
// to the one with real progress (over a placeholder) and then the LEAST
// advanced, so the shared card never resumes past where the furthest-behind
// viewer has gotten.
export function mergeContinueWatching(candidates: ContinueWatchingCandidate[]): ContinueWatchingItem[] {
  const byKey = new Map<string, ContinueWatchingCandidate[]>();
  for (const candidate of candidates) {
    const key = keyForCandidate(candidate);
    const group = byKey.get(key);
    if (group) {
      group.push(candidate);
    } else {
      byKey.set(key, [candidate]);
    }
  }

  const selected: ContinueWatchingItem[] = [];
  for (const group of byKey.values()) {
    const pick = group.reduce((current, candidate) => pickRepresentative(current, candidate));
    selected.push({ ...pick });
  }

  // Stable rail order: alphabetical by show/movie name (case-insensitive), with a
  // stable id tie-break so same-named items keep a fixed relative order. This is
  // deterministic and independent of progress, so toggling a viewer's watched
  // state (which refetches the rail) never reshuffles the cards. A series that
  // now emits multiple cards (fan-out) still sorts deterministically because the
  // id tie-break disambiguates them.
  return selected
    .sort((left, right) => {
      const byName = railSortName(left).localeCompare(railSortName(right), undefined, { sensitivity: 'base' });
      if (byName !== 0) return byName;
      return left.id.localeCompare(right.id);
    })
    .slice(0, 24);
}

export function getProgressPropagationTargets(activeViewerIds: string[], sourceViewerId: string): string[] {
  return activeViewerIds.filter((viewerId) => viewerId !== sourceViewerId);
}

// True when an item should be hidden per the party's ignore entries: either its
// own exact id was ignored (episode or movie scope), or — for a show — some
// entry ignored the whole series (matchSeriesId) and matches item.seriesId.
export function isIgnored(
  entries: IgnoreEntry[],
  item: { type: string; id: string; seriesId?: string | null },
): boolean {
  return entries.some((entry) => {
    if (entry.key === item.id) {
      return true;
    }
    return Boolean(entry.matchSeriesId && item.type === 'show' && item.seriesId && entry.key === item.seriesId);
  });
}
