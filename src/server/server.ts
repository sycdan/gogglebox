import path from 'node:path';
import { Readable } from 'node:stream';

import express from 'express';
import session from 'express-session';

import { loadConfig } from './config';
import { ContinueWatchingCandidate, getProgressPropagationTargets, mergeContinueWatching } from './continueWatching';
import { JellyfinClient } from './jellyfin';
import { ContinueWatchingItem, FamilyMember, LibraryItem, LibraryKind } from './types';

const config = loadConfig();
const jellyfin = new JellyfinClient(config.jellyfinUrl, config.jellyfinApiKey);
const app = express();
const clientDist = path.resolve(process.cwd(), 'dist/client');
const jellyfinDebugEnabled = process.env.JELLYFIN_DEBUG === '1' || process.env.JELLYFIN_DEBUG === 'true';
const activeStreamControllers = new Map<string, AbortController>();

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

function getItemId(req: express.Request): string {
  return Array.isArray(req.params.itemId) ? req.params.itemId[0] : req.params.itemId;
}

function getRangeHeader(req: express.Request): string | undefined {
  return typeof req.headers.range === 'string' ? req.headers.range : undefined;
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
    let items = await jellyfin.listItems(kind, genre);

    if (kidsOnly) {
      items = items.filter(isKidsContent);
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
    let candidates = await jellyfin.listItems(kind, genre);

    if (kidsOnly) {
      candidates = candidates.filter(isKidsContent);
    }

    const items = candidates
      .filter((item) => !watchedUnion.has(item.id) && !excludeIds.has(item.id))
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
    const items = await getContinueWatchingItems(viewers);
    res.json({ items });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Continue watching lookup failed' });
  }
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

    if (!Number.isFinite(playbackPositionTicks) || playbackPositionTicks <= 0) {
      res.status(400).json({ error: 'Playback position must be a positive number of ticks' });
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

app.get('/api/items/:itemId/stream', requireAuth, requireViewerGroup, async (req, res) => {
  const itemId = getItemId(req);
  const streamKey = `${req.sessionID}:${itemId}`;

  const previousController = activeStreamControllers.get(streamKey);
  if (previousController) {
    previousController.abort();
    if (jellyfinDebugEnabled) {
      console.log(`[stream] xx item=${itemId} replaced by newer request`);
    }
  }

  const abortController = new AbortController();
  let upstreamAborted = false;
  activeStreamControllers.set(streamKey, abortController);

  const abortUpstream = () => {
    if (upstreamAborted) {
      return;
    }

    upstreamAborted = true;
    abortController.abort();
    if (activeStreamControllers.get(streamKey) === abortController) {
      activeStreamControllers.delete(streamKey);
    }
  };

  req.on('aborted', abortUpstream);
  res.on('close', abortUpstream);

  try {
    if (jellyfinDebugEnabled) {
      console.log(`[stream] -> item=${itemId} range=${getRangeHeader(req) ?? 'full'}`);
    }

    const upstream = await jellyfin.fetchMovieStream(itemId, getRangeHeader(req), abortController.signal);
    if (!upstream.ok && upstream.status !== 206) {
      const body = await upstream.text();
      res.status(upstream.status).json({ error: body.slice(0, 200) });
      return;
    }

    res.status(upstream.status);
    const headerNames = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    headerNames.forEach((name) => {
      const value = upstream.headers.get(name);
      if (value) {
        res.setHeader(name, value);
      }
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    const stream = Readable.fromWeb(upstream.body as globalThis.ReadableStream<Uint8Array>);

    stream.on('error', (error) => {
      if (!res.headersSent) {
        res.status(502).json({ error: error instanceof Error ? error.message : 'Could not open stream' });
        return;
      }

      res.destroy(error instanceof Error ? error : undefined);
    });

    stream.on('close', abortUpstream);
    res.on('finish', () => {
      upstreamAborted = true;
      if (activeStreamControllers.get(streamKey) === abortController) {
        activeStreamControllers.delete(streamKey);
      }
      if (jellyfinDebugEnabled) {
        console.log(`[stream] <- item=${itemId} status=${upstream.status}`);
      }
    });

    stream.pipe(res);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      if (jellyfinDebugEnabled) {
        console.log(`[stream] xx item=${itemId} aborted`);
      }
      return;
    }

    res.status(502).json({ error: error instanceof Error ? error.message : 'Could not open stream' });
  } finally {
    req.off('aborted', abortUpstream);
    res.off('close', abortUpstream);
    if (activeStreamControllers.get(streamKey) === abortController && upstreamAborted) {
      activeStreamControllers.delete(streamKey);
    }
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

void (async () => {
  try {
    const jellyfinUsers = await jellyfin.fetchUsers();
    const householdIds = new Set(config.groups.flatMap((group) => group.memberIds));
    config.viewers = jellyfinUsers.filter((user) => householdIds.has(user.id));
  } catch (err) {
    console.error('[startup] Failed to load viewers from Jellyfin:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  app.listen(config.port, () => {
    console.log(`Gogglebox listening on http://localhost:${config.port}`);
  });
})();
