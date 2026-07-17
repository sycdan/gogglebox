import { LibraryItem } from './types';

export interface RecommendationEvidence {
  itemId: string;
  channel: string;
  strength: number;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface ScoredRecommendation<T extends { id: string }> {
  item: T;
  evidence: RecommendationEvidence[];
  score: number;
  reasons: string[];
}

export interface RankRecommendationsOptions {
  channelWeights?: Record<string, number>;
  pinnedChannels?: string[];
  limit?: number;
}

export interface RecommendedItem extends LibraryItem {
  recommendationEvidence: RecommendationEvidence[];
  recommendationScore: number;
  recommendationReasons: string[];
}

const LIBRARY_QUALITY_CHANNEL = 'library-quality';

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function evidenceScore(evidence: RecommendationEvidence, channelWeights: Record<string, number>): number {
  const weight = channelWeights[evidence.channel] ?? 1;
  return Math.max(0, weight) * Math.max(0, finiteOr(evidence.strength, 0));
}

function compareEvidence(
  left: RecommendationEvidence,
  right: RecommendationEvidence,
  channelWeights: Record<string, number>,
): number {
  const byScore = evidenceScore(right, channelWeights) - evidenceScore(left, channelWeights);
  if (byScore !== 0) return byScore;
  const byChannel = left.channel.localeCompare(right.channel);
  if (byChannel !== 0) return byChannel;
  return left.reason.localeCompare(right.reason);
}

export function rankRecommendationCandidates<T extends { id: string }>(
  items: T[],
  evidence: RecommendationEvidence[],
  options: RankRecommendationsOptions = {},
): ScoredRecommendation<T>[] {
  const channelWeights = options.channelWeights ?? {};
  const pinnedChannels = new Set(options.pinnedChannels ?? []);
  const itemOrder = new Map(items.map((item, index) => [item.id, index]));
  const itemById = new Map(items.map((item) => [item.id, item]));
  const evidenceByItemId = new Map<string, RecommendationEvidence[]>();

  for (const record of evidence) {
    if (!itemById.has(record.itemId)) {
      continue;
    }
    const current = evidenceByItemId.get(record.itemId) ?? [];
    current.push(record);
    evidenceByItemId.set(record.itemId, current);
  }

  const scored = items.map((item): ScoredRecommendation<T> => {
    const itemEvidence = [...(evidenceByItemId.get(item.id) ?? [])]
      .sort((left, right) => compareEvidence(left, right, channelWeights));
    return {
      item,
      evidence: itemEvidence,
      score: itemEvidence.reduce((total, record) => total + evidenceScore(record, channelWeights), 0),
      reasons: itemEvidence.map((record) => record.reason).filter(Boolean),
    };
  });

  const ranked = scored.sort((left, right) => {
    const leftPinned = left.evidence.some((record) => pinnedChannels.has(record.channel));
    const rightPinned = right.evidence.some((record) => pinnedChannels.has(record.channel));
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    const byScore = right.score - left.score;
    if (byScore !== 0) return byScore;
    return (itemOrder.get(left.item.id) ?? 0) - (itemOrder.get(right.item.id) ?? 0);
  });

  return typeof options.limit === 'number' ? ranked.slice(0, options.limit) : ranked;
}

export function createLibraryQualityEvidence(items: LibraryItem[]): RecommendationEvidence[] {
  return items.map((item) => {
    const rating = finiteOr(item.rating ?? NaN, 0);
    const strength = rating > 0 ? Math.min(1, Math.round((rating / 10) * 100) / 100) : 0.4;
    return {
      itemId: item.id,
      channel: LIBRARY_QUALITY_CHANNEL,
      strength,
      reason: rating > 0 ? 'Highly rated in your library' : 'Recommended from your library',
      metadata: rating > 0 ? { rating } : undefined,
    };
  });
}

export function toRecommendedItems(scored: ScoredRecommendation<LibraryItem>[]): RecommendedItem[] {
  return scored.map(({ item, evidence, score, reasons }) => ({
    ...item,
    recommendationEvidence: evidence,
    recommendationScore: score,
    recommendationReasons: reasons,
  }));
}
