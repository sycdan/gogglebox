import { pickGroupAnchorIndex } from './continueWatching';
import { EpisodeItem } from './jellyfin';
import { ContinueWatchingItem, FamilyMember } from './types';

const debugEnabled = process.env.JELLYFIN_DEBUG === '1' || process.env.JELLYFIN_DEBUG === 'true';

function debug(message: string): void {
  if (debugEnabled) {
    console.log(`[anchor] ${message}`);
  }
}

function sxxexx(season: number | null, episode: number | null): string {
  return `S${String(season ?? 0).padStart(2, '0')}E${String(episode ?? 0).padStart(2, '0')}`;
}

// Minimal slice of the Jellyfin client that anchorShowCards depends on. Declared
// as an interface so the anchoring logic can be unit-tested with a fake client
// at the per-viewer played-state boundary (the exact seam where the "which
// viewers feed the anchor" wiring bug lived).
export interface SeriesPlayedStateClient {
  listSeriesEpisodesPlayedState(
    userId: string,
    seriesId: string,
  ): Promise<{ episode: EpisodeItem; played: boolean }[]>;
}

// Re-anchor each SHOW card to the group's stable episode: the EARLIEST episode
// (air order) that NOT every active viewer has watched. Each viewer's Resume /
// NextUp only exposes the ONE episode they are currently on, and the merge step
// collapses a series to a SINGLE candidate (the furthest-along viewer), so the
// merged card's episode is NOT the group's earliest-needed one. Here we read
// EVERY active viewer's FULL played state across the series (not just the
// surviving candidate's viewer) and anchor to the first episode at least one of
// them hasn't watched, so the displayed episode is stable under single-viewer
// watched toggles and reflects the whole active group. A card where every active
// viewer has watched every episode drops out (null). Movies pass through.
export async function anchorShowCards(
  client: SeriesPlayedStateClient,
  items: ContinueWatchingItem[],
  viewers: FamilyMember[],
): Promise<ContinueWatchingItem[]> {
  const resolved = await Promise.all(
    items.map(async (item) => {
      if (item.type !== 'show' || !item.seriesId) {
        debug(
          `SKIP card id=${item.id} name=${JSON.stringify(item.name)} type=${item.type} ` +
          `seriesId=${JSON.stringify(item.seriesId)} season=${item.seasonNumber} episode=${item.episodeNumber} ` +
          `progress=${item.progressPercent} reason=${item.type !== 'show' ? 'not-a-show' : 'no-seriesId'}`,
        );
        return item;
      }

      const seriesId = item.seriesId;
      debug(
        `card id=${item.id} name=${JSON.stringify(item.name)} seriesId=${seriesId} ` +
        `current=${sxxexx(item.seasonNumber, item.episodeNumber)} progress=${item.progressPercent} ` +
        `-> anchoring over ${viewers.length} viewer(s): ${viewers.map((v) => v.name).join(',')}`,
      );

      // CRITICAL: walk played-state for the FULL active viewer group, not just
      // the merged candidate's viewer. This is what makes a viewer who is BEHIND
      // (and whose candidate was dropped in the merge) pull the anchor back to
      // the earliest episode they still need.
      const perViewer = await Promise.all(
        viewers.map((viewer) => client.listSeriesEpisodesPlayedState(viewer.jellyfinUserId, seriesId)),
      );

      const anchorIndex = pickGroupAnchorIndex(
        perViewer.map((list) => list.map((entry) => ({ id: entry.episode.id, played: entry.played }))),
      );
      if (anchorIndex === -1) {
        // Everyone has watched every episode -> nothing left to continue; drop.
        debug(`card seriesId=${seriesId} DROPPED (all active viewers watched every episode)`);
        return null;
      }

      // All viewers share the same episode list/order; take the anchor from the
      // first viewer that actually has it.
      const source = perViewer.find((list) => list[anchorIndex])?.[anchorIndex];
      if (!source) {
        debug(`card seriesId=${seriesId} anchorIndex=${anchorIndex} but no viewer has that episode; leaving untouched`);
        return item;
      }
      const anchor = source.episode;

      // Keep the source viewer's resume progress only if the anchor IS the
      // episode they were resuming; otherwise this is a fresh (0%) episode for
      // the group.
      const keepsProgress = anchor.id === item.id;
      debug(
        `card seriesId=${seriesId} anchorIndex=${anchorIndex} ` +
        `${sxxexx(item.seasonNumber, item.episodeNumber)}(${item.id}) -> ${sxxexx(anchor.seasonNumber, anchor.episodeNumber)}(${anchor.id}) ` +
        `keepsProgress=${keepsProgress}`,
      );
      return {
        ...item,
        id: anchor.id,
        name: anchor.name,
        overview: anchor.overview,
        runtimeMinutes: anchor.runtimeMinutes,
        imageUrl: anchor.imageUrl,
        seriesId: anchor.seriesId || item.seriesId,
        seriesName: anchor.seriesName || item.seriesName,
        seasonNumber: anchor.seasonNumber,
        episodeNumber: anchor.episodeNumber,
        playbackPositionTicks: keepsProgress ? item.playbackPositionTicks : 0,
        progressPercent: keepsProgress ? item.progressPercent : 0,
      };
    }),
  );

  return resolved.filter((item): item is ContinueWatchingItem => item !== null);
}
