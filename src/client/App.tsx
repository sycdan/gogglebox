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
  const [recommendations, setRecommendations] = useState<LibraryItem[]>([]);
  const [noMorePicks, setNoMorePicks] = useState(false);
  const [picksLoading, setPicksLoading] = useState(false);
  const shownRecommendationIdsRef = useRef<Set<string>>(new Set());
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
    if (activeSession.activeViewerIds.length > 0) {
      const continueResponse = await apiRequest<{ items: ContinueWatchingItem[] }>('/api/continue-watching');
      setContinueWatching(continueResponse.items);
    } else {
      setContinueWatching([]);
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
        await loadContinueWatching(session);
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

    startPlayback({
      id: item.id,
      title: item.name,
      subtitle:
        item.type === 'show'
          ? `${item.seriesName ?? item.name}${item.seasonNumber && item.episodeNumber
            ? ` • S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')}`
            : ''}`
          : undefined,
      startPositionSeconds: item.playbackPositionTicks / 10_000_000,
    });
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
      <div className="hero">
        <div>
          <p className="eyebrow">Now watching</p>
          <h1>{session.activeViewerIds.map((viewerId) => session.viewers.find((viewer) => viewer.id === viewerId)?.name).filter(Boolean).join(' + ')}</h1>
          <p className="lead">Recommendations exclude anything already seen by anyone in this group.</p>
        </div>
        <div className="hero-actions">
          <button className="ghost" onClick={() => void clearGroup()} type="button">Change viewers</button>
          <button className="ghost" onClick={() => void logout()} type="button">Log out</button>
        </div>
      </div>

      <section className="panel section-block">
        <div className="row spread">
          <div>
            <p className="eyebrow">Resume together</p>
            <h2>Continue watching</h2>
          </div>
        </div>
        {!libraryLoading && continueWatching.length === 0 ? (
          <p className="muted">Nothing in progress for this group yet.</p>
        ) : null}
        <div className="media-grid compact">
          {continueWatching.map((item) => (
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
                <p className="muted">Resume from {item.sourceViewerName}'s progress.</p>
                <div className="progress-track" aria-hidden="true">
                  <span className="progress-fill" style={{ width: `${Math.max(2, Math.round(item.progressPercent * 100))}%` }} />
                </div>
              </div>
              <div className="row spread">
                <button onClick={() => void startContinuePlayback(item)} type="button">Continue</button>
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
        <div className="media-grid compact">
          {recommendations.map((item) => (
            <MediaCard
              key={`rec-${item.id}`}
              item={item}
              onMarkWatched={markWatched}
              onPlay={startPlayback}
              onOpenEpisodes={openEpisodes}
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
}: {
  item: LibraryItem;
  onMarkWatched: (itemId: string) => Promise<void>;
  onPlay: (item: PlaybackItem) => void;
  onOpenEpisodes: (series: LibraryItem) => Promise<void>;
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
      </div>
    </article>
  );
}
