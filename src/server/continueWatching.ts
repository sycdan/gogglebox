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

function rankCandidate(candidate: ContinueWatchingCandidate): number {
  if (candidate.type === 'show') {
    const season = candidate.seasonNumber ?? 0;
    const episode = candidate.episodeNumber ?? 0;
    const hasResumeProgress = candidate.playbackPositionTicks > 0 || candidate.progressPercent > 0 ? 1 : 0;
    return hasResumeProgress * 10_000_000_000 + season * 1_000_000 + episode * 10_000 + Math.round(candidate.progressPercent * 1000);
  }

  return Math.round(candidate.progressPercent * 1_000_000);
}

export function mergeContinueWatching(candidates: ContinueWatchingCandidate[]): ContinueWatchingItem[] {
  const selected = new Map<string, ContinueWatchingCandidate>();

  for (const candidate of candidates) {
    const key = keyForCandidate(candidate);
    const current = selected.get(key);
    if (!current || rankCandidate(candidate) > rankCandidate(current)) {
      selected.set(key, candidate);
    }
  }

  return [...selected.values()]
    .sort((left, right) => rankCandidate(right) - rankCandidate(left))
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
