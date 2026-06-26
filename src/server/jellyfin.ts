import { ContinueWatchingItem, FamilyMember, LibraryItem, LibraryKind } from './types';

interface JellyfinUserRecord {
  Id: string;
  Name: string;
  PrimaryImageTag?: string;
}

interface JellyfinListResponse<T> {
  Items: T[];
}

interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  Overview?: string;
  Genres?: string[];
  CommunityRating?: number;
  RunTimeTicks?: number;
  PremiereDate?: string;
  ProductionYear?: number;
  OfficialRating?: string;
  ImageTags?: {
    Primary?: string;
    Backdrop?: string;
  };
  BackdropImageTags?: string[];
  SeriesId?: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  UserData?: {
    PlaybackPositionTicks?: number;
    PlayedPercentage?: number;
    Played?: boolean;
  };
}

interface JellyfinNextUpResponse {
  Items: JellyfinItem[];
}

export interface EpisodeItem {
  id: string;
  name: string;
  seriesId: string;
  seriesName: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  runtimeMinutes: number | null;
  overview: string;
  imageUrl: string | null;
}

export interface JellyfinContinueWatchingItem extends Omit<ContinueWatchingItem, 'sourceViewerId' | 'sourceViewerName'> { }

const jellyfinDebugEnabled = process.env.JELLYFIN_DEBUG === '1' || process.env.JELLYFIN_DEBUG === 'true';
let jellyfinRequestSequence = 0;

function sxxexxOf(season: number | null, episode: number | null): string {
  return `S${String(season ?? 0).padStart(2, '0')}E${String(episode ?? 0).padStart(2, '0')}`;
}

function toRuntimeMinutes(runTimeTicks?: number): number | null {
  if (!runTimeTicks) {
    return null;
  }

  return Math.round(runTimeTicks / 600000000);
}

export class JellyfinClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) { }

  private async request<T>(pathname: string, query: URLSearchParams = new URLSearchParams(), init?: RequestInit): Promise<T> {
    const url = new URL(pathname, this.baseUrl);
    query.forEach((value, key) => {
      url.searchParams.set(key, value);
    });

    const requestId = ++jellyfinRequestSequence;
    const startedAt = Date.now();
    if (jellyfinDebugEnabled) {
      console.log(`[jellyfin:${requestId}] -> ${(init?.method ?? 'GET').toUpperCase()} ${pathname}${url.search ? `?${url.searchParams.toString()}` : ''}`);
    }

    const response = await fetch(url, {
      ...init,
      headers: {
        'X-Emby-Token': this.apiKey,
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      if (jellyfinDebugEnabled) {
        console.log(`[jellyfin:${requestId}] <- ${response.status} ${pathname} (${Date.now() - startedAt}ms)`);
      }
      throw new Error(`Jellyfin request failed (${response.status}): ${body.slice(0, 200)}`);
    }

    if (response.status === 204) {
      if (jellyfinDebugEnabled) {
        console.log(`[jellyfin:${requestId}] <- 204 ${pathname} (${Date.now() - startedAt}ms)`);
      }
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      if (jellyfinDebugEnabled) {
        console.log(`[jellyfin:${requestId}] <- ${response.status} ${pathname} (${Date.now() - startedAt}ms, empty)`);
      }
      return undefined as T;
    }

    const parsed = JSON.parse(text) as T;
    if (jellyfinDebugEnabled) {
      const itemCount = typeof parsed === 'object' && parsed !== null && 'Items' in parsed && Array.isArray((parsed as { Items?: unknown[] }).Items)
        ? ((parsed as { Items: unknown[] }).Items.length)
        : undefined;
      console.log(
        `[jellyfin:${requestId}] <- ${response.status} ${pathname} (${Date.now() - startedAt}ms${typeof itemCount === 'number' ? `, items=${itemCount}` : ''})`,
      );
    }

    return parsed;
  }

  private buildImageUrl(itemId: string, tag?: string): string | null {
    if (!tag) {
      return null;
    }

    const url = new URL(`/Items/${itemId}/Images/Primary`, this.baseUrl);
    url.searchParams.set('quality', '90');
    url.searchParams.set('fillWidth', '480');
    url.searchParams.set('fillHeight', '720');
    url.searchParams.set('tag', tag);
    url.searchParams.set('api_key', this.apiKey);
    return url.toString();
  }

  private toLibraryItem(item: JellyfinItem, kind: LibraryKind): LibraryItem {
    return {
      id: item.Id,
      name: item.Name,
      type: kind,
      overview: item.Overview ?? '',
      year: item.ProductionYear ?? (item.PremiereDate ? new Date(item.PremiereDate).getFullYear() : null),
      runtimeMinutes: toRuntimeMinutes(item.RunTimeTicks),
      rating: item.CommunityRating ?? null,
      genres: item.Genres ?? [],
      officialRating: item.OfficialRating ?? null,
      imageUrl: this.buildImageUrl(item.Id, item.ImageTags?.Primary),
      backdropUrl: null,
      playable: item.Type === 'Movie',
    };
  }

  private toEpisodeItem(item: JellyfinItem): EpisodeItem {
    return {
      id: item.Id,
      name: item.Name,
      seriesId: item.SeriesId ?? '',
      seriesName: item.SeriesName ?? '',
      seasonNumber: typeof item.ParentIndexNumber === 'number' ? item.ParentIndexNumber : null,
      episodeNumber: typeof item.IndexNumber === 'number' ? item.IndexNumber : null,
      runtimeMinutes: toRuntimeMinutes(item.RunTimeTicks),
      overview: item.Overview ?? '',
      imageUrl: this.buildImageUrl(item.Id, item.ImageTags?.Primary),
    };
  }

  private toContinueWatchingItem(item: JellyfinItem): JellyfinContinueWatchingItem | null {
    const playbackPositionTicks = item.UserData?.PlaybackPositionTicks ?? 0;
    if (playbackPositionTicks <= 0 || item.UserData?.Played) {
      return null;
    }

    const progressFromTicks = item.RunTimeTicks ? playbackPositionTicks / item.RunTimeTicks : 0;
    const rawProgress =
      typeof item.UserData?.PlayedPercentage === 'number'
        ? item.UserData.PlayedPercentage / 100
        : progressFromTicks;
    const progressPercent = Math.max(0, Math.min(1, rawProgress));
    const isEpisode = item.Type === 'Episode';

    return {
      id: item.Id,
      name: item.Name,
      type: isEpisode ? 'show' : 'movie',
      overview: item.Overview ?? '',
      year: item.ProductionYear ?? (item.PremiereDate ? new Date(item.PremiereDate).getFullYear() : null),
      runtimeMinutes: toRuntimeMinutes(item.RunTimeTicks),
      rating: item.CommunityRating ?? null,
      genres: item.Genres ?? [],
      officialRating: item.OfficialRating ?? null,
      imageUrl: this.buildImageUrl(item.Id, item.ImageTags?.Primary),
      backdropUrl: null,
      playable: true,
      playbackPositionTicks,
      progressPercent,
      seriesId: isEpisode ? (item.SeriesId ?? null) : null,
      seriesName: isEpisode ? (item.SeriesName ?? null) : null,
      seasonNumber: isEpisode ? (typeof item.ParentIndexNumber === 'number' ? item.ParentIndexNumber : null) : null,
      episodeNumber: isEpisode ? (typeof item.IndexNumber === 'number' ? item.IndexNumber : null) : null,
    };
  }

  private toShowContinueFromNextUp(item: JellyfinItem): JellyfinContinueWatchingItem | null {
    if (item.Type !== 'Episode' || !item.SeriesId) {
      return null;
    }

    return {
      id: item.Id,
      name: item.Name,
      type: 'show',
      overview: item.Overview ?? '',
      year: item.ProductionYear ?? (item.PremiereDate ? new Date(item.PremiereDate).getFullYear() : null),
      runtimeMinutes: toRuntimeMinutes(item.RunTimeTicks),
      rating: item.CommunityRating ?? null,
      genres: item.Genres ?? [],
      officialRating: item.OfficialRating ?? null,
      imageUrl: this.buildImageUrl(item.Id, item.ImageTags?.Primary),
      backdropUrl: null,
      playable: true,
      playbackPositionTicks: 0,
      progressPercent: 0,
      seriesId: item.SeriesId,
      seriesName: item.SeriesName ?? null,
      seasonNumber: typeof item.ParentIndexNumber === 'number' ? item.ParentIndexNumber : null,
      episodeNumber: typeof item.IndexNumber === 'number' ? item.IndexNumber : null,
    };
  }

  async listItems(kind: LibraryKind, genre?: string, searchTerm?: string): Promise<LibraryItem[]> {
    const query = new URLSearchParams({
      Recursive: 'true',
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      IncludeItemTypes: kind === 'movie' ? 'Movie' : 'Series',
      Fields: 'Overview,Genres,CommunityRating,RunTimeTicks,PremiereDate,ProductionYear,OfficialRating,ImageTags',
    });

    if (genre) {
      query.set('Genres', genre);
    }

    if (searchTerm) {
      query.set('SearchTerm', searchTerm);
    }

    const data = await this.request<JellyfinListResponse<JellyfinItem>>('/Items', query);
    return data.Items.map((item) => this.toLibraryItem(item, kind));
  }

  // Resolve a set of item ids to their display names in a single request.
  // Ids that no longer resolve (e.g. deleted items) are simply omitted from the
  // returned map so callers can fall back to the raw id.
  async fetchItemNames(ids: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const uniqueIds = [...new Set(ids.filter((id) => id))];
    if (uniqueIds.length === 0) {
      return names;
    }

    const query = new URLSearchParams({
      Recursive: 'true',
      Ids: uniqueIds.join(','),
      Fields: '',
    });
    query.delete('Fields');

    const data = await this.request<JellyfinListResponse<JellyfinItem>>('/Items', query);
    for (const item of data.Items) {
      names.set(item.Id, item.Name);
    }

    return names;
  }

  async listEpisodes(seriesId: string): Promise<EpisodeItem[]> {
    const query = new URLSearchParams({
      Recursive: 'true',
      ParentId: seriesId,
      SortBy: 'PremiereDate,ParentIndexNumber,IndexNumber,SortName',
      SortOrder: 'Ascending',
      IncludeItemTypes: 'Episode',
      Fields: 'Overview,RunTimeTicks,ImageTags,SeriesId,SeriesName,ParentIndexNumber,IndexNumber',
    });

    const data = await this.request<JellyfinListResponse<JellyfinItem>>('/Items', query);
    return data.Items.map((item) => this.toEpisodeItem(item));
  }

  // The next episode after a given season/episode in a series' airing order, or
  // null when the given episode is the last one (or can't be located). Reuses
  // listEpisodes, which is already sorted ascending by air order, so this is a
  // deterministic "what comes next" lookup independent of any user's played
  // state. Specials/out-of-band episodes are positioned by that same ordering.
  async getNextEpisode(
    seriesId: string,
    seasonNumber: number | null,
    episodeNumber: number | null,
  ): Promise<EpisodeItem | null> {
    if (!seriesId) {
      return null;
    }

    const episodes = await this.listEpisodes(seriesId);
    const currentIndex = episodes.findIndex(
      (episode) => episode.seasonNumber === seasonNumber && episode.episodeNumber === episodeNumber,
    );

    if (currentIndex < 0 || currentIndex + 1 >= episodes.length) {
      return null;
    }

    return episodes[currentIndex + 1];
  }

  // A series' episodes in air order WITH a single user's played state, used to
  // find that user's "next unwatched episode" (the first air-order episode they
  // have not played). Fetched as the user (/Users/{id}/Items) so UserData.Played
  // reflects that viewer. Specials (Season 0) are excluded so the anchor lives in
  // the regular-season run that the card's SxxExx reflects.
  async listSeriesEpisodesPlayedState(
    userId: string,
    seriesId: string,
  ): Promise<{ episode: EpisodeItem; played: boolean }[]> {
    const query = new URLSearchParams({
      Recursive: 'true',
      ParentId: seriesId,
      // Sort by SEASON then EPISODE number (not PremiereDate) so the anchor walk
      // uses the SAME deterministic order the card's SxxExx reflects. Premiere-
      // date ordering can diverge from season/episode order (production vs air
      // order), which would mis-map a viewer's played episodes to the wrong index
      // and pick the wrong anchor.
      SortBy: 'ParentIndexNumber,IndexNumber',
      SortOrder: 'Ascending',
      IncludeItemTypes: 'Episode',
      // Cover even very long series in one page so index alignment across viewers
      // is exact (a truncated list would shift the anchor walk).
      Limit: '1000',
      EnableUserData: 'true',
      Fields: 'Overview,RunTimeTicks,ImageTags,SeriesId,SeriesName,ParentIndexNumber,IndexNumber,UserData',
    });

    const data = await this.request<JellyfinListResponse<JellyfinItem>>(`/Users/${userId}/Items`, query);
    const result = data.Items
      // Exclude Season 0 specials so the anchor stays in the regular-season run
      // (specials have no SxxExx with S>=1 and would mis-anchor the card).
      .filter((item) => typeof item.ParentIndexNumber === 'number' && item.ParentIndexNumber >= 1)
      // Defensive: enforce season/episode order client-side too, so the walk is
      // air-order even if the server's sort honoured a different field.
      .sort((a, b) =>
        ((a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0))
        || ((a.IndexNumber ?? 0) - (b.IndexNumber ?? 0)))
      .map((item) => ({
        episode: this.toEpisodeItem(item),
        played: Boolean(item.UserData?.Played),
      }));

    if (jellyfinDebugEnabled) {
      const compact = result
        .map((r) => `${sxxexxOf(r.episode.seasonNumber, r.episode.episodeNumber)}:${r.played ? 'W' : '.'}`)
        .join(' ');
      console.log(`[anchor] playedState user=${userId} series=${seriesId} count=${result.length} [${compact}]`);
    }

    return result;
  }

  async listContinueWatching(userId: string, kind: LibraryKind): Promise<JellyfinContinueWatchingItem[]> {
    const query = new URLSearchParams({
      Limit: '48',
      IncludeItemTypes: kind === 'movie' ? 'Movie' : 'Episode',
      Fields:
        'Overview,Genres,CommunityRating,RunTimeTicks,PremiereDate,ProductionYear,OfficialRating,ImageTags,SeriesId,SeriesName,ParentIndexNumber,IndexNumber,UserData',
    });

    const data = await this.request<JellyfinListResponse<JellyfinItem>>(`/Users/${userId}/Items/Resume`, query);
    return data.Items.map((item) => this.toContinueWatchingItem(item)).filter(
      (item): item is JellyfinContinueWatchingItem => item !== null,
    );
  }

  async listShowContinueWatching(userId: string): Promise<JellyfinContinueWatchingItem[]> {
    const [resumeItems, nextUpResponse] = await Promise.all([
      this.listContinueWatching(userId, 'show'),
      this.request<JellyfinNextUpResponse>('/Shows/NextUp',
        new URLSearchParams({
          UserId: userId,
          Limit: '48',
          Fields:
            'Overview,Genres,CommunityRating,RunTimeTicks,PremiereDate,ProductionYear,OfficialRating,ImageTags,SeriesId,SeriesName,ParentIndexNumber,IndexNumber,UserData',
        }),
      ),
    ]);

    const nextUpItems = nextUpResponse.Items
      .map((item) => this.toShowContinueFromNextUp(item))
      .filter((item): item is JellyfinContinueWatchingItem => item !== null);

    const selectedBySeries = new Map<string, JellyfinContinueWatchingItem>();

    for (const item of nextUpItems) {
      if (item.seriesId) {
        selectedBySeries.set(item.seriesId, item);
      }
    }

    for (const item of resumeItems) {
      if (!item.seriesId) {
        continue;
      }

      // Prefer in-progress resume entries over NextUp placeholders for a series.
      selectedBySeries.set(item.seriesId, item);
    }

    return [...selectedBySeries.values()];
  }

  async getWatchedItemIds(userId: string, kind: LibraryKind): Promise<Set<string>> {
    const query = new URLSearchParams({
      Recursive: 'true',
      Filters: 'IsPlayed',
      IncludeItemTypes: kind === 'movie' ? 'Movie' : 'Series,Episode',
      Fields: kind === 'movie' ? '' : 'SeriesId',
    });

    if (!query.get('Fields')) {
      query.delete('Fields');
    }

    const data = await this.request<JellyfinListResponse<JellyfinItem>>(`/Users/${userId}/Items`, query);
    const watchedIds = new Set<string>();

    for (const item of data.Items) {
      watchedIds.add(item.Id);
      if (kind === 'show' && item.SeriesId) {
        watchedIds.add(item.SeriesId);
      }
    }

    return watchedIds;
  }

  // Per-user played state of a single item, read from its UserData when fetched
  // as that user. Used to show which viewers have already watched the current
  // continue-watching episode. A missing/unresolvable item reads as not played.
  async getItemPlayedState(userId: string, itemId: string): Promise<boolean> {
    const query = new URLSearchParams({ Ids: itemId, Fields: 'UserData' });
    const data = await this.request<JellyfinListResponse<JellyfinItem>>(`/Users/${userId}/Items`, query);
    return Boolean(data.Items[0]?.UserData?.Played);
  }

  async markPlayed(userId: string, itemId: string): Promise<void> {
    await this.request(`/Users/${userId}/PlayedItems/${itemId}`, new URLSearchParams(), {
      method: 'POST',
    });
  }

  async markUnplayed(userId: string, itemId: string): Promise<void> {
    await this.request(`/Users/${userId}/PlayedItems/${itemId}`, new URLSearchParams(), {
      method: 'DELETE',
    });
  }

  async setPlaybackPosition(userId: string, itemId: string, playbackPositionTicks: number): Promise<void> {
    await this.request(`/Users/${userId}/Items/${itemId}/UserData`, new URLSearchParams(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        PlaybackPositionTicks: Math.max(0, Math.floor(playbackPositionTicks)),
        Played: false,
      }),
    });
  }

  private buildUserAvatarUrl(userId: string, tag?: string): string | null {
    if (!tag) {
      return null;
    }

    const url = new URL(`/Users/${userId}/Images/Primary`, this.baseUrl);
    url.searchParams.set('tag', tag);
    url.searchParams.set('api_key', this.apiKey);
    return url.toString();
  }

  async fetchUsers(): Promise<FamilyMember[]> {
    const data = await this.request<JellyfinUserRecord[]>('/Users');
    return data.map((user) => ({
      id: user.Id,
      name: user.Name,
      jellyfinUserId: user.Id,
      avatarUrl: this.buildUserAvatarUrl(user.Id, user.PrimaryImageTag),
    }));
  }

  async fetchMovieStream(itemId: string, rangeHeader?: string, signal?: AbortSignal): Promise<Response> {
    const url = new URL(`/Videos/${itemId}/stream`, this.baseUrl);
    url.searchParams.set('static', 'true');
    url.searchParams.set('api_key', this.apiKey);

    return fetch(url, {
      signal,
      headers: {
        'X-Emby-Token': this.apiKey,
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
    });
  }
}
