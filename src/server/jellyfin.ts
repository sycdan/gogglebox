import crypto from 'node:crypto';

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

interface JellyfinSessionRecord {
  UserId?: string;
  UserName?: string;
  NowPlayingItem?: JellyfinItem;
  PlayState?: {
    PositionTicks?: number;
  };
}

// A compact, normalized view of an active Jellyfin playback session for the
// Stage B watched fan-out poller. positionTicks/runtimeTicks are 0 when unknown.
export interface PlayerSessionProgress {
  userId: string;
  userName: string;
  itemId: string;
  positionTicks: number;
  runtimeTicks: number;
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

export interface PlayerSessionToken {
  accessToken: string;
  userId: string;
  serverId: string;
}

export class JellyfinClient {
  // Base URL normalized to ALWAYS end in a trailing slash. Without this, a
  // configured base path (e.g. http://host:8096/jf) is silently dropped:
  // `new URL('/Users', 'http://host:8096/jf')` resolves to
  // 'http://host:8096/Users' because the leading-slash pathname is absolute.
  // With a trailing slash + relative (no leading slash) pathnames, the base
  // path is preserved: `new URL('Users', 'http://host:8096/jf/')` ->
  // 'http://host:8096/jf/Users'. A no-path base behaves identically to
  // before.
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  }

  // Build a Jellyfin API URL that preserves any base path. Accepts pathnames
  // with or without a leading slash; the leading slash is stripped so the
  // pathname joins RELATIVE to the (trailing-slash) base, keeping the base path.
  private apiUrl(pathname: string): URL {
    return new URL(pathname.replace(/^\/+/, ''), this.baseUrl);
  }

  private async request<T>(pathname: string, query: URLSearchParams = new URLSearchParams(), init?: RequestInit): Promise<T> {
    const url = this.apiUrl(pathname);
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

  // Relative to the /player same-origin proxy mount (see server.ts), NOT
  // this.baseUrl: the browser fetches this directly, and JELLYFIN_URL is
  // often a LAN-only host (unreachable from outside the LAN).
  // Caddy's `handle_path /player/*` strips the prefix and forwards to the
  // same Jellyfin upstream apiUrl() targets server-side.
  private buildImageUrl(itemId: string, tag?: string): string | null {
    if (!tag) {
      return null;
    }

    const params = new URLSearchParams({
      quality: '90',
      fillWidth: '480',
      fillHeight: '720',
      tag,
      api_key: this.apiKey,
    });
    return `/player/Items/${itemId}/Images/Primary?${params.toString()}`;
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

  // Episodes of a single series, optionally keyword-filtered. `ParentId` scopes
  // EVERY call (including the searchTerm branch) to this one seriesId, so a
  // keyword search here can never surface episodes from other shows — Jellyfin
  // applies SearchTerm as an additional filter on top of the ParentId scope,
  // it never widens the result set beyond it.
  async listEpisodes(seriesId: string, searchTerm?: string): Promise<EpisodeItem[]> {
    const query = new URLSearchParams({
      Recursive: 'true',
      ParentId: seriesId,
      SortBy: 'PremiereDate,ParentIndexNumber,IndexNumber,SortName',
      SortOrder: 'Ascending',
      IncludeItemTypes: 'Episode',
      Fields: 'Overview,RunTimeTicks,ImageTags,SeriesId,SeriesName,ParentIndexNumber,IndexNumber',
    });

    if (searchTerm) {
      query.set('SearchTerm', searchTerm);
    }

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

  // Best-effort current playback progress for an item across active Jellyfin
  // sessions. Returns null when the item is not currently being played.
  async getPlaybackProgressForItem(itemId: string): Promise<number | null> {
    const sessions = await this.request<JellyfinSessionRecord[]>('/Sessions');
    let maxProgress: number | null = null;

    for (const session of sessions) {
      const nowPlaying = session.NowPlayingItem;
      if (!nowPlaying || nowPlaying.Id !== itemId) {
        continue;
      }

      const runtimeTicks = nowPlaying.RunTimeTicks ?? 0;
      const positionTicks = session.PlayState?.PositionTicks ?? nowPlaying.UserData?.PlaybackPositionTicks ?? 0;
      if (runtimeTicks <= 0) {
        continue;
      }

      const progress = Math.max(0, Math.min(1, positionTicks / runtimeTicks));
      maxProgress = maxProgress == null ? progress : Math.max(maxProgress, progress);
    }

    return maxProgress;
  }

  // Active Jellyfin playback sessions normalized for the Stage B fan-out poller:
  // one entry per session that has a NowPlayingItem, carrying the session's
  // UserId and the item's position/runtime ticks. Sessions without an item are
  // omitted (nothing to fan out).
  async listSessions(): Promise<PlayerSessionProgress[]> {
    const sessions = await this.request<JellyfinSessionRecord[]>('/Sessions');
    const out: PlayerSessionProgress[] = [];

    for (const session of sessions) {
      const nowPlaying = session.NowPlayingItem;
      if (!nowPlaying?.Id || !session.UserId) {
        continue;
      }

      out.push({
        userId: session.UserId,
        userName: session.UserName ?? '',
        itemId: nowPlaying.Id,
        positionTicks: session.PlayState?.PositionTicks ?? nowPlaying.UserData?.PlaybackPositionTicks ?? 0,
        runtimeTicks: nowPlaying.RunTimeTicks ?? 0,
      });
    }

    return out;
  }

  // Same /player-relative rationale as buildImageUrl above.
  private buildUserAvatarUrl(userId: string, tag?: string): string | null {
    if (!tag) {
      return null;
    }

    const params = new URLSearchParams({ tag, api_key: this.apiKey });
    return `/player/Users/${userId}/Images/Primary?${params.toString()}`;
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

  // The Jellyfin base path (e.g. "/jf"), derived from the configured base
  // URL's pathname, WITHOUT a trailing slash. Empty string when no base path.
  private get basePath(): string {
    const pathname = new URL(this.baseUrl).pathname;
    return pathname === '/' ? '' : pathname.replace(/\/$/, '');
  }

  // Build the player URL as an ORIGIN-RELATIVE path so the client opens it on
  // the CURRENT browser origin (the same-origin proxy), NOT the internal
  // Jellyfin host. In normal Gogglebox deployments this returns /web/... and the
  // server route below mounts it under /player.
  buildPlaybackUrl(itemId: string, startPositionTicks?: number): string {
    const params = new URLSearchParams({
      id: itemId,
      play: 'true',
      autoplay: 'true',
    });

    if (Number.isFinite(startPositionTicks) && Number(startPositionTicks) > 0) {
      const ticks = Math.floor(Number(startPositionTicks));
      params.set('resume', 'true');
      params.set('startPositionTicks', String(ticks));
      // Keep both names for compatibility across Jellyfin web route versions.
      params.set('startTimeTicks', String(ticks));
    }

    // Jellyfin 10.11 routes item pages under "#/details". The old
    // "#!/video/video.html" hashbang route is not available in newer builds
    // and can land on a page-not-found screen.
    return `${this.basePath}/web/index.html#/details?${params.toString()}`;
  }

  // --- Per-party playback user (Stage A) ----------------------------------
  //
  // gbx owns a dedicated Jellyfin user PER PARTY (username gbx-grp-<partyId>).
  // The "gbx-grp-" username prefix predates the group -> party rename and is
  // left EXACTLY as-is: it is real, already-minted Jellyfin state for every
  // existing deployment, and this effort does not change how parties map to
  // Jellyfin users. We persist only the party->jellyfinUserId mapping (never
  // passwords): the password is random, rotated on every mint, used
  // immediately, never stored.

  // The deterministic Jellyfin username for a party's gbx-owned playback user.
  // Public so the server can pass it to rotatePasswordAndAuthenticate. The
  // "gbx-grp-" prefix is intentionally unchanged by the group -> party rename
  // (see note above).
  partyUserName(partyId: string): string {
    return `gbx-grp-${partyId}`;
  }

  // JF 10.9.11 validates these provider ids as REQUIRED on a UserPolicy update
  // (POST /Users/{id}/Policy). Omitting them returns
  // 400 "PasswordResetProviderId field is required". These are Jellyfin's
  // built-in defaults, which is what a normally-created user already uses.
  private static readonly DEFAULT_AUTH_PROVIDER_ID =
    'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider';
  private static readonly DEFAULT_PASSWORD_RESET_PROVIDER_ID =
    'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider';

  // Find (or create) the gbx-owned Jellyfin user for a party and return its id.
  // Idempotent: an existing user is reused. Newly created users are granted
  // access to all libraries and confirmed enabled.
  async ensurePartyUser(partyId: string): Promise<string> {
    const name = this.partyUserName(partyId);
    const users = await this.request<JellyfinUserRecord[]>('/Users');
    const existing = users.find((user) => user.Name === name);
    if (existing) {
      return existing.Id;
    }

    const created = await this.request<JellyfinUserRecord>('/Users/New', new URLSearchParams(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Name: name }),
    });

    // Grant library access; ensure the account is not disabled. The provider ids
    // are REQUIRED by JF 10.9.11's policy validation (cold-create path otherwise
    // 400s on the first mint with "PasswordResetProviderId field is required").
    await this.request(`/Users/${created.Id}/Policy`, new URLSearchParams(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        IsDisabled: false,
        EnableAllFolders: true,
        EnabledFolders: [],
        AuthenticationProviderId: JellyfinClient.DEFAULT_AUTH_PROVIDER_ID,
        PasswordResetProviderId: JellyfinClient.DEFAULT_PASSWORD_RESET_PROVIDER_ID,
      }),
    });

    return created.Id;
  }

  // Rotate the per-party user's password to a fresh random value, then
  // authenticate as that user to obtain a short-lived access token. The password
  // is used immediately and never persisted. Returns the token + identity the
  // client needs to seed Jellyfin-web's localStorage.
  async rotatePasswordAndAuthenticate(
    userId: string,
    name: string,
    deviceId: string,
  ): Promise<PlayerSessionToken> {
    const newPassword = crypto.randomBytes(24).toString('base64url');

    // Admin reset to clear any existing password (newly created users have an
    // empty password; ResetPassword:true is a safe no-op then), then set the
    // fresh password. On 10.9.11 the admin set-password call does not require
    // CurrentPw when ResetPassword cleared it first.
    await this.request(`/Users/${userId}/Password`, new URLSearchParams(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ResetPassword: true }),
    });
    await this.request(`/Users/${userId}/Password`, new URLSearchParams(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CurrentPw: '', NewPw: newPassword }),
    });

    const auth = await this.request<{
      AccessToken?: string;
      ServerId?: string;
      User?: { Id?: string };
    }>('/Users/AuthenticateByName', new URLSearchParams(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Emby-Authorization':
          `MediaBrowser Client="Gogglebox", Device="Gogglebox-Player", DeviceId="${deviceId}", Version="1.0"`,
      },
      body: JSON.stringify({ Username: name, Pw: newPassword }),
    });

    if (!auth?.AccessToken || !auth.User?.Id) {
      throw new Error('Jellyfin did not return an access token for the party user');
    }

    return {
      accessToken: auth.AccessToken,
      userId: auth.User.Id,
      serverId: auth.ServerId ?? '',
    };
  }
}
