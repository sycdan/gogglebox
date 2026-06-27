import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';

type LibraryKind = 'movie' | 'show';

interface Viewer {
  id: string;
  jellyfinUserId: string;
  name: string;
  avatarUrl?: string | null;
}

interface GroupPreset {
  id: string;
  name: string;
  memberIds: string[];
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

interface PlaybackItem {
  id: string;
  title: string;
  subtitle?: string;
  startPositionSeconds?: number;
  seriesId?: string | null;
  seriesName?: string | null;
}

interface IgnoredItem {
  id: string;
  title: string;
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

interface SessionResponse {
  authenticated: boolean;
  portalAutoLoginEnabled: boolean;
  appName: string;
  watchedThreshold: number;
  viewers: Viewer[];
  groups: GroupPreset[];
  activeViewerIds: string[];
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

export function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [selectedViewerIds, setSelectedViewerIds] = useState<string[]>([]);
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
  const [playingItem, setPlayingItem] = useState<PlaybackItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [autoMarked, setAutoMarked] = useState(false);
  const [credentials, setCredentials] = useState({ username: '', password: '' });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerModalRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // Cache of episode lists keyed by seriesId so repeated S-skips within the same
  // series don't refetch the ordered episode list each time.
  const seriesEpisodesCacheRef = useRef<Map<string, EpisodeItem[]>>(new Map());
  // Guards against double-trigger / races while a skip is resolving in flight.
  const skipInFlightRef = useRef(false);
  // Latest playingItem, readable from the document-level keydown handler without
  // re-binding the listener on every change.
  const playingItemRef = useRef<PlaybackItem | null>(null);
  playingItemRef.current = playingItem;

  // Per-rail pagination (3 tiles per page) so rails stay roomy, not cramped.
  const continuePager = usePager(continueWatching);
  const recommendationsPager = usePager(recommendations);

  async function loadSession() {
    const nextSession = await apiRequest<SessionResponse>('/api/session');
    setSession(nextSession);
    setSelectedViewerIds(nextSession.activeViewerIds);
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

  // The id used to ignore an item: a show's series id, otherwise the item id.
  function ignorableId(item: { type: LibraryKind; id: string; seriesId?: string | null }): string {
    return item.type === 'show' && item.seriesId ? item.seriesId : item.id;
  }

  async function ignore(item: LibraryItem | ContinueWatchingItem) {
    const itemId = ignorableId(item);
    try {
      await apiRequest<{ itemIds: string[] }>('/api/ignored', {
        method: 'POST',
        body: JSON.stringify({ itemId }),
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

  async function unignore(itemId: string) {
    try {
      await apiRequest<{ itemIds: string[] }>(`/api/ignored/${itemId}`, {
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

  async function saveGroup(memberIds: string[]) {
    try {
      setBusy(true);
      setError(null);
      await apiRequest('/api/group', {
        method: 'POST',
        body: JSON.stringify({ memberIds }),
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
      // The server re-runs resolveWatchedCards on /api/continue-watching, so a
      // refetch is what makes the card advance (show -> next episode) or drop
      // (movie / last episode) live, without a reload. The optimistic flip above
      // keeps the pill snappy; this refetch is the source of truth. loadContinueWatching
      // sequences requests so rapid toggles resolve to the latest result.
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

  function startPlayback(item: PlaybackItem) {
    setAutoMarked(false);
    setPlayingItem(item);
  }

  async function startContinuePlayback(item: ContinueWatchingItem) {
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

    const isShow = item.type === 'show';
    startPlayback({
      id: item.id,
      title: item.name,
      subtitle: isShow
        ? `${item.seriesName ?? item.name}${item.seasonNumber && item.episodeNumber
          ? ` • S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')}`
          : ''}`
        : undefined,
      startPositionSeconds: item.playbackPositionTicks / 10_000_000,
      seriesId: isShow ? item.seriesId : undefined,
      seriesName: isShow ? item.seriesName : undefined,
    });
  }

  async function resolveSeriesEpisodes(seriesId: string): Promise<EpisodeItem[]> {
    const cached = seriesEpisodesCacheRef.current.get(seriesId);
    if (cached) {
      return cached;
    }
    const response = await apiRequest<{ items: EpisodeItem[] }>(`/api/shows/${seriesId}/episodes`);
    seriesEpisodesCacheRef.current.set(seriesId, response.items);
    return response.items;
  }

  // Skip to the next episode of the current show (S hotkey). Marks the current
  // episode watched in every case; swaps to the next episode when one exists,
  // otherwise stays put on the last episode. No-op for movies (no seriesId).
  async function skipToNextEpisode() {
    const current = playingItemRef.current;
    if (!current || !current.seriesId || skipInFlightRef.current) {
      return;
    }
    skipInFlightRef.current = true;
    try {
      const list = await resolveSeriesEpisodes(current.seriesId);
      const index = list.findIndex((episode) => episode.id === current.id);
      const next = index >= 0 ? list[index + 1] : undefined;

      if (next) {
        const label = [
          next.seasonNumber ? `S${String(next.seasonNumber).padStart(2, '0')}` : null,
          next.episodeNumber ? `E${String(next.episodeNumber).padStart(2, '0')}` : null,
        ].filter(Boolean).join(' ');
        const seriesName = next.seriesName ?? current.seriesName ?? next.name;
        // Swap first so the player lands on the new episode before the heavy
        // mark-watched refresh runs; the refresh leaves playingItem untouched.
        startPlayback({
          id: next.id,
          title: next.name,
          subtitle: `${seriesName}${label ? ` • ${label}` : ''}`,
          seriesId: next.seriesId,
          seriesName: next.seriesName,
          startPositionSeconds: 0,
        });
      }

      // Always mark the current episode watched (both has-next and last cases).
      await markWatched(current.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not skip to the next episode');
    } finally {
      skipInFlightRef.current = false;
    }
  }

  async function handleAutoTrack() {
    if (!playingItem || autoMarked) {
      return;
    }

    setAutoMarked(true);
    try {
      await markWatched(playingItem.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not mark item watched');
    }
  }

  useEffect(() => {
    if (!playingItem) {
      return;
    }

    // Remember what had focus so we can restore it when the modal closes.
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Move focus onto the modal container so the close button / Esc are
    // reachable. Hotkeys no longer depend on this focus — they're handled by a
    // document-level listener below — but we still focus so keyboard users land
    // inside the dialog rather than on the Play button that opened it.
    const frame = requestAnimationFrame(() => {
      playerModalRef.current?.focus();
    });

    // Lock background scroll while the modal is open. This kills the page
    // scroll that the very first Space press would otherwise cause (before
    // focus settles), independent of keydown timing.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Document-level keydown handler: active only while the modal is open.
    // Living on `document` (not the dialog container) means hotkeys fire no
    // matter what is focused and no matter which element is fullscreened —
    // including when the <video> itself is fullscreened. We call
    // preventDefault() on every key we handle so the native <video> control
    // (which also reacts to Space/arrows when focused) doesn't double-fire.
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const video = videoRef.current;

      if (event.key === 'Escape') {
        // When the video is fullscreen the browser eats the first Esc to exit
        // fullscreen; a second Esc reaches here and closes the modal.
        if (document.fullscreenElement) {
          return;
        }
        event.preventDefault();
        setPlayingItem(null);
        return;
      }

      if (!video) {
        return;
      }

      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault();
          if (video.paused) {
            void video.play();
          } else {
            video.pause();
          }
          break;
        case 'ArrowLeft':
          event.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 5);
          break;
        case 'ArrowRight':
          event.preventDefault();
          video.currentTime = Math.min(video.duration || video.currentTime + 5, video.currentTime + 5);
          break;
        case 'ArrowUp':
          event.preventDefault();
          video.volume = Math.min(1, video.volume + 0.1);
          break;
        case 'ArrowDown':
          event.preventDefault();
          video.volume = Math.max(0, video.volume - 0.1);
          break;
        case 'm':
        case 'M':
          event.preventDefault();
          video.muted = !video.muted;
          break;
        case 's':
        case 'S':
          event.preventDefault();
          void skipToNextEpisode();
          break;
        case 'f':
        case 'F':
          event.preventDefault();
          if (document.fullscreenElement) {
            void document.exitFullscreen();
          } else {
            // Fullscreen the <video> itself so the user sees only the native
            // player chrome — no modal header/footer/border.
            void video.requestFullscreen?.();
          }
          break;
        default:
          break;
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocusedRef.current?.focus();
    };
  }, [playingItem]);

  // Trap focus within the modal: cycle Tab between the focusable elements.
  // This stays on the container (not document) because it operates on the
  // dialog's focusable set; the playback hotkeys are handled document-level.
  function handlePlayerTabTrap(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = playerModalRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], video, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) {
      event.preventDefault();
      playerModalRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === playerModalRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (loading || !session) {
    return <div className="shell"><div className="panel">Loading Gogglebox…</div></div>;
  }

  if (!session.authenticated) {
    return (
      <div className="shell">
        <div className="panel auth-panel">
          <p className="eyebrow">LAN household portal</p>
          <h1>{session.appName}</h1>
          <p className="lead">One login for the house, then choose who is watching together.</p>
          <form className="stack" onSubmit={handleLogin}>
            <label>
              <span>Household username</span>
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
                </button>
              );
            })}
          </div>
          {session.groups.length > 0 ? (
            <div className="preset-row">
              {session.groups.map((preset) => (
                <button key={preset.id} className="chip" onClick={() => setSelectedViewerIds(preset.memberIds)} type="button">
                  {preset.name}
                </button>
              ))}
            </div>
          ) : null}
          <div className="row spread">
            <p className="muted">Multi-select is stored for this session only.</p>
            <button disabled={busy || selectedViewerIds.length === 0} onClick={() => void saveGroup(selectedViewerIds)} type="button">
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
                <button className="ghost" onClick={() => void ignore(item)} type="button">Ignore</button>
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
              onPlay={startPlayback}
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
                onPlay={startPlayback}
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
                          startPlayback({
                            id: episode.id,
                            title: episode.name,
                            subtitle: `${selectedSeries.name}${label ? ` • ${label}` : ''}`,
                            seriesId: episode.seriesId,
                            seriesName: episode.seriesName,
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
                  <article className="episode-card" key={`ignored-${item.id}`}>
                    <div>
                      <h3>{item.title || item.id}</h3>
                      <p className="meta">Hidden from continue-watching, recommendations and search.</p>
                    </div>
                    <div className="row">
                      <button onClick={() => void unignore(item.id)} type="button">Unignore</button>
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
            className="modal"
            ref={playerModalRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={`Now playing ${playingItem.title}`}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handlePlayerTabTrap}
          >
            <div className="row spread">
              <div>
                <p className="eyebrow">Now playing</p>
                <h2>{playingItem.title}</h2>
                {playingItem.subtitle ? <p className="meta">{playingItem.subtitle}</p> : null}
              </div>
              <button className="ghost" onClick={() => setPlayingItem(null)} type="button">Close</button>
            </div>
            <video
              ref={videoRef}
              controls
              autoPlay
              onLoadedMetadata={() => {
                const video = videoRef.current;
                if (video && playingItem.startPositionSeconds && playingItem.startPositionSeconds > 0) {
                  video.currentTime = Math.min(playingItem.startPositionSeconds, Math.max(0, video.duration - 1));
                }
                setAutoMarked(false);
              }}
              onTimeUpdate={() => {
                const video = videoRef.current;
                if (!video || !video.duration || autoMarked) {
                  return;
                }

                if (video.currentTime / video.duration >= session.watchedThreshold) {
                  void handleAutoTrack();
                }
              }}
              src={`/api/items/${playingItem.id}/stream`}
            />
            <p className="muted">Playback auto-marks watched at {Math.round(session.watchedThreshold * 100)}%. Press <i>f</i> to toggle fullscreen.</p>
            {playingItem.seriesId ? <p className="muted">Press <i>S</i> for next episode.</p> : null}
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
  onPlay: (item: PlaybackItem) => void;
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
          <button onClick={() => onPlay({ id: item.id, title: item.name })} type="button">Play</button>
        ) : (
          <button onClick={() => void onOpenEpisodes(item)} type="button">Episodes</button>
        )}
        <button className="ghost" onClick={() => void onMarkWatched(item.id)} type="button">Mark watched</button>
        <button className="ghost" onClick={() => void onIgnore(item)} type="button">Ignore</button>
      </div>
    </article>
  );
}
