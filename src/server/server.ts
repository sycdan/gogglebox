import crypto from 'node:crypto';
import path from 'node:path';

import express from 'express';
import session from 'express-session';

import { AppState } from './appState';
import { loadConfig } from './config';
import { anchorShowCards } from './anchorShowCards';
import {
  ContinueWatchingCandidate,
  getProgressPropagationTargets,
  mergeContinueWatching,
} from './continueWatching';
import { deriveGroupKey } from './groupKey';
import { JellyfinClient } from './jellyfin';
import { ContinueWatchingItem, FamilyMember, LibraryItem, LibraryKind, ViewerWatchedState } from './types';
import { computeWatchedFanout } from './watchedFanout';

const config = loadConfig();
const jellyfin = new JellyfinClient(config.jellyfinUrl, config.jellyfinApiKey);
const appState = new AppState();
const app = express();
const clientDist = path.resolve(process.cwd(), 'dist/client');
const jellyfinDebugEnabled = process.env.JELLYFIN_DEBUG === '1' || process.env.JELLYFIN_DEBUG === 'true';

function isKidsContent(item: LibraryItem): boolean {
  const rating = item.officialRating?.toUpperCase() ?? '';
  if (['G', 'PG', 'TV-Y', 'TV-Y7'].includes(rating)) {
    return true;
  }

  return item.genres.some((genre) => ['animation', 'family', 'kids'].includes(genre.toLowerCase()));
}

function getSelectedViewers(): FamilyMember[] {
  const activeViewerIds = app.locals.sessionViewerIds as string[] | undefined;
  return config.viewers.filter((viewer) => activeViewerIds?.includes(viewer.id));
}

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!req.session.isAuthenticated) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  next();
}

function requireViewerGroup(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!req.session.activeViewerIds?.length) {
    res.status(400).json({ error: 'Select at least one viewer first' });
    return;
  }

  next();
}

function activeViewersForSession(req: express.Request): FamilyMember[] {
  return config.viewers.filter((viewer) => req.session.activeViewerIds?.includes(viewer.id));
}

// Deterministic, order-independent key for the active viewer group, derived from
// the selected Jellyfin user ids. Same set of people -> same key.
function activeGroupKey(req: express.Request): string {
  const jellyfinUserIds = activeViewersForSession(req).map((viewer) => viewer.jellyfinUserId);
  return deriveGroupKey(jellyfinUserIds);
}

function ignoredItemsForSession(req: express.Request): Set<string> {
  return new Set(appState.getIgnoredItems(activeGroupKey(req)));
}

// The id used to ignore an item: the series id for shows, the item id for movies.
function ignorableId(item: { type: LibraryKind; id: string; seriesId?: string | null }): string {
  return item.type === 'show' && item.seriesId ? item.seriesId : item.id;
}

function getItemId(req: express.Request): string {
  return Array.isArray(req.params.itemId) ? req.params.itemId[0] : req.params.itemId;
}

async function getWatchedUnion(viewers: FamilyMember[], kind: LibraryKind): Promise<Set<string>> {
  const startedAt = Date.now();
  if (jellyfinDebugEnabled) {
    console.log(`[app] getWatchedUnion start kind=${kind} viewers=${viewers.map((viewer) => viewer.id).join(',')}`);
  }

  const watchedSets = await Promise.all(
    viewers.map((viewer) => jellyfin.getWatchedItemIds(viewer.jellyfinUserId, kind)),
  );

  const watchedUnion = new Set<string>();
  watchedSets.forEach((watchedSet) => {
    watchedSet.forEach((itemId) => watchedUnion.add(itemId));
  });

  if (jellyfinDebugEnabled) {
    console.log(`[app] getWatchedUnion done kind=${kind} size=${watchedUnion.size} (${Date.now() - startedAt}ms)`);
  }

  return watchedUnion;
}

async function getContinueWatchingItems(viewers: FamilyMember[]): Promise<ContinueWatchingItem[]> {
  const startedAt = Date.now();
  const candidateGroups = await Promise.all(
    viewers.map(async (viewer) => {
      const [movieItems, showItems] = await Promise.all([
        jellyfin.listContinueWatching(viewer.jellyfinUserId, 'movie'),
        jellyfin.listShowContinueWatching(viewer.jellyfinUserId),
      ]);
      return [...movieItems, ...showItems].map(
        (item): ContinueWatchingCandidate => ({
          ...item,
          sourceViewerId: viewer.id,
          sourceViewerName: viewer.name,
        }),
      );
    }),
  );
  const merged = mergeContinueWatching(candidateGroups.flat());

  if (jellyfinDebugEnabled) {
    console.log(
      `[app] getContinueWatchingItems done viewers=${viewers.map((viewer) => viewer.id).join(',')} result=${merged.length} (${Date.now() - startedAt}ms)`,
    );
  }

  return merged;
}

// Attach, per continue-watching card, each active viewer's played state for that
// card's current episode/movie item. State is read live from Jellyfin (per-user
// UserData.Played), so no local persistence is needed.
async function withViewerWatchedState(
  items: ContinueWatchingItem[],
  viewers: FamilyMember[],
): Promise<ContinueWatchingItem[]> {
  return Promise.all(
    items.map(async (item) => {
      const viewerWatched: ViewerWatchedState[] = await Promise.all(
        viewers.map(async (viewer) => ({
          viewerId: viewer.id,
          viewerName: viewer.name,
          avatarUrl: viewer.avatarUrl ?? null,
          watched: await jellyfin.getItemPlayedState(viewer.jellyfinUserId, item.id),
        })),
      );
      return { ...item, viewerWatched };
    }),
  );
}

// True only when every active viewer has played the card's current item.
function allViewersWatched(item: ContinueWatchingItem): boolean {
  const viewerWatched = item.viewerWatched ?? [];
  return viewerWatched.length > 0 && viewerWatched.every((viewer) => viewer.watched);
}

// Read every active viewer's played state for a single item id in one pass.
async function viewerWatchedFor(itemId: string, viewers: FamilyMember[]): Promise<ViewerWatchedState[]> {
  return Promise.all(
    viewers.map(async (viewer) => ({
      viewerId: viewer.id,
      viewerName: viewer.name,
      avatarUrl: viewer.avatarUrl ?? null,
      watched: await jellyfin.getItemPlayedState(viewer.jellyfinUserId, itemId),
    })),
  );
}

// Resolve a single fully-watched card. Movies (or shows with no next episode)
// drop out entirely. Shows advance to the next episode; if that episode is also
// already watched by everyone, keep advancing until we reach one someone still
// needs to watch (which becomes the new card) or run out of episodes (drop).
async function advanceWatchedCard(
  item: ContinueWatchingItem,
  viewers: FamilyMember[],
): Promise<ContinueWatchingItem | null> {
  if (item.type !== 'show' || !item.seriesId) {
    return null;
  }

  let seasonNumber = item.seasonNumber;
  let episodeNumber = item.episodeNumber;

  // Bounded by the episode count of the series (getNextEpisode returns null at
  // the end), so this loop always terminates.
  for (;;) {
    const next = await jellyfin.getNextEpisode(item.seriesId, seasonNumber, episodeNumber);
    if (!next) {
      return null;
    }

    const viewerWatched = await viewerWatchedFor(next.id, viewers);
    const card: ContinueWatchingItem = {
      ...item,
      id: next.id,
      name: next.name,
      overview: next.overview,
      runtimeMinutes: next.runtimeMinutes,
      imageUrl: next.imageUrl,
      seriesId: next.seriesId || item.seriesId,
      seriesName: next.seriesName || item.seriesName,
      seasonNumber: next.seasonNumber,
      episodeNumber: next.episodeNumber,
      playbackPositionTicks: 0,
      progressPercent: 0,
      viewerWatched,
    };

    if (!allViewersWatched(card)) {
      return card;
    }

    seasonNumber = next.seasonNumber;
    episodeNumber = next.episodeNumber;
  }
}

// Apply the fully-watched policy to the card list: cards everyone has watched
// either advance to the next unwatched episode (shows) or disappear (movies and
// end-of-series shows). Partially-watched cards pass through unchanged.
async function resolveWatchedCards(
  items: ContinueWatchingItem[],
  viewers: FamilyMember[],
): Promise<ContinueWatchingItem[]> {
  const resolved = await Promise.all(
    items.map(async (item) => (allViewersWatched(item) ? advanceWatchedCard(item, viewers) : item)),
  );

  return resolved.filter((item): item is ContinueWatchingItem => item !== null);
}

app.disable('x-powered-by');
app.use(express.json());
app.use((req, res, next) => {
  if (!jellyfinDebugEnabled || !req.path.startsWith('/api/')) {
    next();
    return;
  }

  const startedAt = Date.now();
  console.log(`[api] -> ${req.method} ${req.originalUrl}`);
  res.on('finish', () => {
    console.log(`[api] <- ${res.statusCode} ${req.method} ${req.originalUrl} (${Date.now() - startedAt}ms)`);
  });
  next();
});
app.use(
  session({
    name: 'gogglebox.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 12,
    },
  }),
);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, appName: config.appName });
});

app.get('/api/session', (req, res) => {
  res.json({
    authenticated: Boolean(req.session.isAuthenticated),
    portalAutoLoginEnabled: config.portalAutoLogin,
    appName: config.appName,
    watchedThreshold: config.watchedThreshold,
    viewers: req.session.isAuthenticated ? config.viewers : [],
    groups: req.session.isAuthenticated ? config.groups : [],
    activeViewerIds: req.session.activeViewerIds ?? [],
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const canAutoLogin = config.portalAutoLogin && !username && !password;

  if (!canAutoLogin && (username !== config.household.username || password !== config.household.password)) {
    res.status(401).json({ error: 'Invalid household credentials' });
    return;
  }

  req.session.isAuthenticated = true;
  res.json({ ok: true });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      res.status(500).json({ error: 'Could not end session' });
      return;
    }

    res.status(204).end();
  });
});

app.post('/api/group', requireAuth, (req, res) => {
  const memberIds = Array.isArray(req.body?.memberIds)
    ? req.body.memberIds.filter((value: unknown): value is string => typeof value === 'string')
    : [];

  if (!memberIds.length) {
    res.status(400).json({ error: 'Choose at least one viewer' });
    return;
  }

  const knownViewerIds = new Set(config.viewers.map((viewer) => viewer.id));
  const invalidMember = memberIds.find((memberId: string) => !knownViewerIds.has(memberId));
  if (invalidMember) {
    res.status(400).json({ error: `Unknown viewer: ${invalidMember}` });
    return;
  }

  req.session.activeViewerIds = memberIds;
  res.json({ ok: true, activeViewerIds: memberIds });
});

app.post('/api/group/clear', requireAuth, (req, res) => {
  req.session.activeViewerIds = [];
  res.json({ ok: true, activeViewerIds: [] });
});

app.get('/api/library', requireAuth, async (req, res) => {
  try {
    const kind = req.query.kind === 'show' ? 'show' : 'movie';
    const genre = typeof req.query.genre === 'string' && req.query.genre ? req.query.genre : undefined;
    const kidsOnly = req.query.kidsOnly === 'true';
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    if (!query) {
      res.json({ items: [] });
      return;
    }

    let items = await jellyfin.listItems(kind, genre, query);

    if (kidsOnly) {
      items = items.filter(isKidsContent);
    }

    if (req.session.activeViewerIds?.length) {
      const ignoredItems = ignoredItemsForSession(req);
      items = items.filter((item) => !ignoredItems.has(ignorableId(item)));
    }

    res.json({ items });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Library lookup failed' });
  }
});

app.get('/api/recommendations', requireAuth, requireViewerGroup, async (req, res) => {
  try {
    const kind = req.query.kind === 'show' ? 'show' : 'movie';
    const genre = typeof req.query.genre === 'string' && req.query.genre ? req.query.genre : undefined;
    const kidsOnly = req.query.kidsOnly === 'true';
    const excludeParam = typeof req.query.exclude === 'string' ? req.query.exclude : '';
    const excludeIds = new Set(
      excludeParam.split(',').map((id) => id.trim()).filter(Boolean),
    );
    const viewers = activeViewersForSession(req);
    const watchedUnion = await getWatchedUnion(viewers, kind);
    const ignoredItems = ignoredItemsForSession(req);
    let candidates = await jellyfin.listItems(kind, genre);

    if (kidsOnly) {
      candidates = candidates.filter(isKidsContent);
    }

    const items = candidates
      .filter((item) => !watchedUnion.has(item.id) && !excludeIds.has(item.id) && !ignoredItems.has(ignorableId(item)))
      .sort((left, right) => (right.rating ?? 0) - (left.rating ?? 0))
      .slice(0, config.recommendations.count);

    res.json({ items });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Recommendation lookup failed' });
  }
});

app.get('/api/continue-watching', requireAuth, requireViewerGroup, async (req, res) => {
  try {
    const viewers = activeViewersForSession(req);
    const ignoredItems = ignoredItemsForSession(req);
    const visible = (await getContinueWatchingItems(viewers)).filter(
      (item) => !ignoredItems.has(ignorableId(item)),
    );
    if (jellyfinDebugEnabled) {
      for (const item of visible) {
        console.log(
          `[anchor] merged card type=${item.type} id=${item.id} name=${JSON.stringify(item.name)} ` +
          `seriesId=${JSON.stringify(item.seriesId)} season=${item.seasonNumber} episode=${item.episodeNumber} ` +
          `progress=${item.progressPercent} sourceViewer=${item.sourceViewerName}`,
        );
      }
    }
    // Re-anchor SHOW cards to the group's stable earliest-not-all-watched episode
    // BEFORE computing pills, so pills reflect the displayed (anchor) episode.
    const anchored = await anchorShowCards(jellyfin, visible, viewers);
    const withWatched = await withViewerWatchedState(anchored, viewers);
    const items = await resolveWatchedCards(withWatched, viewers);
    res.json({ items });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Continue watching lookup failed' });
  }
});

app.get('/api/ignored', requireAuth, requireViewerGroup, async (req, res) => {
  const itemIds = appState.getIgnoredItems(activeGroupKey(req));

  // Resolve human-readable titles so the client doesn't render raw ids. An id
  // that no longer resolves (deleted item) or a lookup failure falls back to
  // showing the id.
  let names = new Map<string, string>();
  try {
    names = await jellyfin.fetchItemNames(itemIds);
  } catch (error) {
    if (jellyfinDebugEnabled) {
      console.log(`[ignored] title lookup failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  const items = itemIds.map((id) => ({ id, title: names.get(id) ?? id }));
  res.json({ items });
});

app.post('/api/ignored', requireAuth, requireViewerGroup, (req, res) => {
  const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId.trim() : '';
  if (!itemId) {
    res.status(400).json({ error: 'itemId is required' });
    return;
  }

  const itemIds = appState.ignoreItem(activeGroupKey(req), itemId);
  res.json({ itemIds });
});

app.delete('/api/ignored/:itemId', requireAuth, requireViewerGroup, (req, res) => {
  const itemId = Array.isArray(req.params.itemId) ? req.params.itemId[0] : req.params.itemId;
  const itemIds = appState.unignoreItem(activeGroupKey(req), itemId);
  res.json({ itemIds });
});

app.get('/api/shows/:seriesId/episodes', requireAuth, requireViewerGroup, async (req, res) => {
  try {
    const seriesId = Array.isArray(req.params.seriesId) ? req.params.seriesId[0] : req.params.seriesId;
    const episodes = await jellyfin.listEpisodes(seriesId);
    res.json({ items: episodes });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Could not load episodes' });
  }
});

app.post('/api/items/:itemId/watched', requireAuth, requireViewerGroup, async (req, res) => {
  try {
    const viewers = activeViewersForSession(req);
    const itemId = getItemId(req);
    await Promise.all(viewers.map((viewer) => jellyfin.markPlayed(viewer.jellyfinUserId, itemId)));
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Could not mark item watched' });
  }
});

// Toggle a single viewer's played state for one item (the card's current
// episode/movie). The viewer must be in the active group. State lives in
// Jellyfin; we return the new value so the client can reconcile.
app.post('/api/items/:itemId/viewer-watched', requireAuth, requireViewerGroup, async (req, res) => {
  try {
    const viewerId = typeof req.body?.viewerId === 'string' ? req.body.viewerId : '';
    const watched = Boolean(req.body?.watched);
    const viewer = activeViewersForSession(req).find((candidate) => candidate.id === viewerId);

    if (!viewer) {
      res.status(400).json({ error: 'Viewer must be in the active group' });
      return;
    }

    const itemId = getItemId(req);
    if (watched) {
      await jellyfin.markPlayed(viewer.jellyfinUserId, itemId);
    } else {
      await jellyfin.markUnplayed(viewer.jellyfinUserId, itemId);
    }

    res.json({ viewerId, watched });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Could not update viewer watch state' });
  }
});

app.post('/api/items/:itemId/progress/sync', requireAuth, requireViewerGroup, async (req, res) => {
  try {
    const sourceViewerId = typeof req.body?.sourceViewerId === 'string' ? req.body.sourceViewerId : '';
    const playbackPositionTicks = Number(req.body?.playbackPositionTicks);
    const viewers = activeViewersForSession(req);
    const sourceViewer = viewers.find((viewer) => viewer.id === sourceViewerId);

    if (!sourceViewer) {
      res.status(400).json({ error: 'Source viewer must be in the active group' });
      return;
    }

    if (!Number.isFinite(playbackPositionTicks) || playbackPositionTicks < 0) {
      res.status(400).json({ error: 'Playback position must be a non-negative number of ticks' });
      return;
    }

    const activeViewerIds = viewers.map((viewer) => viewer.id);
    const targetViewerIds = getProgressPropagationTargets(activeViewerIds, sourceViewerId);
    const targetViewers = viewers.filter((viewer) => targetViewerIds.includes(viewer.id));
    const itemId = getItemId(req);

    await Promise.all(
      targetViewers.map((viewer) =>
        jellyfin.setPlaybackPosition(viewer.jellyfinUserId, itemId, playbackPositionTicks),
      ),
    );

    res.json({ ok: true, syncedViewerIds: targetViewerIds });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Could not sync playback progress' });
  }
});

app.delete('/api/items/:itemId/watched', requireAuth, requireViewerGroup, async (req, res) => {
  try {
    const viewers = activeViewersForSession(req);
    const itemId = getItemId(req);
    await Promise.all(viewers.map((viewer) => jellyfin.markUnplayed(viewer.jellyfinUserId, itemId)));
    res.status(204).end();
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Could not clear watch state' });
  }
});

// Stage A: mint a fresh Jellyfin playback session for the active group's
// gbx-owned JF user, so the client can seed Jellyfin-web's localStorage and
// auto-login in the /player tab. The active group id is the deterministic,
// order-independent key derived from the active viewers' Jellyfin user ids
// (activeGroupKey / deriveGroupKey) — same set of people -> same JF user. We
// rotate a random password on every mint and persist only the group->userId
// mapping (never the password).
app.post('/api/player/session', requireAuth, requireViewerGroup, async (req, res) => {
  try {
    const groupKey = activeGroupKey(req);
    const userId = await jellyfin.ensureGroupUser(groupKey);
    // Stage B: persist the group player user id AND the member ids (the active
    // viewers' Jellyfin user ids) so the watched fan-out poller can map this
    // player user's sessions back to the individual members to mark played.
    const memberIds = activeViewersForSession(req).map((viewer) => viewer.jellyfinUserId);
    appState.setGroupPlayerUser(groupKey, userId, memberIds);

    const deviceId = crypto.randomUUID();
    const token = await jellyfin.rotatePasswordAndAuthenticate(
      userId,
      jellyfin.groupUserName(groupKey),
      deviceId,
    );

    res.json({
      serverId: token.serverId,
      userId: token.userId,
      accessToken: token.accessToken,
      deviceId,
      playerOrigin: '/player',
    });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Could not start player session' });
  }
});

app.get('/api/items/:itemId/playback-url', requireAuth, requireViewerGroup, (req, res) => {
  const itemId = getItemId(req);
  const hasStartPosition = typeof req.query.startPositionTicks === 'string';
  const startPositionTicks = hasStartPosition ? Number(req.query.startPositionTicks) : undefined;

  if (hasStartPosition && (!Number.isFinite(startPositionTicks) || Number(startPositionTicks) < 0)) {
    res.status(400).json({ error: 'startPositionTicks must be a non-negative number of ticks' });
    return;
  }

  const rawUrl = jellyfin.buildPlaybackUrl(itemId, startPositionTicks);
  const playerOrigin = '/player';
  const parsedUrl = new URL(rawUrl, 'http://localhost');
  const url = parsedUrl.pathname.startsWith(`${playerOrigin}/`)
    ? rawUrl
    : `${playerOrigin}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`;
  res.json({ url });
});

app.get('/api/items/:itemId/playback-progress', requireAuth, requireViewerGroup, async (req, res) => {
  try {
    const itemId = getItemId(req);
    const viewers = activeViewersForSession(req);

    const [viewerPlayed, progressPercent] = await Promise.all([
      Promise.all(viewers.map((viewer) => jellyfin.getItemPlayedState(viewer.jellyfinUserId, itemId))),
      jellyfin.getPlaybackProgressForItem(itemId),
    ]);

    res.json({
      progressPercent,
      played: viewerPlayed.some(Boolean),
    });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Could not fetch playback progress' });
  }
});

app.use(express.static(clientDist));
app.get('/{*rest}', (_req, res, next) => {
  const indexPath = path.join(clientDist, 'index.html');
  res.sendFile(indexPath, (error) => {
    if (error) {
      next();
    }
  });
});

// ── Stage B: watched fan-out poller ────────────────────────────────────────
//
// A single server-side interval polls Jellyfin's active sessions. When a GROUP
// PLAYER user (minted by POST /api/player/session) crosses the watched threshold
// on the item it's playing, gbx marks that item Played for every INDIVIDUAL
// member id of the group. The decision logic is the pure computeWatchedFanout;
// this wrapper does the IO. Idempotent across ticks via the marked-set carried in
// `watchedFanoutMarked`.
const WATCHED_FANOUT_INTERVAL_MS = 5000;
let watchedFanoutMarked = new Set<string>();
let watchedFanoutRunning = false;

async function runWatchedFanoutTick(): Promise<void> {
  // Overlap guard: a slow tick must not stack with the next interval fire.
  if (watchedFanoutRunning) {
    return;
  }
  watchedFanoutRunning = true;

  try {
    // Map each group player jellyfinUserId -> the member ids to fan out to.
    const players = appState.getGroupPlayerUsers();
    const playerUserMembers = new Map<string, string[]>();
    for (const { jellyfinUserId, memberIds } of Object.values(players)) {
      if (jellyfinUserId && memberIds.length > 0) {
        playerUserMembers.set(jellyfinUserId, memberIds);
      }
    }
    if (playerUserMembers.size === 0) {
      // No minted group players yet (or none with members) — nothing to poll.
      watchedFanoutMarked = new Set<string>();
      return;
    }

    const sessions = await jellyfin.listSessions();
    const { marks, nextMarked } = computeWatchedFanout(
      watchedFanoutMarked,
      sessions,
      config.watchedThreshold,
      playerUserMembers,
    );
    watchedFanoutMarked = nextMarked;

    for (const mark of marks) {
      try {
        await jellyfin.markPlayed(mark.memberId, mark.itemId);
        if (jellyfinDebugEnabled) {
          console.log(
            `[fanout] marked played member=${mark.memberId} item=${mark.itemId} (player=${mark.playerUserId})`,
          );
        }
      } catch (markError) {
        // One member's mark failing shouldn't abort the rest or the poller.
        console.error(
          `[fanout] failed to mark played member=${mark.memberId} item=${mark.itemId}:`,
          markError instanceof Error ? markError.message : markError,
        );
      }
    }
  } catch (error) {
    // A poll error (e.g. Jellyfin blip) must NOT crash the server.
    console.error('[fanout] poll tick failed:', error instanceof Error ? error.message : error);
  } finally {
    watchedFanoutRunning = false;
  }
}

function startWatchedFanoutPoller(): void {
  const timer = setInterval(() => {
    void runWatchedFanoutTick();
  }, WATCHED_FANOUT_INTERVAL_MS);
  // Don't let the interval keep the process alive on shutdown.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  console.log(`[fanout] watched fan-out poller started (every ${WATCHED_FANOUT_INTERVAL_MS}ms, threshold ${config.watchedThreshold}).`);
}

void (async () => {
  try {
    const jellyfinUsers = await jellyfin.fetchUsers();
    const householdIds = new Set(config.groups.flatMap((group) => group.memberIds));
    config.viewers = jellyfinUsers.filter((user) => householdIds.has(user.id));
  } catch (err) {
    console.error('[startup] Failed to load viewers from Jellyfin:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  startWatchedFanoutPoller();

  app.listen(config.port, () => {
    console.log(`Gogglebox listening on http://localhost:${config.port}`);
  });
})();
