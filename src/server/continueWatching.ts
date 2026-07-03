import { ContinueWatchingItem, ViewerNextOption } from './types';

export interface ContinueWatchingCandidate extends Omit<ContinueWatchingItem, 'sourceViewerId' | 'sourceViewerName'> {
  sourceViewerId: string;
  sourceViewerName: string;
}

// The stable identity of a continue-watching card: a show is keyed by its
// series (all episodes collapse to one card), a movie by its own id. Also the
// key the per-group "continue from viewer" override is stored under.
export function continueKeyFor(type: string, id: string): string {
  return `${type}:${id}`;
}

function keyForCandidate(candidate: ContinueWatchingCandidate): string {
  if (candidate.type === 'show' && candidate.seriesId) {
    return continueKeyFor('show', candidate.seriesId);
  }

  return continueKeyFor(candidate.type, candidate.id);
}

// Air-order position of a show episode (season-major, episode-minor). Lower =
// earlier in the series.
function episodeOrder(candidate: ContinueWatchingCandidate): number {
  const season = candidate.seasonNumber ?? 0;
  const episode = candidate.episodeNumber ?? 0;
  return season * 1_000_000 + episode;
}

// "Least-advanced viewer wins" comparator: order by (episodeOrder asc,
// progressPercent asc). Returns the candidate that is LESS far along, i.e. the
// resume point the group still has the most left to watch from. For a movie,
// episodeOrder is constant, so this reduces to the LOWEST progressPercent (the
// least-watched viewer). A movie is the degenerate one-episode case of a show.
function preferLeastAdvanced(
  current: ContinueWatchingCandidate,
  candidate: ContinueWatchingCandidate,
): ContinueWatchingCandidate {
  const a = episodeOrder(candidate);
  const b = episodeOrder(current);
  if (a < b) return candidate;
  if (a > b) return current;
  return candidate.progressPercent < current.progressPercent ? candidate : current;
}

// Pick which of two candidates for the SAME series becomes the group's displayed
// episode. The group SHOW card must anchor to a STABLE episode that does not jump
// when a single viewer's watched state changes: the EARLIEST episode (air order)
// that not all viewers have finished. Each viewer's Resume/NextUp contributes
// that viewer's own "next unwatched/in-progress" episode, so the group anchor is
// simply the minimum episode-order across those candidates. On a tie at the same
// episode, prefer the in-progress (resume) candidate so we show real progress
// over a NextUp placeholder.
function preferEarlierShow(
  current: ContinueWatchingCandidate,
  candidate: ContinueWatchingCandidate,
): ContinueWatchingCandidate {
  const a = episodeOrder(candidate);
  const b = episodeOrder(current);
  if (a < b) return candidate;
  if (a > b) return current;

  const candidateProgress = candidate.playbackPositionTicks > 0 || candidate.progressPercent > 0 ? 1 : 0;
  const currentProgress = current.playbackPositionTicks > 0 || current.progressPercent > 0 ? 1 : 0;
  if (candidateProgress > currentProgress) return candidate;
  if (candidateProgress < currentProgress) return current;
  return candidate.progressPercent > current.progressPercent ? candidate : current;
}

// The name a card is sorted/displayed by: a show uses its series name, a movie
// its own name. Used only for the final, stable rail ordering.
function railSortName(candidate: ContinueWatchingCandidate): string {
  if (candidate.type === 'show' && candidate.seriesName) {
    return candidate.seriesName;
  }
  return candidate.name;
}

// Each viewer's own single resume point within one card's candidate group, in
// input (active-viewer) order. The Jellyfin fetch normally collapses a viewer's
// resume/NextUp to one candidate per series already, but dedup defensively: for
// duplicates, keep the candidate the viewer is actually on (resume over
// placeholder / least-advanced for a movie).
function bestPerViewer(group: ContinueWatchingCandidate[]): Map<string, ContinueWatchingCandidate> {
  const byViewer = new Map<string, ContinueWatchingCandidate>();
  for (const candidate of group) {
    const current = byViewer.get(candidate.sourceViewerId);
    byViewer.set(
      candidate.sourceViewerId,
      !current
        ? candidate
        : candidate.type === 'show'
          ? preferEarlierShow(current, candidate)
          : preferLeastAdvanced(current, candidate),
    );
  }
  return byViewer;
}

// Merge every viewer's candidates into one card per show/movie.
//
// Default pick: shows anchor to the earliest not-all-watched episode, movies to
// the least-watched viewer. `continueFrom` (continueKey -> viewerId) overrides
// that per card: when the chosen viewer has their own candidate for the card,
// it wins outright — the group explicitly chose to follow that viewer's
// progress (e.g. an anthology show where nobody minds skipping the earliest
// unseen episode). An override naming a viewer with no candidate falls back to
// the default pick.
export function mergeContinueWatching(
  candidates: ContinueWatchingCandidate[],
  continueFrom: Record<string, string> = {},
): ContinueWatchingItem[] {
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
  for (const [key, group] of byKey) {
    const perViewer = bestPerViewer(group);
    const overrideViewerId = continueFrom[key];
    const override = overrideViewerId ? perViewer.get(overrideViewerId) : undefined;

    const pick = override ?? group.reduce((current, candidate) =>
      candidate.type === 'show'
        // Group SHOW anchor: keep the EARLIEST not-all-watched episode (stable
        // across single-viewer watched toggles).
        ? preferEarlierShow(current, candidate)
        // Movies (the degenerate one-episode case): resume from the LEAST-
        // advanced viewer so the group still has the most movie left to watch.
        : preferLeastAdvanced(current, candidate));

    selected.push({
      ...pick,
      continueFromViewerId: override ? overrideViewerId : null,
      viewerNext: [...perViewer.values()].map((candidate) => ({
        viewerId: candidate.sourceViewerId,
        viewerName: candidate.sourceViewerName,
        itemId: candidate.id,
        seasonNumber: candidate.seasonNumber,
        episodeNumber: candidate.episodeNumber,
        progressPercent: candidate.progressPercent,
      })),
    });
  }

  // Stable rail order: alphabetical by show/movie name (case-insensitive), with a
  // stable id tie-break so same-named items keep a fixed relative order. This is
  // deterministic and independent of progress, so toggling a viewer's watched
  // state (which refetches the rail) never reshuffles the cards.
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

// Per-viewer played state across one series' episodes, in shared air order. Each
// viewer's array is the SAME episode list (same ids/order); only `played` differs.
export interface SeriesEpisodeForAnchor {
  id: string;
  played: boolean;
}

// The group SHOW card's anchor = the EARLIEST episode (air order) that NOT every
// active viewer has watched, i.e. min across viewers of their next-unwatched
// episode. This is computed from each viewer's FULL played state (not just their
// single Resume/NextUp episode), so a viewer who has finished early episodes and
// is now on a later one does not drag the anchor forward. The anchor stays put
// when a single viewer toggles watched and only moves once everyone has watched
// the displayed episode.
//
// Input: per active viewer, the series' episodes in air order with that viewer's
// `played` flag (all arrays cover the same episodes in the same order). Returns
// the 0-based index of the anchor episode, or -1 when every viewer has watched
// every episode (the card should drop).
export function pickGroupAnchorIndex(perViewer: SeriesEpisodeForAnchor[][]): number {
  const present = perViewer.filter((list) => list.length > 0);
  if (present.length === 0) {
    return -1;
  }

  const episodeCount = Math.max(...present.map((list) => list.length));
  for (let index = 0; index < episodeCount; index += 1) {
    // The earliest episode that AT LEAST ONE active viewer has not played is the
    // anchor: it is the first episode the group as a whole still needs.
    const someoneUnwatched = present.some((list) => {
      const entry = list[index];
      return entry ? !entry.played : false;
    });
    if (someoneUnwatched) {
      return index;
    }
  }

  return -1;
}
