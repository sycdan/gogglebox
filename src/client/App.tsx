import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildContinueGuestSubmission,
  guestIdsForPinRetry,
  isGuestConfirmDisabled,
} from './guestSelection';
import { PlayerSessionPayload, seedJellyfinWebSession } from './jellyfinSession';
import { clickEl, discoverPlayControl, isPlaybackStarted } from './playerLaunch';
import {
  addTonightSentiment,
  createTonightNineState,
  currentTonightLeader,
  dismissFocusedTonightCard,
  isTonightExhausted,
  moveTonightFocus,
  TonightNineState,
  TonightSlot,
} from './tonightsNine';

const playerStartMuted =
  import.meta.env.VITE_PLAYER_START_MUTED === '1' ||
  import.meta.env.VITE_PLAYER_START_MUTED === 'true';
const playerHideStartingOverlay =
  import.meta.env.VITE_PLAYER_HIDE_STARTING_OVERLAY === '1' ||
  import.meta.env.VITE_PLAYER_HIDE_STARTING_OVERLAY === 'true';

type LibraryKind = 'movie' | 'show';

// Config v2 account tiers: primaries are preselected on the picker, secondaries
// listed after them, tertiaries are pin-gated guests (only addable via the
// "add guest" modal).
type ViewerTier = 'primary' | 'secondary' | 'tertiary';

interface Viewer {
  id: string;
  jellyfinUserId: string;
  name: string;
  avatarUrl?: string | null;
  // This account's tier for the viewer (see ViewerTier).
  tier: ViewerTier;
  // Convenience flag from the server: true iff tier === 'tertiary' (guests are
  // the only pin-gated tier).
  pinRequired?: boolean;
}

// localStorage key remembering the access token until Log out is clicked, so a
// returning visitor skips the portal login.
const ACCESS_TOKEN_STORAGE_KEY = 'gogglebox.accessToken';

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
  recommendationReasons?: string[];
}

interface CountdownTarget {
  itemId: string;
  seconds: number;
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
  // Every active viewer's watched state for this exact episode (display-only —
  // the show detail modal never edits watched state from here).
  viewerWatched?: ViewerWatchedState[];
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
  // The logged-in account's key, or null when not authenticated.
  account: string | null;
  viewers: Viewer[];
  activeViewerIds: string[];
  // The active party's human-readable alias (never gbx-grp-<hash>), or null.
  activePartyAlias: string | null;
}

interface AppFlags {
  tonightsNine: boolean;
}

const DEFAULT_APP_FLAGS: AppFlags = {
  tonightsNine: false,
};

// A managed party visible to the logged-in account, surfaced as a selectable
// "Saved party" on the picker. Identified by partyKey; shown by alias. Parties
// were formerly called "groups" — see /api/parties (and its /api/groups
// compatibility alias) in src/server/server.ts.
interface SavedParty {
  partyKey: string;
  alias: string;
  memberIds: string[];
  memberNames: string[];
}

// An API failure carrying its HTTP status so callers can branch on specific
// verdicts (e.g. the 403 pin rejection from POST /api/party).
class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
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
    throw new ApiError(body.error ?? 'Request failed', response.status);
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

function formatViewerNames(viewers: Viewer[]): string {
  const names = viewers.map((viewer) => viewer.name).filter(Boolean);
  if (names.length === 0) {
    return 'the selected viewers';
  }
  if (names.length === 1) {
    return names[0];
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
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

function formatMediaMeta(item: LibraryItem): string {
  return [item.year, item.runtimeMinutes ? `${item.runtimeMinutes} min` : null, item.officialRating]
    .filter(Boolean)
    .join(' • ') || 'No metadata yet';
}

function recommendationReasonsFor(item: LibraryItem): string[] {
  const reasons = item.recommendationReasons?.filter(Boolean) ?? [];
  if (reasons.length > 0) {
    return reasons.slice(0, 2);
  }
  if (item.rating) {
    return [`Rated ${item.rating.toFixed(1)} in your library`];
  }
  return ['Recommended from your library'];
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
  // Managed parties visible to this account, shown as "Saved parties" on the picker.
  const [savedParties, setSavedParties] = useState<SavedParty[]>([]);
  // Pins collected for selected guests via the continue-time pin modal, keyed
  // by jellyfinUserId — the same wire contract POST /api/party expects.
  const [pins, setPins] = useState<Record<string, string>>({});
  // Guest modal state: open flag, the draft guest selection and per-guest draft
  // pins (keyed by viewer id; continue flow only — the plain "add guest" flow
  // is selection-only), whether the modal was opened mid-Continue (the single
  // place pins are typed), and the server's pin-rejection message shown at the
  // modal so a wrong pin can be retyped in place.
  const [guestModalOpen, setGuestModalOpen] = useState(false);
  const [guestDraftIds, setGuestDraftIds] = useState<string[]>([]);
  const [guestDraftPins, setGuestDraftPins] = useState<Record<string, string>>({});
  const [guestModalForContinue, setGuestModalForContinue] = useState(false);
  const [guestModalError, setGuestModalError] = useState<string | null>(null);
  // Confirmation modal warning that a party with any non-primary member affects
  // watch progress for ALL its users.
  const [confirmMixedOpen, setConfirmMixedOpen] = useState(false);
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
  const [tonightState, setTonightState] = useState<TonightNineState>(() => createTonightNineState([]));
  const [appFlags, setAppFlags] = useState<AppFlags>(DEFAULT_APP_FLAGS);
  const [pendingDismissal, setPendingDismissal] = useState<{ itemId: string; kind: 'not-now' | 'not-for-us' } | null>(null);
  const [countdown, setCountdown] = useState<CountdownTarget | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdActionRef = useRef<'enter' | 'down' | null>(null);
  const [ignoredItems, setIgnoredItems] = useState<IgnoredItem[]>([]);
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  // The show detail modal's target series — just enough to load + label its
  // episodes. Deliberately NOT the full LibraryItem: continue-watching cards
  // (which only carry seriesId/seriesName) open the same modal, so the shape
  // has to cover both a library card (id/name) and a continue-watching card
  // (seriesId/seriesName).
  const [selectedSeries, setSelectedSeries] = useState<{ id: string; name: string } | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeItem[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  // Season filter for the open show modal: null shows every season. Reset
  // whenever a different show opens (see openShowDetail).
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  // Keyword search scoped to the currently-open show's episodes only (AC4) —
  // separate state from the top-level library search so it never becomes a
  // global/discovery-rail search.
  const [episodeSearchQuery, setEpisodeSearchQuery] = useState('');
  const episodeSearchRequestIdRef = useRef(0);
  const showModalRef = useRef<HTMLDivElement | null>(null);
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
  const [tokenInput, setTokenInput] = useState('');
  // One boot auto-login attempt per page load (stored token, then env token) —
  // never a retry loop, and never re-login right after Log out.
  const autoLoginAttemptedRef = useRef(false);

  // Per-rail pagination (3 tiles per page) so rails stay roomy, not cramped.
  const continuePager = usePager(continueWatching);

  async function loadSession() {
    const nextSession = await apiRequest<SessionResponse>('/api/session');
    setSession(nextSession);
    // Arriving at the picker (no active party): preselect this account's
    // PRIMARY viewers (still deselectable). An active party keeps its own ids.
    setSelectedViewerIds(
      nextSession.activeViewerIds.length > 0
        ? nextSession.activeViewerIds
        : nextSession.viewers.filter((viewer) => viewer.tier === 'primary').map((viewer) => viewer.id),
    );
  }

  async function loadSavedParties() {
    try {
      const response = await apiRequest<{ parties: SavedParty[] }>('/api/parties');
      setSavedParties(response.parties);
    } catch {
      // A failed parties load shouldn't block the picker — just show none.
      setSavedParties([]);
    }
  }

  async function loadFlags() {
    const nextFlags = await apiRequest<AppFlags>('/api/flags');
    setAppFlags({ tonightsNine: Boolean(nextFlags.tonightsNine) });
  }

  // Log in with an access token and remember it (until Log out) so the next
  // visit skips the portal login.
  async function loginWithToken(token: string) {
    await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
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

    setPendingDismissal(null);
    setCountdown(null);
    if (activeSession.activeViewerIds.length > 0 && appFlags.tonightsNine) {
      const recommendationsResponse = await apiRequest<{ items: LibraryItem[] }>(`/api/recommendations?${params.toString()}`);
      setRecommendations(recommendationsResponse.items);
      setTonightState(createTonightNineState(recommendationsResponse.items.slice(0, 9)));
    } else {
      setRecommendations([]);
      setTonightState(createTonightNineState([]));
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
    setPendingDismissal(null);
    setCountdown(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.activeViewerIds.join(',')]);

  useEffect(() => {
    if (!session?.authenticated) {
      setAppFlags(DEFAULT_APP_FLAGS);
      return;
    }

    void (async () => {
      try {
        await loadFlags();
      } catch {
        setAppFlags(DEFAULT_APP_FLAGS);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated, session?.account, session?.activeViewerIds.join(',')]);

  useEffect(() => {
    if (appFlags.tonightsNine) {
      return;
    }

    setPendingDismissal(null);
    setCountdown(null);
    setTonightState(createTonightNineState([]));
  }, [appFlags.tonightsNine]);

  // Refresh the picker's "Saved parties" whenever we land on the picker (logged
  // in, no active party). Re-runs after activating/clearing a party so a newly
  // created party shows up on the next visit.
  useEffect(() => {
    if (session?.authenticated && session.activeViewerIds.length === 0) {
      void loadSavedParties();
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
  }, [session, kind, genre, kidsOnly, appFlags.tonightsNine]);

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

  // Debounced keyword search scoped to the OPEN show's episodes only (AC4) —
  // a separate effect/state from the top-level library search above, so this
  // can never widen into a global/cross-show search. Re-fetches the full
  // (unfiltered) episode list when the query is cleared.
  useEffect(() => {
    if (!selectedSeries) {
      return;
    }

    const seriesId = selectedSeries.id;
    const trimmedQuery = episodeSearchQuery.trim();
    const timer = window.setTimeout(() => {
      void loadEpisodesFor(seriesId, trimmedQuery);
    }, 500);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSeries?.id, episodeSearchQuery]);

  // Boot auto-login, tried once per page load when the session says not
  // authenticated: (1) a stored localStorage token (removed if it fails), then
  // (2) an empty-body login when the server has an ACCESS_TOKEN env var
  // (portalAutoLoginEnabled), else (3) fall through to the login form.
  useEffect(() => {
    if (!session || session.authenticated || busy || autoLoginAttemptedRef.current) {
      return;
    }

    const storedToken = window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
    if (!storedToken && !session.portalAutoLoginEnabled) {
      return;
    }
    autoLoginAttemptedRef.current = true;

    void (async () => {
      try {
        setBusy(true);
        setError(null);
        if (storedToken) {
          try {
            await loginWithToken(storedToken);
            return;
          } catch {
            // A stale/revoked stored token must not wedge login — drop it and
            // fall through to env auto-login (or the form).
            window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
          }
        }
        if (session.portalAutoLoginEnabled) {
          await apiRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({}) });
          await loadSession();
        }
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Auto login failed');
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, busy]);

  // The picker's tiered viewer lists. Primaries + secondaries render as cards;
  // tertiaries (guests) only render once ADDED via the guest modal.
  const primaryViewers = useMemo(
    () => (session?.viewers ?? []).filter((viewer) => viewer.tier === 'primary'),
    [session?.viewers],
  );
  const secondaryViewers = useMemo(
    () => (session?.viewers ?? []).filter((viewer) => viewer.tier === 'secondary'),
    [session?.viewers],
  );
  const tertiaryViewers = useMemo(
    () => (session?.viewers ?? []).filter((viewer) => viewer.tier === 'tertiary'),
    [session?.viewers],
  );
  const addedGuests = useMemo(
    () => tertiaryViewers.filter((viewer) => selectedViewerIds.includes(viewer.id)),
    [tertiaryViewers, selectedViewerIds],
  );
  const selectedViewers = useMemo(
    () => (session?.viewers ?? []).filter((viewer) => selectedViewerIds.includes(viewer.id)),
    [session?.viewers, selectedViewerIds],
  );
  const selectedViewerNames = formatViewerNames(selectedViewers);

  // Guests offered by the modal: mid-Continue it collects pins for EXACTLY the
  // already-selected guests that still lack one (plain-add and saved-party
  // paths alike); otherwise it offers the not-yet-added guest candidates.
  const guestCandidates = useMemo(() => {
    if (guestModalForContinue) {
      return tertiaryViewers.filter(
        (viewer) => selectedViewerIds.includes(viewer.id) && !pins[viewer.jellyfinUserId]?.trim(),
      );
    }
    return tertiaryViewers.filter((viewer) => !selectedViewerIds.includes(viewer.id));
  }, [guestModalForContinue, tertiaryViewers, selectedViewerIds, pins]);

  // Plain add flow: at least one drafted guest (selection-only — pins come at
  // Continue time). Continue flow: a typed PIN per drafted guest, and the draft
  // may only be emptied when other members remain in the submitted party.
  const guestConfirmDisabled = isGuestConfirmDisabled({
    forContinue: guestModalForContinue,
    selectedViewerIds,
    candidateIds: guestCandidates.map((viewer) => viewer.id),
    draftIds: guestDraftIds,
    draftPins: guestDraftPins,
  });

  const availableGenres = useMemo(() => {
    const uniqueGenres = new Set<string>();
    [...recommendations, ...searchResults].forEach((item) =>
      item.genres.forEach((itemGenre) => uniqueGenres.add(itemGenre)),
    );
    return [...uniqueGenres].sort((left, right) => left.localeCompare(right));
  }, [recommendations, searchResults]);
  const recommendationsById = useMemo(
    () => new Map(recommendations.map((item) => [item.id, item])),
    [recommendations],
  );
  const tonightSlots = useMemo(
    () => ([
      ['left', tonightState.slots.left],
      ['center', tonightState.slots.center],
      ['right', tonightState.slots.right],
    ] as const)
      .map(([slot, itemId]) => ({
        slot,
        item: itemId ? recommendationsById.get(itemId) ?? null : null,
      }))
      .filter((entry): entry is { slot: TonightSlot; item: LibraryItem } => Boolean(entry.item)),
    [tonightState.slots, recommendationsById],
  );
  const focusedTonightItem = tonightState.slots.center
    ? recommendationsById.get(tonightState.slots.center) ?? null
    : null;
  const leaderId = currentTonightLeader(tonightState);
  const leaderItem = leaderId ? recommendationsById.get(leaderId) ?? null : null;
  const exhaustedTonight = recommendations.length > 0 && isTonightExhausted(tonightState);

  function toggleViewer(viewerId: string) {
    const viewer = (session?.viewers ?? []).find((candidate) => candidate.id === viewerId);
    const deselecting = selectedViewerIds.includes(viewerId);
    setSelectedViewerIds((current) =>
      current.includes(viewerId) ? current.filter((id) => id !== viewerId) : [...current, viewerId],
    );
    // Toggling a guest OFF also drops their collected pin — re-adding them must
    // go back through the guest modal.
    if (deselecting && viewer?.tier === 'tertiary') {
      setPins((current) => {
        const next = { ...current };
        delete next[viewer.jellyfinUserId];
        return next;
      });
    }
  }

  // Select exactly a saved party's members. Any guest member's pin is collected
  // at Continue time (the guest modal reopens for exactly those members) before
  // the party POST, reusing the existing managed party (same key).
  function selectSavedParty(party: SavedParty) {
    const visibleIds = new Set((session?.viewers ?? []).map((viewer) => viewer.id));
    setSelectedViewerIds(party.memberIds.filter((id) => visibleIds.has(id)));
    setPins({});
    setError(null);
  }

  // Open the guest modal: `preselectedIds` seeds the draft (the Continue flow
  // preselects the guests whose pins are missing); an empty seed is the plain
  // "add guest" flow.
  function openGuestModal(preselectedIds: string[] = [], forContinue = false) {
    setGuestDraftIds(preselectedIds);
    setGuestDraftPins({});
    setGuestModalForContinue(forContinue);
    setGuestModalError(null);
    setGuestModalOpen(true);
  }

  function cancelGuestModal() {
    // Cancel discards the draft selection and any typed pins.
    setGuestModalOpen(false);
    setGuestDraftIds([]);
    setGuestDraftPins({});
    setGuestModalForContinue(false);
    setGuestModalError(null);
  }

  function toggleGuestDraft(viewerId: string) {
    setGuestDraftIds((current) =>
      current.includes(viewerId) ? current.filter((id) => id !== viewerId) : [...current, viewerId],
    );
    // Deselecting a draft guest drops their typed pin too.
    setGuestDraftPins((current) => {
      if (!(viewerId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[viewerId];
      return next;
    });
  }

  // Confirm the guest modal. The plain add flow is selection-only: drafted
  // guests join the selection with NO server call — pins come at Continue time.
  // The Continue flow reconciles the draft against the submitted selection,
  // then verifies the typed pins with the server AT the confirm click
  // (POST /api/party/verify-pins — a preflight that activates/persists
  // nothing): a wrong pin keeps the modal open with the server's message for a
  // retype here, never two modals later. Only a verified submission closes the
  // modal and proceeds to the mixed-party warning / authoritative party POST.
  async function confirmGuestModal() {
    const drafted = tertiaryViewers.filter((viewer) => guestDraftIds.includes(viewer.id));
    if (!guestModalForContinue) {
      const draftedIds = drafted.map((viewer) => viewer.id);
      setSelectedViewerIds((current) => [
        ...current,
        ...draftedIds.filter((id) => !current.includes(id)),
      ]);
      cancelGuestModal();
      return;
    }

    const { memberIds: nextSelectedViewerIds, pins: nextPins } = buildContinueGuestSubmission({
      selectedViewerIds,
      pins,
      modalGuests: guestCandidates,
      draftedGuests: drafted,
      draftPins: guestDraftPins,
    });

    try {
      setBusy(true);
      setGuestModalError(null);
      await apiRequest('/api/party/verify-pins', {
        method: 'POST',
        body: JSON.stringify({ memberIds: nextSelectedViewerIds, pins: nextPins }),
      });
    } catch (nextError) {
      // The server rejected the submission (403 = pin verdict). Keep the modal
      // open with the draft selection intact; clear the typed pins so the
      // retype starts clean under the server's message.
      setGuestDraftPins({});
      setGuestModalError(
        nextError instanceof Error ? nextError.message : 'Could not verify guest PINs',
      );
      return;
    } finally {
      setBusy(false);
    }

    setSelectedViewerIds(nextSelectedViewerIds);
    setPins(nextPins);
    cancelGuestModal();
    const selected = (session?.viewers ?? []).filter((viewer) => nextSelectedViewerIds.includes(viewer.id));
    if (selected.some((viewer) => viewer.tier !== 'primary')) {
      setConfirmMixedOpen(true);
      return;
    }
    void saveParty(nextSelectedViewerIds, nextPins);
  }

  // Continue from the picker — the single pin gate. Order: (1) collect pins for
  // every selected guest still lacking one this Continue interaction (both the
  // plain-add and saved-party paths — adding a guest never collects a pin),
  // (2) warn when the party contains ANY non-primary member (watch progress is
  // shared), (3) POST the party.
  function handleContinue() {
    const selected = (session?.viewers ?? []).filter((viewer) => selectedViewerIds.includes(viewer.id));
    const missingPinGuests = selected.filter(
      (viewer) => viewer.tier === 'tertiary' && !pins[viewer.jellyfinUserId]?.trim(),
    );
    if (missingPinGuests.length > 0) {
      openGuestModal(missingPinGuests.map((viewer) => viewer.id), true);
      return;
    }
    if (selected.some((viewer) => viewer.tier !== 'primary')) {
      setConfirmMixedOpen(true);
      return;
    }
    void saveParty(selectedViewerIds, pins);
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      setBusy(true);
      setError(null);
      await loginWithToken(tokenInput);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  async function saveParty(memberIds: string[], partyPins: Record<string, string> = {}) {
    try {
      setBusy(true);
      setError(null);
      await apiRequest('/api/party', {
        method: 'POST',
        body: JSON.stringify({ memberIds, pins: partyPins }),
      });
      await loadSession();
    } catch (nextError) {
      // A 403 is the server's pin verdict (verifyPartyPins): nothing was
      // activated or persisted. Drop the collected pins and route back to the
      // continue-time pin modal with the server's message so the user can
      // retype and resubmit — never a dead banner.
      if (nextError instanceof ApiError && nextError.status === 403) {
        const retryGuestIds = guestIdsForPinRetry(memberIds, session?.viewers ?? []);
        if (retryGuestIds.length > 0) {
          setPins({});
          openGuestModal(retryGuestIds, true);
          setGuestModalError(nextError.message);
          return;
        }
      }
      setError(nextError instanceof Error ? nextError.message : 'Could not save viewer party');
    } finally {
      setBusy(false);
    }
  }

  async function clearParty() {
    try {
      setBusy(true);
      setError(null);
      await apiRequest('/api/party/clear', {
        method: 'POST',
      });
      setPins({});
      await loadSession();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not clear viewer party');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      setBusy(true);
      // Log out forgets the remembered token — the next visit shows the portal
      // login instead of silently re-entering.
      window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
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

  // Fetch one series' episodes, optionally keyword-scoped to THIS series (AC4).
  // Sequenced with a request id so a stale in-flight search can never clobber a
  // fresher one (same pattern as the top-level library search).
  async function loadEpisodesFor(seriesId: string, searchTerm: string) {
    const requestId = (episodeSearchRequestIdRef.current += 1);
    try {
      setEpisodesLoading(true);
      const params = new URLSearchParams();
      if (searchTerm.trim()) {
        params.set('q', searchTerm.trim());
      }
      const query = params.toString();
      const response = await apiRequest<{ items: EpisodeItem[] }>(
        `/api/shows/${seriesId}/episodes${query ? `?${query}` : ''}`,
      );
      if (requestId !== episodeSearchRequestIdRef.current) {
        return;
      }
      setEpisodes(response.items);
    } catch (nextError) {
      if (requestId !== episodeSearchRequestIdRef.current) {
        return;
      }
      setEpisodes([]);
      setError(nextError instanceof Error ? nextError.message : 'Could not load episodes');
    } finally {
      if (requestId === episodeSearchRequestIdRef.current) {
        setEpisodesLoading(false);
      }
    }
  }

  // Open the show detail modal for any clickable show title (media card,
  // continue-watching card, etc.) — accepts just id/name so every call site
  // works whether it has a full LibraryItem or only a seriesId/seriesName.
  // Purely additive local-state open: it never touches the page's own
  // list/query state behind it (AC1).
  async function openShowDetail(series: { id: string; name: string }) {
    setSelectedSeries(series);
    setSelectedSeason(null);
    setEpisodeSearchQuery('');
    setError(null);
    await loadEpisodesFor(series.id, '');
  }

  function closeShowDetail() {
    setSelectedSeries(null);
    setEpisodes([]);
    setSelectedSeason(null);
    setEpisodeSearchQuery('');
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
      // Mint a fresh per-party Jellyfin playback session, then seed Jellyfin-web's
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

  function cancelCountdown() {
    setCountdown(null);
  }

  function cancelPendingDismissal() {
    setPendingDismissal(null);
  }

  function clearHoldTimer() {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }

  function moveTonight(direction: 'left' | 'right') {
    cancelCountdown();
    cancelPendingDismissal();
    setTonightState((current) => moveTonightFocus(current, direction));
  }

  function supportFocusedTonightItem() {
    cancelCountdown();
    cancelPendingDismissal();
    setTonightState((current) => addTonightSentiment(current));
  }

  function beginDismissFocusedTonightItem(kind: 'not-now' | 'not-for-us' = 'not-now') {
    cancelCountdown();
    const focusedId = tonightState.slots.center;
    if (!focusedId) {
      return;
    }
    setPendingDismissal({ itemId: focusedId, kind });
  }

  function removePendingTonightItem() {
    setTonightState((current) => dismissFocusedTonightCard(current));
    setPendingDismissal(null);
  }

  function playTonightItem(item: LibraryItem) {
    cancelCountdown();
    void openPlayback({ id: item.id, title: item.name });
  }

  function countdownTargetItem(): LibraryItem | null {
    return leaderItem ?? focusedTonightItem;
  }

  function startTonightCountdown() {
    const item = countdownTargetItem();
    if (!item) {
      return;
    }
    setPendingDismissal(null);
    setCountdown({ itemId: item.id, seconds: 3 });
  }

  function handleTonightKeyDown(event: KeyboardEvent) {
    if (!session?.authenticated || !appFlags.tonightsNine || searchQuery.trim() || selectedSeries || playingItem) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)) {
      return;
    }
    if (event.repeat) {
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveTonight('left');
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveTonight('right');
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      supportFocusedTonightItem();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cancelCountdown();
      clearHoldTimer();
      holdActionRef.current = 'down';
      holdTimerRef.current = window.setTimeout(() => {
        holdTimerRef.current = null;
        holdActionRef.current = null;
        beginDismissFocusedTonightItem('not-for-us');
      }, 650);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      clearHoldTimer();
      holdActionRef.current = 'enter';
      holdTimerRef.current = window.setTimeout(() => {
        holdTimerRef.current = null;
        holdActionRef.current = null;
        if (focusedTonightItem) {
          playTonightItem(focusedTonightItem);
        }
      }, 650);
    }
  }

  function handleTonightKeyUp(event: KeyboardEvent) {
    if (!appFlags.tonightsNine) {
      return;
    }

    if (event.key === 'ArrowDown' && holdActionRef.current === 'down') {
      event.preventDefault();
      clearHoldTimer();
      holdActionRef.current = null;
      beginDismissFocusedTonightItem('not-now');
    }
    if (event.key === 'Enter' && holdActionRef.current === 'enter') {
      event.preventDefault();
      clearHoldTimer();
      holdActionRef.current = null;
      startTonightCountdown();
    }
  }

  useEffect(() => {
    document.addEventListener('keydown', handleTonightKeyDown);
    document.addEventListener('keyup', handleTonightKeyUp);
    return () => {
      document.removeEventListener('keydown', handleTonightKeyDown);
      document.removeEventListener('keyup', handleTonightKeyUp);
    };
  });

  useEffect(() => () => {
    clearHoldTimer();
    holdActionRef.current = null;
  }, []);

  useEffect(() => {
    if (!pendingDismissal || pendingDismissal.itemId !== tonightState.slots.center) {
      return;
    }
    const timer = window.setTimeout(removePendingTonightItem, 1800);
    return () => window.clearTimeout(timer);
  }, [pendingDismissal, tonightState.slots.center]);

  useEffect(() => {
    if (!countdown) {
      return;
    }
    if (countdown.seconds <= 0) {
      const item = recommendationsById.get(countdown.itemId);
      if (item) {
        playTonightItem(item);
      } else {
        setCountdown(null);
      }
      return;
    }
    const timer = window.setTimeout(() => {
      setCountdown((current) =>
        current && current.itemId === countdown.itemId
          ? { ...current, seconds: current.seconds - 1 }
          : current,
      );
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, recommendationsById]);

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

  // Accessible show detail modal: focus moves INTO the dialog on open (so
  // screen readers land on it) and Escape closes it, without touching the page
  // state behind it (AC1) — same pattern as the player modal above.
  useEffect(() => {
    if (!selectedSeries) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const raf = window.requestAnimationFrame(() => showModalRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeShowDetail();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSeries?.id]);

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
          <p className="lead">Enter your access token, then choose who is watching together.</p>
          <form className="stack" onSubmit={handleLogin}>
            <label>
              <span>Access token</span>
              <input
                type="password"
                autoComplete="off"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
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
              <h1>Pick the party</h1>
            </div>
            <button className="ghost" onClick={() => void logout()}>Log out</button>
          </div>
          <div className="viewer-grid">
            {/* Primaries (preselected), then secondaries, then any ADDED guests.
                No PIN badges — guest pins are collected at Continue time. */}
            {[...primaryViewers, ...secondaryViewers, ...addedGuests].map((viewer) => {
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
            {tertiaryViewers.some((viewer) => !selectedViewerIds.includes(viewer.id)) ? (
              <button
                className="viewer-card add-guest-card"
                onClick={() => openGuestModal()}
                type="button"
                aria-label="Add guest"
              >
                <span className="viewer-avatar add-guest-plus" aria-hidden="true">+</span>
                <strong>Add guest</strong>
              </button>
            ) : null}
          </div>
          {savedParties.length > 0 ? (
            <div className="stack saved-groups">
              <p className="eyebrow">Saved parties</p>
              <div className="viewer-grid">
                {savedParties.map((party) => {
                  const selected =
                    party.memberIds.length === selectedViewerIds.length &&
                    party.memberIds.every((id) => selectedViewerIds.includes(id));
                  return (
                    <button
                      key={party.partyKey}
                      className={`viewer-card saved-group-card${selected ? ' selected' : ''}`}
                      onClick={() => selectSavedParty(party)}
                      type="button"
                    >
                      <strong>{party.alias}</strong>
                      <span className="muted">{party.memberNames.join(', ')}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="row spread">
            <button
              disabled={busy || selectedViewerIds.length === 0}
              onClick={handleContinue}
              type="button"
            >
              Continue
            </button>
          </div>
          {error ? <p className="error">{error}</p> : null}
        </div>
        {guestModalOpen ? (
          <div className="modal-backdrop" onClick={cancelGuestModal}>
            <div className="modal guest-modal" onClick={(event) => event.stopPropagation()}>
              <div className="row spread">
                <div>
                  <p className="eyebrow">Guests</p>
                  <h2>{guestModalForContinue ? 'Enter guest PINs' : 'Add guests'}</h2>
                </div>
                <button className="ghost" onClick={cancelGuestModal} type="button">Cancel</button>
              </div>
              {guestCandidates.length === 0 ? (
                <p className="muted">No guests can be added right now.</p>
              ) : (
                <div className="stack">
                  {guestCandidates.map((viewer) => {
                    const selected = guestDraftIds.includes(viewer.id);
                    return (
                      <div className="guest-row" key={`guest-${viewer.id}`}>
                        <button
                          className={`viewer-card guest-card${selected ? ' selected' : ''}`}
                          onClick={() => toggleGuestDraft(viewer.id)}
                          type="button"
                        >
                          <ViewerAvatar viewer={viewer} />
                          <strong>{viewer.name}</strong>
                        </button>
                        {/* PINs are only typed at Continue time — the plain
                            add flow is selection-only. */}
                        {selected && guestModalForContinue ? (
                          <label>
                            <span>{viewer.name}’s PIN</span>
                            <input
                              type="password"
                              inputMode="numeric"
                              autoComplete="off"
                              value={guestDraftPins[viewer.id] ?? ''}
                              onChange={(event) =>
                                setGuestDraftPins((current) => ({ ...current, [viewer.id]: event.target.value }))
                              }
                            />
                          </label>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
              {/* The server's pin rejection (403) lands HERE so the user can
                  retype and resubmit at the point of entry. */}
              {guestModalError ? <p className="error">{guestModalError}</p> : null}
              <div className="row spread">
                <button className="ghost" onClick={cancelGuestModal} type="button">Cancel</button>
                <button
                  disabled={guestConfirmDisabled || busy}
                  onClick={() => void confirmGuestModal()}
                  type="button"
                >
                  {guestModalForContinue ? 'Confirm PINs' : 'Add guests'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {confirmMixedOpen ? (
          <div className="modal-backdrop" onClick={() => setConfirmMixedOpen(false)}>
            <div className="modal confirm-modal" onClick={(event) => event.stopPropagation()}>
              <p className="eyebrow">Heads up</p>
              <h2>Everyone ready?</h2>
              <p className="muted">
                You selected {selectedViewerNames}. Continue only if everyone listed is watching
                now; their watch progress and watched/unwatched states will all be updated.
              </p>
              <div className="row spread">
                <button className="ghost" onClick={() => setConfirmMixedOpen(false)} type="button">Cancel</button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setConfirmMixedOpen(false);
                    void saveParty(selectedViewerIds, pins);
                  }}
                  type="button"
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="hero">
        <span className="brand">{session.appName}</span>
        <div className="hero-actions">
          {session.activePartyAlias ? (
            <span className="muted group-alias">{session.activePartyAlias}</span>
          ) : null}
          <button className="ghost compact" onClick={() => setIgnoredOpen(true)} type="button">
            Ignored{ignoredItems.length > 0 ? ` (${ignoredItems.length})` : ''}
          </button>
          <button className="ghost compact" onClick={() => void clearParty()} type="button">Change viewers</button>
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
          <p className="muted">Nothing in progress for this party yet.</p>
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
                    ? (
                      <>
                        {item.seriesId && item.seriesName ? (
                          <button
                            className="link-title link-title-inline"
                            onClick={() => void openShowDetail({ id: item.seriesId as string, name: item.seriesName as string })}
                            type="button"
                          >
                            {item.seriesName}
                          </button>
                        ) : (
                          item.seriesName
                        )}
                        {item.seasonNumber && item.episodeNumber
                          ? ` • S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')}`
                          : null}
                      </>
                    )
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

      {!appFlags.tonightsNine || searchQuery.trim() ? null : (
        <section className={`panel section-block tonight-panel${exhaustedTonight ? ' exhausted' : ''}`}>
          <div className="row spread">
            <div>
              <p className="eyebrow">Tonight's Nine</p>
              <h2>{exhaustedTonight ? 'Search is up' : 'Pick for the room'}</h2>
            </div>
            <div className="tonight-status">
              {libraryLoading ? <span className="muted">Refreshing…</span> : null}
              {leaderItem ? <span className="leader-pill">Leader: {leaderItem.name}</span> : null}
              {countdown ? (
                <span className="countdown-pill">
                  Playing {recommendationsById.get(countdown.itemId)?.name ?? 'selection'} in {countdown.seconds}
                </span>
              ) : null}
            </div>
          </div>
          {libraryLoading ? <p className="muted">Loading recommendations…</p> : null}
          {!libraryLoading && recommendations.length === 0 && !exhaustedTonight ? (
            <p className="muted">No fresh recommendations match this filter yet. Try another genre or turn off kids-only.</p>
          ) : null}
          {exhaustedTonight && recommendations.length > 0 ? (
            <div className="search-fallback">
              <p className="muted">Tonight's Nine missed. Use the filters and search box above to take over manually.</p>
            </div>
          ) : (
            <div className="tonight-grid" aria-label="Tonight's Nine recommendations">
              {tonightSlots.map(({ slot, item }) => (
                <TonightCard
                  key={`${slot}-${item.id}`}
                  item={item}
                  slot={slot}
                  pendingKind={pendingDismissal?.itemId === item.id ? pendingDismissal.kind : null}
                  isLeader={leaderId === item.id}
                  countdownSeconds={countdown?.itemId === item.id ? countdown.seconds : null}
                  onMoveLeft={() => moveTonight('left')}
                  onMoveRight={() => moveTonight('right')}
                  onSupport={supportFocusedTonightItem}
                  onDismiss={() => beginDismissFocusedTonightItem('not-now')}
                  onPlayCountdown={startTonightCountdown}
                  onPlayNow={() => playTonightItem(item)}
                  onOpenShowDetail={openShowDetail}
                  onIgnore={ignore}
                />
              ))}
            </div>
          )}
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
                onOpenShowDetail={openShowDetail}
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
        <div className="modal-backdrop" onClick={closeShowDetail}>
          <div
            ref={showModalRef}
            className="modal show-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedSeries.name} episodes`}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="row spread">
              <div>
                <p className="eyebrow">Show</p>
                <h2>{selectedSeries.name}</h2>
              </div>
              <button className="ghost" onClick={closeShowDetail} type="button">Close</button>
            </div>
            <label className="search-field">
              <span>Search episodes in {selectedSeries.name}</span>
              <input
                type="search"
                value={episodeSearchQuery}
                onChange={(event) => setEpisodeSearchQuery(event.target.value)}
                placeholder="Search by title or keyword…"
              />
            </label>
            {(() => {
              // Season buttons — grouped/filterable list (AC2). Seasons are
              // derived from whatever episodes the current keyword search
              // returned, so the filter row narrows along with search results
              // instead of showing seasons no longer in view.
              const seasonNumbers = [...new Set(
                episodes
                  .map((episode) => episode.seasonNumber)
                  .filter((season): season is number => typeof season === 'number'),
              )].sort((left, right) => left - right);

              const visibleEpisodes = selectedSeason == null
                ? episodes
                : episodes.filter((episode) => episode.seasonNumber === selectedSeason);

              return (
                <>
                  {seasonNumbers.length > 0 ? (
                    <div className="season-filter-row" role="group" aria-label="Filter by season">
                      <button
                        className={selectedSeason == null ? 'selected' : ''}
                        onClick={() => setSelectedSeason(null)}
                        type="button"
                      >
                        All seasons
                      </button>
                      {seasonNumbers.map((season) => (
                        <button
                          key={`season-${season}`}
                          className={selectedSeason === season ? 'selected' : ''}
                          onClick={() => setSelectedSeason(season)}
                          type="button"
                        >
                          Season {season}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {episodesLoading ? <p className="muted">Loading episodes…</p> : null}
                  {!episodesLoading && episodes.length === 0 ? (
                    <p className="muted">
                      {episodeSearchQuery.trim()
                        ? `No episodes of ${selectedSeries.name} match “${episodeSearchQuery.trim()}”.`
                        : 'No episodes were found for this series.'}
                    </p>
                  ) : null}
                  {!episodesLoading && episodes.length > 0 && visibleEpisodes.length === 0 ? (
                    <p className="muted">No episodes in this season match the current search.</p>
                  ) : null}
                  <div className="episode-list">
                    {visibleEpisodes.map((episode) => {
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
                            {/* Per-watcher seen/unseen for THIS episode (AC3) — display-only,
                                mirrors the continue-watching viewer pills but without a click
                                handler: this modal never edits watched state. */}
                            {episode.viewerWatched && episode.viewerWatched.length > 0 ? (
                              <div className="viewer-pills" aria-label="Watched state per viewer">
                                {episode.viewerWatched.map((viewer) => (
                                  <span
                                    key={viewer.viewerId}
                                    className={`viewer-pill viewer-pill-static${viewer.watched ? ' watched' : ''}`}
                                    title={`${viewer.viewerName} — ${viewer.watched ? 'watched' : 'not watched'}`}
                                  >
                                    {viewer.avatarUrl ? (
                                      <img className="viewer-pill-avatar" src={viewer.avatarUrl} alt={viewer.viewerName} />
                                    ) : (
                                      <span className="viewer-pill-avatar">{viewer.viewerName.slice(0, 1)}</span>
                                    )}
                                    {viewer.watched ? <span className="viewer-pill-check" aria-hidden="true">✓</span> : null}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <div className="row">
                            <button
                              onClick={() => {
                                void openPlayback({
                                  id: episode.id,
                                  title: episode.name,
                                  subtitle: `${selectedSeries.name}${label ? ` • ${label}` : ''}`,
                                });
                                closeShowDetail();
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
                </>
              );
            })()}
          </div>
        </div>
      ) : null}

      {ignoredOpen ? (
        <div className="modal-backdrop" onClick={() => setIgnoredOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="row spread">
              <div>
                <p className="eyebrow">This party</p>
                <h2>Ignored</h2>
              </div>
              <button className="ghost" onClick={() => setIgnoredOpen(false)} type="button">Close</button>
            </div>
            {ignoredItems.length === 0 ? (
              <p className="muted">Nothing is ignored for this party. Use “Ignore” on a card to hide it everywhere.</p>
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
  onOpenShowDetail,
  onIgnore,
}: {
  item: LibraryItem;
  onMarkWatched: (itemId: string) => Promise<void>;
  onPlay: (item: { id: string; title: string }) => Promise<void>;
  onOpenShowDetail: (series: { id: string; name: string }) => Promise<void>;
  onIgnore: (item: LibraryItem) => Promise<void>;
}) {
  // Shows are actionable by title everywhere they appear (AC1); movies have no
  // show detail modal, so their title stays plain text.
  const isShow = item.type === 'show';

  return (
    <article className="media-card">
      <div className="poster" style={item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : undefined}>
        {!item.imageUrl ? <span>No artwork</span> : null}
      </div>
      <div className="media-copy">
        <div className="row spread top-align">
          {isShow ? (
            <button
              className="link-title"
              onClick={() => void onOpenShowDetail({ id: item.id, name: item.name })}
              type="button"
            >
              <h3>{item.name}</h3>
            </button>
          ) : (
            <h3>{item.name}</h3>
          )}
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
          <button onClick={() => void onOpenShowDetail({ id: item.id, name: item.name })} type="button">Episodes</button>
        )}
        <button className="ghost" onClick={() => void onMarkWatched(item.id)} type="button">Mark watched</button>
        <button className="ghost" onClick={() => void onIgnore(item)} type="button">Ignore</button>
      </div>
    </article>
  );
}

function TonightCard({
  item,
  slot,
  pendingKind,
  isLeader,
  countdownSeconds,
  onMoveLeft,
  onMoveRight,
  onSupport,
  onDismiss,
  onPlayCountdown,
  onPlayNow,
  onOpenShowDetail,
  onIgnore,
}: {
  item: LibraryItem;
  slot: TonightSlot;
  pendingKind: 'not-now' | 'not-for-us' | null;
  isLeader: boolean;
  countdownSeconds: number | null;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onSupport: () => void;
  onDismiss: () => void;
  onPlayCountdown: () => void;
  onPlayNow: () => void;
  onOpenShowDetail: (series: { id: string; name: string }) => Promise<void>;
  onIgnore: (item: LibraryItem) => Promise<void>;
}) {
  const focused = slot === 'center';
  const isShow = item.type === 'show';
  const reasons = recommendationReasonsFor(item);
  const slotLabel = slot === 'center' ? 'Selected' : slot === 'left' ? 'Left option' : 'Right option';

  return (
    <article
      className={`tonight-card ${slot}${focused ? ' focused' : ''}${pendingKind ? ' pending' : ''}`}
      aria-label={`${slotLabel}: ${item.name}`}
      onClick={() => {
        if (slot === 'left') onMoveLeft();
        if (slot === 'right') onMoveRight();
      }}
    >
      <div
        className="tonight-art"
        style={item.backdropUrl || item.imageUrl ? { backgroundImage: `url(${item.backdropUrl ?? item.imageUrl})` } : undefined}
      >
        {!item.backdropUrl && !item.imageUrl ? <span>No artwork</span> : null}
        {isLeader ? <span className="leader-corner">Leader</span> : null}
        {countdownSeconds !== null ? <span className="countdown-corner">{countdownSeconds}</span> : null}
      </div>
      <div className="tonight-copy">
        <p className="eyebrow">{slotLabel}</p>
        {isShow ? (
          <button
            className="link-title tonight-title"
            onClick={(event) => {
              event.stopPropagation();
              void onOpenShowDetail({ id: item.id, name: item.name });
            }}
            type="button"
          >
            <h3>{item.name}</h3>
          </button>
        ) : (
          <h3>{item.name}</h3>
        )}
        <p className="meta">{formatMediaMeta(item)}</p>
        <div className="reason-list">
          {reasons.map((reason) => (
            <span key={reason}>{reason}</span>
          ))}
        </div>
        {pendingKind ? (
          <p className="pending-copy">
            {pendingKind === 'not-for-us' ? 'Removing as not for us…' : 'Removing for tonight…'}
          </p>
        ) : null}
      </div>
      {focused ? (
        <div className="tonight-actions">
          <button type="button" onClick={onSupport}>Vote</button>
          <button className="ghost" type="button" onClick={onDismiss}>Not now</button>
          {item.playable ? (
            <>
              <button type="button" onClick={onPlayCountdown}>Play</button>
              <button className="ghost" type="button" onClick={onPlayNow}>Play now</button>
            </>
          ) : (
            <button type="button" onClick={() => void onOpenShowDetail({ id: item.id, name: item.name })}>Episodes</button>
          )}
          <button className="ghost" type="button" onClick={() => void onIgnore(item)}>Hide</button>
        </div>
      ) : null}
    </article>
  );
}
