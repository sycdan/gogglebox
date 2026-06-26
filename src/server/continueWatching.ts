import { ContinueWatchingItem } from './types';

export interface ContinueWatchingCandidate extends Omit<ContinueWatchingItem, 'sourceViewerId' | 'sourceViewerName'> {
  sourceViewerId: string;
  sourceViewerName: string;
}

function keyForCandidate(candidate: ContinueWatchingCandidate): string {
  if (candidate.type === 'show' && candidate.seriesId) {
    return `show:${candidate.seriesId}`;
  }

  return `${candidate.type}:${candidate.id}`;
}

// Air-order position of a show episode (season-major, episode-minor). Lower =
// earlier in the series.
function episodeOrder(candidate: ContinueWatchingCandidate): number {
  const season = candidate.seasonNumber ?? 0;
  const episode = candidate.episodeNumber ?? 0;
  return season * 1_000_000 + episode;
}

// Used only for the final rail ordering and movie selection (higher = surfaces
// first / "more in progress"). NOT used to choose a show's displayed episode.
function displayRank(candidate: ContinueWatchingCandidate): number {
  if (candidate.type === 'show') {
    const hasResumeProgress = candidate.playbackPositionTicks > 0 || candidate.progressPercent > 0 ? 1 : 0;
    return hasResumeProgress * 10_000_000_000 + episodeOrder(candidate) * 10_000 + Math.round(candidate.progressPercent * 1000);
  }

  return Math.round(candidate.progressPercent * 1_000_000);
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

export function mergeContinueWatching(candidates: ContinueWatchingCandidate[]): ContinueWatchingItem[] {
  const selected = new Map<string, ContinueWatchingCandidate>();

  for (const candidate of candidates) {
    const key = keyForCandidate(candidate);
    const current = selected.get(key);
    if (!current) {
      selected.set(key, candidate);
      continue;
    }

    if (candidate.type === 'show') {
      // Group SHOW anchor: keep the EARLIEST not-all-watched episode (stable
      // across single-viewer watched toggles).
      selected.set(key, preferEarlierShow(current, candidate));
    } else if (displayRank(candidate) > displayRank(current)) {
      // Movies: keep the most in-progress instance.
      selected.set(key, candidate);
    }
  }

  return [...selected.values()]
    .sort((left, right) => displayRank(right) - displayRank(left))
    .slice(0, 24)
    .map((candidate) => ({
      ...candidate,
      sourceViewerId: candidate.sourceViewerId,
      sourceViewerName: candidate.sourceViewerName,
    }));
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
