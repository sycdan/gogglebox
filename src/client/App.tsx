import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PlayerSessionPayload, seedJellyfinWebSession } from './jellyfinSession';
import { clickEl, discoverPlayControl, isPlaybackStarted } from './playerLaunch';

const playerStartMuted =
  import.meta.env.VITE_PLAYER_START_MUTED === '1' ||
  import.meta.env.VITE_PLAYER_START_MUTED === 'true';
const playerHideStartingOverlay =
  import.meta.env.VITE_PLAYER_HIDE_STARTING_OVERLAY === '1' ||
  import.meta.env.VITE_PLAYER_HIDE_STARTING_OVERLAY === 'true';

type LibraryKind = 'movie' | 'show';

interface Viewer {
  id: string;
  jellyfinUserId: string;
  name: string;
  avatarUrl?: string | null;
  // Config v2: this account must supply this user's pin to add them to a group.
  pinRequired?: boolean;
}

interface LibraryItem {
  id: string;
  name: string;
  type: LibraryKind;
  overview: string;
  year: number | null;
  runtimeMinutes: number | null;
  rating: number | null;
  genres: string[];
  officialRating: string | null;
  imageUrl: string | null;
  backdropUrl: string | null;
  playable: boolean;
}

interface EpisodeItem {
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

interface ActivePlaybackItem {
  id: string;
  title: string;
  subtitle?: string;
  url: string;
}

interface PlaybackProgressResponse {
  progressPercent: number | null;
  played: boolean;
}

// One ignored entry as returned by the server (see IgnoreEntry / GET
// /api/ignored): key is the exact id that was ignored (episode/series/movie id
// depending on scope), label is the display string captured at ignore-time.
interface IgnoredItem {
  key: string;
  label: string;
  ignoredAt: number;
}

interface ViewerWatchedState {
  viewerId: string;
  viewerName: string;
  avatarUrl?: string | null;
  watched: boolean;
}

interface ContinueWatchingItem extends LibraryItem {
  sourceViewerId: string;
  sourceViewerName: string;
  playbackPositionTicks: number;
  progressPercent: number;
  seriesId: string | null;
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  viewerWatched?: ViewerWatchedState[];
}

// One scoped ignore choice sent to POST /api/ignored: `key` is the exact id to
// match (episode id, series id, or movie id, depending on scope), matchSeriesId
// is true only for whole-show scope, and label is the display string shown in
// the Ignored panel.
interface IgnorePayload {
  key: string;
  matchSeriesId: boolean;
  label: string;
}

// A plain library item (recs/search rail) has no per-episode concept — it IS
// the series (or the movie), so ignoring it is always whole-show/movie scope.
function ignorePayloadForLibraryItem(item: LibraryItem): IgnorePayload {
  return { key: item.id, matchSeriesId: item.type === 'show', label: item.name };
}

// The two scoped ignore choices offered on a continue-watching SHOW card: the
// exact episode (hides only this one candidate) or the whole show (hides every
// past/future episode candidate for this series).
function ignorePayloadsForShowCard(item: ContinueWatchingItem): { episode: IgnorePayload; show: IgnorePayload | null } {
  const code = episodeCode(item.seasonNumber, item.episodeNumber);
  const seriesLabel = item.seriesName ?? item.name;
  return {
    episode: {
      key: item.id,
      matchSeriesId: false,
      label: `${seriesLabel}${code ? ` · ${code}` : ''} ${item.name}`.trim(),
    },
    show: item.seriesId
      ? { key: item.seriesId, matchSeriesId: true, label: seriesLabel }
      : null,
  };
}

// The single ignore choice offered on a continue-watching MOVIE card.
function ignorePayloadForMovieCard(item: ContinueWatchingItem): IgnorePayload {
  return { key: item.id, matchSeriesId: false, label: item.name };
}

interface SessionResponse {
  authenticated: boolean;
  portalAutoLoginEnabled: boolean;
  appName: string;
  watchedThreshold: number;
  // The logged-in account's username, or null when not authenticated.
  account: string | null;
  viewers: Viewer[];
  activeViewerIds: string[];
  // The active group's human-readable alias (never gbx-grp-<hash>), or null.
  activeGroupAlias: string | null;
}

// A managed group visible to the logged-in account, surfaced as a selectable
// "Saved group" on the picker. Identified by groupKey; shown by alias.
interface SavedGroup {
  groupKey: string;
  alias: string;
  memberIds: string[];
  memberNames: string[];
}

async function apiRequest<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const body = await response.json().catch(async () => ({ error: await response.text() }));
    throw new Error(body.error ?? 'Request failed');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function ViewerAvatar({ viewer }: { viewer: Viewer }) {
  const [imgFailed, setImgFailed] = useState(false);
  if (viewer.avatarUrl && !imgFailed) {
    return (
      <img
        className="viewer-avatar"
        src={viewer.avatarUrl}
        alt={viewer.name}
        onError={() => setImgFailed(true)}
      />
    );
  }
  return <span className="viewer-avatar">{viewer.name.slice(0, 1)}</span>;
}

const RAIL_PAGE_SIZE = 3;

// Keeps a single rail's page index local + simple. Clamps when the underlying
// list shrinks (e.g. a filter change) so we never page past the last group.
function usePager<T>(items: T[], pageSize = RAIL_PAGE_SIZE) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);

  useEffect(() => {
    if (page !== safePage) {
      setPage(safePage);
    }
  }, [page, safePage]);

  const start = safePage * pageSize;
  const visible = items.slice(start, start + pageSize);

  return {
    page: safePage,
    pageCount,
    visible,
    hasPrev: safePage > 0,
    hasNext: safePage < pageCount - 1,
    prev: () => setPage((current) => Math.max(0, current - 1)),
    next: () => setPage((current) => Math.min(pageCount - 1, current + 1)),
  };
}

function RailPager({
  page,
  pageCount,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: {
  page: number;
  pageCount: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (pageCount <= 1) {
    return null;
  }
  return (
    <div className="rail-pager">
      <button
        className="rail-arrow"
        type="button"
        onClick={onPrev}
        disabled={!hasPrev}
        aria-label="Previous"
      >
        ‹
      </button>
      <span className="rail-pager-status" aria-hidden="true">
        {page + 1}/{pageCount}
      </span>
      <button
        className="rail-arrow"
        type="button"
        onClick={onNext}
        disabled={!hasNext}
        aria-label="Next"
      >
        ›
      </button>
    </div>
  );
}

// Compact "S01E10" episode code for a show card's ignore-flyout label.
function episodeCode(seasonNumber: number | null, episodeNumber: number | null): string {
  if (!seasonNumber || !episodeNumber) {
    return '';
  }
  return `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
}

// "Ignore" button on a continue-watching card, with a small local-state popover
// offering scoped choices instead of a single blanket ignore. A movie card gets
// one choice ("Ignore movie"); a show card gets two ("Ignore this episode" /
// "Ignore this show"). Click a choice to submit and close; click elsewhere on
// the card (or Ignore again) to toggle closed.
function IgnoreFlyout({
  item,
  onIgnore,
}: {
  item: ContinueWatchingItem;
  onIgnore: (payload: IgnorePayload) => void;
}) {
  const [open, setOpen] = useState(false);

  function choose(payload: IgnorePayload) {
    setOpen(false);
    onIgnore(payload);
  }

  if (item.type === 'movie') {
    return (
      <div className="ignore-flyout">
        <button className="ghost" onClick={() => setOpen((current) => !current)} type="button">Ignore</button>
        {open ? (
          <div className="ignore-flyout-menu">
            <button type="button" onClick={() => choose(ignorePayloadForMovieCard(item))}>Ignore movie</button>
          </div>
        ) : null}
      </div>
    );
  }

  const { episode, show } = ignorePayloadsForShowCard(item);
  return (
    <div className="ignore-flyout">
      <button className="ghost" onClick={() => setOpen((current) => !current)} type="button">Ignore</button>
      {open ? (
        <div className="ignore-flyout-menu">
          <button type="button" onClick={() => choose(episode)}>Ignore this episode</button>
          {show ? (
            <button type="button" onClick={() => choose(show)}>Ignore this show</button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [selectedViewerIds, setSelectedViewerIds] = useState<string[]>([]);
  // Managed groups visible to this account, shown as "Saved groups" on the picker.
  const [savedGroups, setSavedGroups] = useState<SavedGroup[]>([]);
  // Pins typed for selected pin-required viewers, keyed by viewer id.
  const [pins, setPins] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<LibraryKind>('show');
  const [genre, setGenre] = useState('');
  const [kidsOnly, setKidsOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<LibraryItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchRequestIdRef = useRef(0);
  const [continueWatching, setContinueWatching] = useState<ContinueWatchingItem[]>([]);
  const continueRequestIdRef = useRef(0);
  const [recommendations, setRecommendations] = useState<LibraryItem[]>([]);
  const [noMorePicks, setNoMorePicks] = useState(false);
  const [picksLoading, setPicksLoading] = useState(false);
  const shownRecommendationIdsRef = useRef<Set<string>>(new Set());
  const [ignoredItems, setIgnoredItems] = useState<IgnoredItem[]>([]);
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const [selectedSeries, setSelectedSeries] = useState<LibraryItem | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeItem[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [playingItem, setPlayingItem] = useState<ActivePlaybackItem | null>(null);
  const [playerStarted, setPlayerStarted] = useState(false);
  const [playerNeedsUserStart, setPlayerNeedsUserStart] = useState(false);
  const playerFrameRef = useRef<HTMLIFrameElement | null>(null);
  const playerModalRef = useRef<HTMLDivElement | null>(null);
  const [autoMarked, setAutoMarked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [credentials, setCredentials] = useState({ username: '', password: '' });

  // Per-rail pagination (3 tiles per page) so rails stay roomy, not cramped.
  const continuePager = usePager(continueWatching);
  const recommendationsPager = usePager(recommendations);

  async function loadSession() {
    const nextSession = await apiRequest<SessionResponse>('/api/session');
    setSession(nextSession);
    setSelectedViewerIds(nextSession.activeViewerIds);
  }

  async function loadSavedGroups() {
    try {
      const response = await apiRequest<{ groups: SavedGroup[] }>('/api/groups');
      setSavedGroups(response.groups);
    } catch {
      // A failed groups load shouldn't block the picker — just show none.
      setSavedGroups([]);
    }
  }

  async function attemptAutoLogin() {
    await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await loadSession();
  }

  async function loadLibraryAndRecommendations(activeSession: SessionResponse, nextKind: LibraryKind, nextGenre: string, nextKidsOnly: boolean) {
    const params = new URLSearchParams({ kind: nextKind });
    if (nextGenre) {
      params.set('genre', nextGenre);
    }
    if (nextKidsOnly) {
      params.set('kidsOnly', 'true');
    }

    setNoMorePicks(false);
    if (activeSession.activeViewerIds.length > 0) {
      const recommendationsResponse = await apiRequest<{ items: LibraryItem[] }>(`/api/recommendations?${params.toString()}`);
      setRecommendations(recommendationsResponse.items);
      recommendationsResponse.items.forEach((item) => shownRecommendationIdsRef.current.add(item.id));
    } else {
      setRecommendations([]);
    }
  }

  async function showOtherPicks() {
    if (!session || session.activeViewerIds.length === 0) {
      return;
    }

    const params = new URLSearchParams({ kind });
    if (genre) {
      params.set('genre', genre);
    }
    if (kidsOnly) {
      params.set('kidsOnly', 'true');
    }
    const shownIds = [...shownRecommendationIdsRef.current];
    if (shownIds.length > 0) {
      params.set('exclude', shownIds.join(','));
    }

    try {
      setPicksLoading(true);
      setError(null);
      const recommendationsResponse = await apiRequest<{ items: LibraryItem[] }>(`/api/recommendations?${params.toString()}`);
      if (recommendationsResponse.items.length === 0) {
        setNoMorePicks(true);
        return;
      }
      setRecommendations(recommendationsResponse.items);
      recommendationsResponse.items.forEach((item) => shownRecommendationIdsRef.current.add(item.id));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not load more picks');
    } finally {
      setPicksLoading(false);
    }
  }

  async function loadContinueWatching(activeSession: SessionResponse) {
    // Sequence concurrent loads: a later request always wins, so a stale
    // refetch (e.g. from rapid pill toggles) can never overwrite fresher data.
    const requestId = (continueRequestIdRef.current += 1);
    if (activeSession.activeViewerIds.length > 0) {
      const continueResponse = await apiRequest<{ items: ContinueWatchingItem[] }>('/api/continue-watching');
      if (requestId !== continueRequestIdRef.current) return;
      setContinueWatching(continueResponse.items);
    } else {
      if (requestId !== continueRequestIdRef.current) return;
      setContinueWatching([]);
    }
  }

  async function loadIgnoredItems(activeSession: SessionResponse) {
    if (activeSession.activeViewerIds.length > 0) {
      const response = await apiRequest<{ items: IgnoredItem[] }>('/api/ignored');
      setIgnoredItems(response.items);
    } else {
      setIgnoredItems([]);
    }
  }

  async function ignore(item: LibraryItem) {
    await submitIgnore(ignorePayloadForLibraryItem(item));
  }

  async function submitIgnore(payload: IgnorePayload) {
    try {
      await apiRequest<{ items: IgnoredItem[] }>('/api/ignored', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (session) {
        await Promise.all([
          loadIgnoredItems(session),
          loadLibraryAndRecommendations(session, kind, genre, kidsOnly),
          loadContinueWatching(session),
        ]);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not ignore');
    }
  }

  async function unignore(key: string) {
    try {
      await apiRequest<{ items: IgnoredItem[] }>(`/api/ignored/${key}`, {
        method: 'DELETE',
      });
      if (session) {
        await Promise.all([
          loadIgnoredItems(session),
          loadLibraryAndRecommendations(session, kind, genre, kidsOnly),
          loadContinueWatching(session),
        ]);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not unignore');
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        setLoading(true);
        await loadSession();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Could not load session');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    shownRecommendationIdsRef.current = new Set();
    setNoMorePicks(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.activeViewerIds.join(',')]);

  // Refresh the picker's "Saved groups" whenever we land on the picker (logged
  // in, no active group). Re-runs after activating/clearing a group so a newly
  // created group shows up on the next visit.
  useEffect(() => {
    if (session?.authenticated && session.activeViewerIds.length === 0) {
      void loadSavedGroups();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated, session?.activeViewerIds.join(',')]);

  useEffect(() => {
    if (!session?.authenticated) {
      return;
    }

    void (async () => {
      try {
        setLibraryLoading(true);
        setError(null);
        await loadLibraryAndRecommendations(session, kind, genre, kidsOnly);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Could not load library');
      } finally {
        setLibraryLoading(false);
      }
    })();
  }, [session, kind, genre, kidsOnly]);

  useEffect(() => {
    if (!session?.authenticated) {
      return;
    }

    void (async () => {
      try {
        await Promise.all([loadContinueWatching(session), loadIgnoredItems(session)]);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Could not load continue watching');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated, session?.activeViewerIds.join(',')]);

  useEffect(() => {
    if (!session?.authenticated) {
      return;
    }

    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery) {
      // Cancel any in-flight search and clear results.
      searchRequestIdRef.current += 1;
      setSearchLoading(false);
      setSearchResults([]);
      return;
    }

    setSearchLoading(true);
    const requestId = ++searchRequestIdRef.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        const params = new URLSearchParams({ kind, q: trimmedQuery });
        if (genre) {
          params.set('genre', genre);
        }
        if (kidsOnly) {
          params.set('kidsOnly', 'true');
        }
        try {
          const response = await apiRequest<{ items: LibraryItem[] }>(`/api/library?${params.toString()}`);
          // Ignore stale responses — only the latest request wins.
          if (requestId !== searchRequestIdRef.current) {
            return;
          }
          setSearchResults(response.items);
        } catch (nextError) {
          if (requestId !== searchRequestIdRef.current) {
            return;
          }
          setError(nextError instanceof Error ? nextError.message : 'Search failed');
          setSearchResults([]);
        } finally {
          if (requestId === searchRequestIdRef.current) {
            setSearchLoading(false);
          }
        }
      })();
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [session?.authenticated, searchQuery, kind, genre, kidsOnly]);

  useEffect(() => {
    if (!session || session.authenticated || !session.portalAutoLoginEnabled || busy) {
      return;
    }

    void (async () => {
      try {
        setBusy(true);
        setError(null);
        await attemptAutoLogin();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Auto login failed');
      } finally {
        setBusy(false);
      }
    })();
  }, [session, busy]);

  // Selected viewers (in this account's visible set) that require a PIN, so the
  // group builder can prompt for each one's PIN before forming the group.
  const pinRequiredSelected = useMemo(
    () =>
      (session?.viewers ?? []).filter(
        (viewer) => viewer.pinRequired && selectedViewerIds.includes(viewer.id),
      ),
    [session?.viewers, selectedViewerIds],
  );

  const availableGenres = useMemo(() => {
    const uniqueGenres = new Set<string>();
    [...recommendations, ...searchResults].forEach((item) =>
      item.genres.forEach((itemGenre) => uniqueGenres.add(itemGenre)),
    );
    return [...uniqueGenres].sort((left, right) => left.localeCompare(right));
  }, [recommendations, searchResults]);

  function toggleViewer(viewerId: string) {
    setSelectedViewerIds((current) =>
      current.includes(viewerId) ? current.filter((id) => id !== viewerId) : [...current, viewerId],
    );
  }

  // Select exactly a saved group's members. Any member that's pin_required for
  // this account surfaces a PIN prompt (via pinRequiredSelected); Continue then
  // activates the group, reusing the existing managed group (same key).
  function selectSavedGroup(group: SavedGroup) {
    const visibleIds = new Set((session?.viewers ?? []).map((viewer) => viewer.id));
    setSelectedViewerIds(group.memberIds.filter((id) => visibleIds.has(id)));
    setPins({});
    setError(null);
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      setBusy(true);
      setError(null);
      await apiRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      });
      await loadSession();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  async function saveGroup(memberIds: string[], pins: Record<string, string> = {}) {
    try {
      setBusy(true);
      setError(null);
      await apiRequest('/api/group', {
        method: 'POST',
        body: JSON.stringify({ memberIds, pins }),
      });
      await loadSession();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not save viewer group');
    } finally {
      setBusy(false);
    }
  }

  async function clearGroup() {
    try {
      setBusy(true);
      setError(null);
      await apiRequest('/api/group/clear', {
        method: 'POST',
      });
      setPins({});
      await loadSession();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not clear viewer group');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      setBusy(true);
      await apiRequest('/api/auth/logout', { method: 'POST' });
      setSession(null);
      setSelectedViewerIds([]);
      setPins({});
      await loadSession();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not sign out');
    } finally {
      setBusy(false);
    }
  }

  async function markWatched(itemId: string) {
    await apiRequest(`/api/items/${itemId}/watched`, { method: 'POST' });
    if (session) {
      await loadSession();
      await Promise.all([
        loadLibraryAndRecommendations(session, kind, genre, kidsOnly),
        loadContinueWatching(session),
      ]);
    }
  }

  // Toggle one viewer's watched state for a continue-watching card's current
  // item. Optimistically flips the pill, then reconciles on failure.
  async function toggleViewerWatched(item: ContinueWatchingItem, viewer: ViewerWatchedState) {
    const nextWatched = !viewer.watched;
    const applyWatched = (value: boolean) =>
      setContinueWatching((current) =>
        current.map((card) =>
          card.id === item.id && card.sourceViewerId === item.sourceViewerId
            ? {
              ...card,
              viewerWatched: card.viewerWatched?.map((entry) =>
                entry.viewerId === viewer.viewerId ? { ...entry, watched: value } : entry,
              ),
            }
            : card,
        ),
      );

    applyWatched(nextWatched);
    try {
      await apiRequest(`/api/items/${item.id}/viewer-watched`, {
        method: 'POST',
        body: JSON.stringify({ viewerId: viewer.viewerId, watched: nextWatched }),
      });
      // /api/continue-watching re-reads Jellyfin's own live Resume/NextUp per
      // viewer, so a refetch is what makes the card advance (show -> next
      // episode) or drop (movie / last episode) live, without a reload. The
      // optimistic flip above keeps the pill snappy; this refetch is the
      // source of truth. loadContinueWatching sequences requests so rapid
      // toggles resolve to the latest result.
      if (session) {
        await loadContinueWatching(session);
      }
    } catch (nextError) {
      applyWatched(viewer.watched);
      setError(nextError instanceof Error ? nextError.message : 'Could not update watch state');
    }
  }

  async function openEpisodes(series: LibraryItem) {
    try {
      setEpisodesLoading(true);
      setError(null);
      setSelectedSeries(series);
      const response = await apiRequest<{ items: EpisodeItem[] }>(`/api/shows/${series.id}/episodes`);
      setEpisodes(response.items);
    } catch (nextError) {
      setSelectedSeries(null);
      setEpisodes([]);
      setError(nextError instanceof Error ? nextError.message : 'Could not load episodes');
    } finally {
      setEpisodesLoading(false);
    }
  }

  async function openPlayback({
    id,
    title,
    subtitle,
    startPositionTicks,
  }: {
    id: string;
    title: string;
    subtitle?: string;
    startPositionTicks?: number;
  }) {
    try {
      const params = new URLSearchParams();
      if (Number.isFinite(startPositionTicks) && Number(startPositionTicks) > 0) {
        params.set('startPositionTicks', String(Math.floor(Number(startPositionTicks))));
      }

      const query = params.toString();
      // Mint a fresh per-group Jellyfin playback session, then seed Jellyfin-web's
      // localStorage on THIS origin so the /player tab auto-logs-in, then resolve
      // the origin-relative playback path. Mint + seed happen right before open so
      // the rotated token is fresh.
      const [playerSession, response] = await Promise.all([
        apiRequest<PlayerSessionPayload>('/api/player/session', { method: 'POST' }),
        apiRequest<{ url: string }>(
          `/api/items/${id}/playback-url${query ? `?${query}` : ''}`,
        ),
      ]);

      seedJellyfinWebSession(window.localStorage, playerSession, window.location.origin);

      // Build the same-origin player URL. serverId is appended to the details
      // hash because some jellyfin-web routes need it to resolve the server.
      const playbackUrl = new URL(response.url, window.location.origin);
      if (playerSession.serverId) {
        // The route/item id lives in the hash (#/details?id=...), so add serverId
        // to the hash query, not the search string.
        const hash = playbackUrl.hash;
        playbackUrl.hash = hash.includes('serverId=')
          ? hash
          : `${hash}${hash.includes('?') ? '&' : '?'}serverId=${encodeURIComponent(playerSession.serverId)}`;
      }
      const playbackUrlStr = playbackUrl.toString();

      setAutoMarked(false);
      setPlayerStarted(false);
      setPlayerNeedsUserStart(false);
      setPlayingItem({
        id,
        title,
        subtitle,
        url: playbackUrlStr,
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not launch Jellyfin playback');
    }
  }

  async function startContinuePlayback(item: ContinueWatchingItem) {
    if (item.playbackPositionTicks > 0) {
      try {
        await apiRequest(`/api/items/${item.id}/progress/sync`, {
          method: 'POST',
          body: JSON.stringify({
            sourceViewerId: item.sourceViewerId,
            playbackPositionTicks: item.playbackPositionTicks,
          }),
        });
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Could not sync continue watching progress');
      }
    }

    await openPlayback({
      id: item.id,
      title: item.name,
      subtitle: item.type === 'show'
        ? `${item.seriesName ?? item.name}${item.seasonNumber && item.episodeNumber
          ? ` • S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')}`
          : ''}`
        : undefined,
      startPositionTicks: item.playbackPositionTicks,
    });
  }

  useEffect(() => {
    if (!playingItem || !session || autoMarked) {
      return;
    }

    let cancelled = false;
    let running = false;

    const poll = async () => {
      if (running || cancelled) {
        return;
      }

      running = true;
      try {
        const response = await apiRequest<PlaybackProgressResponse>(`/api/items/${playingItem.id}/playback-progress`);
        if (cancelled || autoMarked) {
          return;
        }

        if (response.played || (response.progressPercent != null && response.progressPercent >= session.watchedThreshold)) {
          setAutoMarked(true);
          await markWatched(playingItem.id);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : 'Could not poll playback progress');
        }
      } finally {
        running = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [playingItem, session, autoMarked]);

  useEffect(() => {
    if (!playingItem) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const raf = window.requestAnimationFrame(() => playerModalRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPlayingItem(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [playingItem]);

  const clickJellyfinPlayControl = useCallback((reason: string): boolean => {
    const frame = playerFrameRef.current;
    const win = frame?.contentWindow ?? null;
    let doc: Document | null = null;
    try {
      doc = win?.document ?? null;
    } catch {
      doc = null;
    }

    const jflog = (...args: unknown[]) => {
      try {
        (win as unknown as { console?: Console } | null)?.console?.log('[gbx-trigger]', ...args);
      } catch {
        /* ignore */
      }
    };

    if (!doc || !win) {
      jflog(reason + ': no same-origin document yet');
      return false;
    }

    const result = discoverPlayControl(
      doc as unknown as Parameters<typeof discoverPlayControl>[0],
    );
    if (!result.candidate) {
      jflog(reason + ': no play candidate');
      return false;
    }

    const el = result.candidate.el as unknown as {
      tagName?: string;
      getAttribute?: (n: string) => string | null;
      textContent?: string | null;
    };
    jflog(
      reason + ': clicking via=' + result.candidate.via +
      ' el=<' + (el.tagName ?? '').toLowerCase() +
      ' class="' + (el.getAttribute?.('class') ?? '') + '"' +
      ' title="' + (el.getAttribute?.('title') ?? '') + '"' +
      ' aria-label="' + (el.getAttribute?.('aria-label') ?? '') + '"' +
      ' data-action="' + (el.getAttribute?.('data-action') ?? '') + '"' +
      ' text="' + (el.textContent ?? '').trim().slice(0, 30) + '">',
    );

    const FrameMouseEvent = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
    return clickEl(result.candidate.el, () =>
      new FrameMouseEvent('click', { bubbles: true, cancelable: true, view: win }),
    );
  }, []);

  const installMutedAutoplay = useCallback((
    win: Window,
    doc: Document,
    jflog: (...args: unknown[]) => void,
  ) => {
    if (!playerStartMuted) {
      return;
    }

    const gbxWin = win as Window & {
      __gbxMutedAutoplayDoc?: Document;
      __gbxMutedAutoplayObserver?: MutationObserver;
    };

    if (gbxWin.__gbxMutedAutoplayDoc === doc) {
      return;
    }

    gbxWin.__gbxMutedAutoplayObserver?.disconnect();

    const tryPlayMuted = (video: HTMLVideoElement) => {
      video.muted = true;
      video.defaultMuted = true;
      video.volume = 0;
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');

      if (!video.paused && video.currentTime > 0) {
        return;
      }

      try {
        const result = video.play();
        if (result && typeof result.catch === 'function') {
          result.catch((error: unknown) => {
            jflog('muted autoplay play() rejected: ' + String(error));
          });
        }
      } catch (error) {
        jflog('muted autoplay play() threw: ' + String(error));
      }
    };

    const scan = () => {
      for (const video of Array.from(doc.querySelectorAll('video'))) {
        tryPlayMuted(video as HTMLVideoElement);
      }
    };

    scan();
    const Observer = (win as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    const target = doc.documentElement ?? doc.body;
    if (Observer && target) {
      const observer = new Observer(scan);
      observer.observe(target, { childList: true, subtree: true });
      gbxWin.__gbxMutedAutoplayObserver = observer;
    }
    gbxWin.__gbxMutedAutoplayDoc = doc;
    jflog('muted autoplay watcher installed');
  }, []);

  // Drive the same-origin Jellyfin-web iframe into ACTUAL playback. Opening the
  // details URL only lands on the details PAGE — jellyfin-web has no reliable
  // auto-START route, so once the iframe has auto-logged-in and BOUND the details
  // view, we reach into its same-origin document and click the primary Play
  // control (discoverPlayControl, which finds icon-only buttons too). We try as
  // soon as the iframe loads, keep short adaptive retries while Jellyfin binds
  // the details page, stop once a <video> is playing / the OSD is up, and
  // swallow cross-frame errors.
  //
  // Observability: this effect runs in the gbx TOP frame, so we log INTO THE
  // IFRAME'S OWN console (iframe.contentWindow.console.log('[gbx-trigger] ...'))
  // so the e2e flow's [jf-console] (frame-scoped) listener captures it.
  useEffect(() => {
    if (!playingItem) {
      return;
    }

    setPlayerStarted(false);

    let cancelled = false;
    let clickedOnce = false;
    let progressPollRunning = false;
    let lastProgressPollAt = 0;
    let lastPlaybackProgress: number | null = null;
    const startedAt = Date.now();
    const MAX_MS = 25_000;
    const pendingTimers = new Set<number>();
    const userStartTimer = window.setTimeout(() => {
      if (!cancelled) {
        setPlayerNeedsUserStart(true);
      }
    }, 6_000);

    const scheduleTick = (delayMs: number) => {
      if (cancelled || Date.now() - startedAt >= MAX_MS) {
        return;
      }
      const timer = window.setTimeout(() => {
        pendingTimers.delete(timer);
        tick();
      }, delayMs);
      pendingTimers.add(timer);
    };

    const pollPlaybackStarted = () => {
      const now = Date.now();
      if (progressPollRunning || now - lastProgressPollAt < 1000) {
        return;
      }
      lastProgressPollAt = now;
      progressPollRunning = true;
      apiRequest<PlaybackProgressResponse>(`/api/items/${playingItem.id}/playback-progress`)
        .then((response) => {
          if (cancelled || response.progressPercent == null) {
            return;
          }
          const nextProgress = response.progressPercent;
          if (lastPlaybackProgress != null && nextProgress > lastPlaybackProgress) {
            setPlayerStarted(true);
            setPlayerNeedsUserStart(false);
            return;
          }
          lastPlaybackProgress = nextProgress;
        })
        .catch(() => {
          /* best-effort overlay clearing; the watched-progress poll reports errors */
        })
        .finally(() => {
          progressPollRunning = false;
        });
    };

    const tick = () => {
      if (cancelled) {
        return;
      }
      pollPlaybackStarted();
      const frame = playerFrameRef.current;
      const win = frame?.contentWindow ?? null;
      let doc: Document | null = null;
      try {
        doc = win?.document ?? null;
      } catch {
        // Cross-origin access would throw — but /player is same-origin, so this
        // only happens transiently during navigation. Keep polling.
        doc = null;
      }

      // Log into the IFRAME's console so the frame-scoped proof listener sees it.
      const jflog = (...args: unknown[]) => {
        try {
          (win as unknown as { console?: Console } | null)?.console?.log('[gbx-trigger]', ...args);
        } catch {
          /* ignore */
        }
      };

      if (doc) {
        try {
          if (win) {
            installMutedAutoplay(win, doc, jflog);
          }

          const video = doc.querySelector('video') as HTMLVideoElement | null;
          if (video && playerStartMuted) {
            video.muted = true;
            video.defaultMuted = true;
            video.volume = 0;
            video.setAttribute('muted', '');
            video.setAttribute('playsinline', '');
            if (video.paused) {
              try {
                void video.play()?.catch((error: unknown) => {
                  jflog('muted playback retry rejected: ' + String(error));
                });
              } catch (error) {
                jflog('muted playback retry threw: ' + String(error));
              }
            }
          }

          const isFrameVisible = (el: Element | null): boolean => {
            if (!el || !win) return false;
            const rect = el.getBoundingClientRect();
            const style = win.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const osd = doc.querySelector('.videoOsd');
          const osdPresent = isFrameVisible(osd) && [
            'button',
            '[role="button"]',
            '[role="slider"]',
            '.sliderContainer',
            '.osdControls',
          ].some((selector) => isFrameVisible(osd?.querySelector(selector) ?? null));
          if (
            isPlaybackStarted({
              video: video ? { paused: video.paused, currentTime: video.currentTime } : null,
              osdPresent,
            })
          ) {
            jflog('playback started (osd=' + osdPresent + ', paused=' + (video ? video.paused : 'n/a') + ')');
            setPlayerStarted(true);
            setPlayerNeedsUserStart(false);
            return; // stop driving.
          }

          // Gate: only attempt once the details view is actually bound — a title
          // is rendered AND a play candidate exists. The itemDetails chunk binds
          // handlers AFTER data loads, so an early click hits nothing.
          const titleEl = doc.querySelector('.detailPagePrimaryContainer h1, .itemName, h1.parentName, h1');
          const titleText = (titleEl?.textContent ?? '').trim();

          const result = discoverPlayControl(
            doc as unknown as Parameters<typeof discoverPlayControl>[0],
          );

          // Log selector match counts each tick so we can see discovery progress.
          jflog(
            'tick t+' + (Date.now() - startedAt) + 'ms title=' + JSON.stringify(titleText.slice(0, 60)) +
            ' selectorCounts=' + JSON.stringify(result.selectorCounts) +
            ' candidate=' + (result.candidate ? result.candidate.via : 'none'),
          );

          if (!titleText) {
            // Details view not bound yet - wait.
          } else if (result.candidate && !clickedOnce) {
            clickedOnce = clickJellyfinPlayControl('auto');
            if (clickedOnce) {
              setPlayerNeedsUserStart(false);
            }
          } else if (clickedOnce) {
            jflog('waiting for playback after first click');
            if (Date.now() - startedAt > 5_000) {
              setPlayerNeedsUserStart(true);
            }
          } else if (!clickedOnce) {
            // No candidate AND we've never clicked — dump every button/anchor so
            // we can SEE the real play control in the proof console.
            jflog('NO play candidate; enumerating controls:');
            for (const desc of result.enumerated ?? []) {
              jflog('  ctrl ' + desc);
            }
          }
        } catch {
          /* swallow — transient re-render / detached node */
        }
      }

      scheduleTick(clickedOnce ? 500 : 250);
    };

    // Try immediately after React commits the iframe, and again on the iframe's
    // own load event. The short poll is the resilience layer for Jellyfin's SPA
    // work after load (auto-login, data fetch, and handler binding).
    const frame = playerFrameRef.current;
    const handleFrameLoad = () => tick();
    frame?.addEventListener('load', handleFrameLoad);
    const raf = window.requestAnimationFrame(() => tick());

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      window.clearTimeout(userStartTimer);
      frame?.removeEventListener('load', handleFrameLoad);
      for (const timer of pendingTimers) {
        window.clearTimeout(timer);
      }
      pendingTimers.clear();
    };
  }, [playingItem, clickJellyfinPlayControl, installMutedAutoplay]);

  if (loading || !session) {
    return <div className="shell"><div className="panel">Loading Gogglebox…</div></div>;
  }

  if (!session.authenticated) {
    return (
      <div className="shell">
        <div className="panel auth-panel">
          <p className="eyebrow">LAN household portal</p>
          <h1>{session.appName}</h1>
          <p className="lead">Log in to your account, then choose who is watching together.</p>
          <form className="stack" onSubmit={handleLogin}>
            <label>
              <span>Account username</span>
              <input
                value={credentials.username}
                onChange={(event) => setCredentials((current) => ({ ...current, username: event.target.value }))}
              />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={credentials.password}
                onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))}
              />
            </label>
            <button disabled={busy} type="submit">Enter gogglebox</button>
          </form>
          {error ? <p className="error">{error}</p> : null}
        </div>
      </div>
    );
  }

  if (session.activeViewerIds.length === 0) {
    return (
      <div className="shell">
        <div className="panel">
          <div className="row spread">
            <div>
              <p className="eyebrow">Who is watching?</p>
              <h1>Pick the group</h1>
            </div>
            <button className="ghost" onClick={() => void logout()}>Log out</button>
          </div>
          <div className="viewer-grid">
            {session.viewers.map((viewer) => {
              const selected = selectedViewerIds.includes(viewer.id);
              return (
                <button
                  key={viewer.id}
                  className={`viewer-card${selected ? ' selected' : ''}`}
                  onClick={() => toggleViewer(viewer.id)}
                  type="button"
                >
                  <ViewerAvatar viewer={viewer} />
                  <strong>{viewer.name}</strong>
                  {viewer.pinRequired ? <span className="badge">PIN</span> : null}
                </button>
              );
            })}
          </div>
          {savedGroups.length > 0 ? (
            <div className="stack saved-groups">
              <p className="eyebrow">Saved groups</p>
              <div className="viewer-grid">
                {savedGroups.map((group) => {
                  const selected =
                    group.memberIds.length === selectedViewerIds.length &&
                    group.memberIds.every((id) => selectedViewerIds.includes(id));
                  return (
                    <button
                      key={group.groupKey}
                      className={`viewer-card saved-group-card${selected ? ' selected' : ''}`}
                      onClick={() => selectSavedGroup(group)}
                      type="button"
                    >
                      <strong>{group.alias}</strong>
                      <span className="muted">{group.memberNames.join(', ')}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {pinRequiredSelected.length > 0 ? (
            <div className="stack pin-prompts">
              <p className="muted">These viewers need their PIN to join the group:</p>
              {pinRequiredSelected.map((viewer) => (
                <label key={`pin-${viewer.id}`}>
                  <span>{viewer.name}’s PIN</span>
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    value={pins[viewer.id] ?? ''}
                    onChange={(event) =>
                      setPins((current) => ({ ...current, [viewer.id]: event.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
          ) : null}
          <div className="row spread">
            <button
              disabled={busy || selectedViewerIds.length === 0}
              onClick={() => void saveGroup(selectedViewerIds, pins)}
              type="button"
            >
              Continue
            </button>
          </div>
          {error ? <p className="error">{error}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="hero">
        <span className="brand">{session.appName}</span>
        <div className="hero-actions">
          {session.activeGroupAlias ? (
            <span className="muted group-alias">{session.activeGroupAlias}</span>
          ) : null}
          <button className="ghost compact" onClick={() => setIgnoredOpen(true)} type="button">
            Ignored{ignoredItems.length > 0 ? ` (${ignoredItems.length})` : ''}
          </button>
          <button className="ghost compact" onClick={() => void clearGroup()} type="button">Change viewers</button>
          <button className="ghost compact" onClick={() => void logout()} type="button">Log out</button>
        </div>
      </header>

      <section className="panel section-block">
        <div className="row spread">
          <div>
            <p className="eyebrow">Resume together</p>
            <h2>Continue watching</h2>
          </div>
          <RailPager
            page={continuePager.page}
            pageCount={continuePager.pageCount}
            hasPrev={continuePager.hasPrev}
            hasNext={continuePager.hasNext}
            onPrev={continuePager.prev}
            onNext={continuePager.next}
          />
        </div>
        {!libraryLoading && continueWatching.length === 0 ? (
          <p className="muted">Nothing in progress for this group yet.</p>
        ) : null}
        <div className="media-grid">
          {continuePager.visible.map((item) => (
            <article className="media-card" key={`continue-${item.id}-${item.sourceViewerId}`}>
              <div className="poster" style={item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : undefined}>
                {!item.imageUrl ? <span>No artwork</span> : null}
              </div>
              <div className="media-copy">
                <div className="row spread top-align">
                  <h3>{item.name}</h3>
                  <span className="badge">{Math.round(item.progressPercent * 100)}%</span>
                </div>
                <p className="meta">
                  {item.type === 'show'
                    ? [
                      item.seriesName,
                      item.seasonNumber && item.episodeNumber
                        ? `S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')}`
                        : null,
                    ].filter(Boolean).join(' • ')
                    : [item.year, item.runtimeMinutes ? `${item.runtimeMinutes} min` : null].filter(Boolean).join(' • ')}
                </p>
                <p className="overview">{item.overview || 'No synopsis available.'}</p>
                <div className="progress-track" aria-hidden="true">
                  <span className="progress-fill" style={{ width: `${Math.max(2, Math.round(item.progressPercent * 100))}%` }} />
                </div>
              </div>
              <div className="row spread">
                <div className="play-row">
                  <button onClick={() => void startContinuePlayback(item)} type="button">{item.progressPercent > 0 ? 'Resume' : 'Play'}</button>
                  <div className="viewer-pills">
                    {item.viewerWatched?.map((viewer) => (
                      <button
                        key={viewer.viewerId}
                        type="button"
                        className={`viewer-pill${viewer.watched ? ' watched' : ''}`}
                        onClick={() => void toggleViewerWatched(item, viewer)}
                        aria-pressed={viewer.watched}
                        title={`${viewer.viewerName} — ${viewer.watched ? 'watched' : 'not watched'} (click to toggle)`}
                      >
                        {viewer.avatarUrl ? (
                          <img className="viewer-pill-avatar" src={viewer.avatarUrl} alt={viewer.viewerName} />
                        ) : (
                          <span className="viewer-pill-avatar">{viewer.viewerName.slice(0, 1)}</span>
                        )}
                        {viewer.watched ? <span className="viewer-pill-check" aria-hidden="true">✓</span> : null}
                      </button>
                    ))}
                  </div>
                </div>
                <IgnoreFlyout item={item} onIgnore={(payload) => void submitIgnore(payload)} />
              </div>
            </article>
          ))}
        </div>
      </section>

      <div className="toolbar panel">
        <div className="toggle-row">
          <button className={kind === 'movie' ? 'selected' : ''} onClick={() => setKind('movie')} type="button">Movies</button>
          <button className={kind === 'show' ? 'selected' : ''} onClick={() => setKind('show')} type="button">Shows</button>
        </div>
        <label>
          <span>Genre</span>
          <select value={genre} onChange={(event) => setGenre(event.target.value)}>
            <option value="">All genres</option>
            {availableGenres.map((itemGenre) => (
              <option key={itemGenre} value={itemGenre}>{itemGenre}</option>
            ))}
          </select>
        </label>
        <label className="checkbox-row">
          <input checked={kidsOnly} onChange={(event) => setKidsOnly(event.target.checked)} type="checkbox" />
          <span>Kids only</span>
        </label>
        <label className="search-field">
          <span>Search</span>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={`Search ${kind === 'movie' ? 'movies' : 'shows'}…`}
          />
        </label>
      </div>

      {error ? <div className="panel error">{error}</div> : null}

      {searchQuery.trim() ? null : (
        <section className="panel section-block">
          <div className="row spread">
            <div>
              <p className="eyebrow">Group picks</p>
              <h2>Because none of you have seen this</h2>
            </div>
            <div className="row">
              {libraryLoading ? <span className="muted">Refreshing…</span> : null}
              {noMorePicks ? <span className="muted">No more picks</span> : null}
              <RailPager
                page={recommendationsPager.page}
                pageCount={recommendationsPager.pageCount}
                hasPrev={recommendationsPager.hasPrev}
                hasNext={recommendationsPager.hasNext}
                onPrev={recommendationsPager.prev}
                onNext={recommendationsPager.next}
              />
              <button
                onClick={() => void showOtherPicks()}
                type="button"
                disabled={
                  libraryLoading ||
                  picksLoading ||
                  noMorePicks ||
                  !session ||
                  session.activeViewerIds.length === 0
                }
              >
                {picksLoading ? 'Finding…' : 'Show me other picks'}
              </button>
            </div>
          </div>
          {libraryLoading ? <p className="muted">Loading recommendations…</p> : null}
          {!libraryLoading && recommendations.length === 0 ? (
            <p className="muted">No fresh recommendations match this filter yet. Try another genre or turn off kids-only.</p>
          ) : null}
          <div className="media-grid">
            {recommendationsPager.visible.map((item) => (
              <MediaCard
                key={`rec-${item.id}`}
                item={item}
                onMarkWatched={markWatched}
                onPlay={openPlayback}
                onOpenEpisodes={openEpisodes}
                onIgnore={ignore}
              />
            ))}
          </div>
        </section>
      )}

      {searchQuery.trim() ? (
        <section className="panel section-block">
          <div className="row spread">
            <div>
              <p className="eyebrow">Library</p>
              <h2>Search results</h2>
            </div>
            {searchLoading ? <span className="muted">Searching…</span> : null}
          </div>
          <div className="media-grid">
            {searchResults.map((item) => (
              <MediaCard
                key={item.id}
                item={item}
                onMarkWatched={markWatched}
                onPlay={openPlayback}
                onOpenEpisodes={openEpisodes}
                onIgnore={ignore}
              />
            ))}
          </div>
          {!searchLoading && searchResults.length === 0 ? (
            <p className="muted">No titles match “{searchQuery.trim()}”.</p>
          ) : null}
        </section>
      ) : null}

      {selectedSeries ? (
        <div className="modal-backdrop" onClick={() => setSelectedSeries(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="row spread">
              <div>
                <p className="eyebrow">Episodes</p>
                <h2>{selectedSeries.name}</h2>
              </div>
              <button className="ghost" onClick={() => setSelectedSeries(null)} type="button">Close</button>
            </div>
            {episodesLoading ? <p className="muted">Loading episodes…</p> : null}
            {!episodesLoading && episodes.length === 0 ? <p className="muted">No episodes were found for this series.</p> : null}
            <div className="episode-list">
              {episodes.map((episode) => {
                const label = [
                  episode.seasonNumber ? `S${String(episode.seasonNumber).padStart(2, '0')}` : null,
                  episode.episodeNumber ? `E${String(episode.episodeNumber).padStart(2, '0')}` : null,
                ].filter(Boolean).join(' ');

                return (
                  <article className="episode-card" key={episode.id}>
                    <div>
                      <p className="eyebrow">{label || 'Episode'}</p>
                      <h3>{episode.name}</h3>
                      <p className="meta">{episode.runtimeMinutes ? `${episode.runtimeMinutes} min` : 'Runtime unavailable'}</p>
                      <p className="overview">{episode.overview || 'No synopsis available.'}</p>
                    </div>
                    <div className="row">
                      <button
                        onClick={() => {
                          void openPlayback({
                            id: episode.id,
                            title: episode.name,
                            subtitle: `${selectedSeries.name}${label ? ` • ${label}` : ''}`,
                          });
                          setSelectedSeries(null);
                        }}
                        type="button"
                      >
                        Play episode
                      </button>
                      <button className="ghost" onClick={() => void markWatched(episode.id)} type="button">Mark watched</button>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {ignoredOpen ? (
        <div className="modal-backdrop" onClick={() => setIgnoredOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="row spread">
              <div>
                <p className="eyebrow">This group</p>
                <h2>Ignored</h2>
              </div>
              <button className="ghost" onClick={() => setIgnoredOpen(false)} type="button">Close</button>
            </div>
            {ignoredItems.length === 0 ? (
              <p className="muted">Nothing is ignored for this group. Use “Ignore” on a card to hide it everywhere.</p>
            ) : (
              <div className="episode-list">
                {ignoredItems.map((item) => (
                  <article className="episode-card" key={`ignored-${item.key}`}>
                    <div>
                      <h3>{item.label || item.key}</h3>
                      <p className="meta">Hidden from continue-watching, recommendations and search.</p>
                    </div>
                    <div className="row">
                      <button onClick={() => void unignore(item.key)} type="button">Unignore</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {playingItem ? (
        <div className="modal-backdrop" onClick={() => setPlayingItem(null)}>
          <div
            ref={playerModalRef}
            className="modal player-modal"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="row spread">
              <div>
                <p className="eyebrow">Now playing</p>
                <h2>{playingItem.title}</h2>
                {playingItem.subtitle ? <p className="meta">{playingItem.subtitle}</p> : null}
              </div>
              <button className="ghost" onClick={() => setPlayingItem(null)} type="button">Close</button>
            </div>
            {/* Same-origin Jellyfin-web iframe. The seeded localStorage logs it
                in automatically; the autoplay-driving effect dispatches a click
                on the details Play button to START playback in-frame. */}
            <div className="player-stage">
              <iframe
                ref={playerFrameRef}
                className="player-frame"
                src={playingItem.url}
                title={`Jellyfin player - ${playingItem.title}`}
                allow="autoplay; fullscreen; picture-in-picture"
              />
              {!playerStarted && !playerHideStartingOverlay ? (
                <div className="player-starting" aria-live="polite">
                  <p className="eyebrow">Starting player</p>
                  <p>{playingItem.title}</p>
                  {playerNeedsUserStart ? (
                    <button
                      type="button"
                      onClick={() => {
                        setPlayerNeedsUserStart(false);
                        if (!clickJellyfinPlayControl('user')) {
                          setPlayerNeedsUserStart(true);
                        }
                      }}
                    >
                      Start playback
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <p className="muted">
              Auto-mark watched at {Math.round(session.watchedThreshold * 100)}%
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MediaCard({
  item,
  onMarkWatched,
  onPlay,
  onOpenEpisodes,
  onIgnore,
}: {
  item: LibraryItem;
  onMarkWatched: (itemId: string) => Promise<void>;
  onPlay: (item: { id: string; title: string }) => Promise<void>;
  onOpenEpisodes: (series: LibraryItem) => Promise<void>;
  onIgnore: (item: LibraryItem) => Promise<void>;
}) {
  return (
    <article className="media-card">
      <div className="poster" style={item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : undefined}>
        {!item.imageUrl ? <span>No artwork</span> : null}
      </div>
      <div className="media-copy">
        <div className="row spread top-align">
          <h3>{item.name}</h3>
          {item.rating ? <span className="badge">{item.rating.toFixed(1)}</span> : null}
        </div>
        <p className="meta">{[item.year, item.runtimeMinutes ? `${item.runtimeMinutes} min` : null, item.officialRating].filter(Boolean).join(' • ') || 'No metadata yet'}</p>
        <p className="overview">{item.overview || 'No synopsis available.'}</p>
        <div className="tag-row">
          {item.genres.slice(0, 3).map((genre) => (
            <span key={genre} className="tag">{genre}</span>
          ))}
        </div>
      </div>
      <div className="row spread">
        {item.playable ? (
          <button onClick={() => void onPlay({ id: item.id, title: item.name })} type="button">Play</button>
        ) : (
          <button onClick={() => void onOpenEpisodes(item)} type="button">Episodes</button>
        )}
        <button className="ghost" onClick={() => void onMarkWatched(item.id)} type="button">Mark watched</button>
        <button className="ghost" onClick={() => void onIgnore(item)} type="button">Ignore</button>
      </div>
    </article>
  );
}
