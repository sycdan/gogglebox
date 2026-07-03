import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import session from 'express-session';

import {
  authenticateAccount,
  verifyGroupPins,
  visibleViewersForAccount,
} from './accounts';
import { AppState } from './appState';
import { buildEffectiveConfig, loadConfig, readSourceHash, resolveViewers } from './config';
import { CachedEffectiveConfig } from './appState';
import {
  ContinueWatchingCandidate,
  getProgressPropagationTargets,
  isIgnored,
  mergeContinueWatching,
} from './continueWatching';
import { deriveGroupKey } from './groupKey';
import { buildGroupAlias, resolveGroupForMembers, visibleGroupsForAccount } from './groups';
import { JellyfinClient } from './jellyfin';
import { ConfigAccount, ContinueWatchingItem, FamilyMember, LibraryItem, LibraryKind, ViewerWatchedState } from './types';
import { computeWatchedFanout } from './watchedFanout';

const config = loadConfig();
const jellyfin = new JellyfinClient(config.jellyfinUrl, config.jellyfinApiKey);
const appState = new AppState();
const app = express();
const clientDist = path.resolve(process.cwd(), 'dist/client');
const jellyfinDebugEnabled = process.env.JELLYFIN_DEBUG === '1' || process.env.JELLYFIN_DEBUG === 'true';

// The running image's package version. Stamped onto the cached effective config
// so a new/rolled-back image (whose migrations may differ) re-derives it.
function readPackageVersion(): string {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Apply a derived/cached effective config to the live config object: the
// validated users/accounts plus the resolved playback/recommendation values.
function applyEffectiveConfig(effective: CachedEffectiveConfig): void {
  config.users = effective.users as typeof config.users;
  config.accounts = effective.accounts as typeof config.accounts;
  config.watchedThreshold = effective.watchedThreshold;
  config.recommendations = { count: effective.recommendationCount };
}

function isKidsContent(item: LibraryItem): boolean {
  const rating = item.officialRating?.toUpperCase() ?? '';
  if (['G', 'PG', 'TV-Y', 'TV-Y7'].includes(rating)) {
    return true;
  }

  return item.genres.some((genre) => ['animation', 'family', 'kids'].includes(genre.toLowerCase()));
}

// All configured viewers, resolved at startup (name -> Jellyfin viewer).
function allViewers(): FamilyMember[] {
  return Object.values(config.viewersByName);
}

// The account a session is logged in as, or null. Looked up live from config so
// a session can never outlive a removed account.
function accountForSession(req: express.Request): ConfigAccount | null {
  const username = req.session.accountUsername;
  if (!username) {
    return null;
  }
  return config.accounts.find((account) => account.username === username) ?? null;
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
  return allViewers().filter((viewer) => req.session.activeViewerIds?.includes(viewer.id));
}

// Deterministic, order-independent key for the active viewer group, derived from
// the selected Jellyfin user ids. Same set of people -> same key.
function activeGroupKey(req: express.Request): string {
  const jellyfinUserIds = activeViewersForSession(req).map((viewer) => viewer.jellyfinUserId);
  return deriveGroupKey(jellyfinUserIds);
}

// The human-readable alias for the active group, or null when no group is
// active. Prefers the stored alias; falls back to a derived alias (member names
// joined " + " in the account's visible-user order) so the UI never shows the
// raw gbx-grp-<hash> name even for groups created before aliases existed.
function activeGroupAlias(req: express.Request, account: ConfigAccount | null): string | null {
  const members = activeViewersForSession(req);
  if (!account || members.length === 0) {
    return null;
  }
  const groupKey = activeGroupKey(req);
  const stored = appState.getGroupAlias(groupKey);
  if (stored) {
    return stored;
  }
  const visible = visibleViewersForAccount(account, config.viewersByName);
  return buildGroupAlias(members.map((member) => member.id), visible) || null;
}

function ignoreEntriesForSession(req: express.Request) {
  return appState.getIgnoreEntries(activeGroupKey(req));
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

// Each active viewer's own Resume/NextUp candidates, fanned out (not collapsed
// per series) so an anthology-style show can show one card per distinct
// episode any viewer is currently on. Jellyfin's own Resume/NextUp for a
// viewer already reflects that viewer's live played-state, so a card advances
// simply by refetching after a watched-state change — there is no separate
// "advance the merged card" step.
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
  const account = req.session.isAuthenticated ? accountForSession(req) : null;
  // Only this account's visible users, each carrying its pin_required flag for
  // this account — never the global user list, never the configured pins.
  const viewers = account ? visibleViewersForAccount(account, config.viewersByName) : [];

  res.json({
    authenticated: Boolean(req.session.isAuthenticated && account),
    // Auto-login is implicit: enabled when PORTAL_USERNAME/PORTAL_PASSWORD are set.
    portalAutoLoginEnabled: Boolean(config.portalCredentials),
    appName: config.appName,
    watchedThreshold: config.watchedThreshold,
    account: account ? account.username : null,
    viewers,
    activeViewerIds: req.session.activeViewerIds ?? [],
    // The active group's human-readable alias (never the raw gbx-grp-<hash>),
    // or null when no group is active. Surfaced near "Change viewers" in the app.
    activeGroupAlias: activeGroupAlias(req, account),
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };

  // Auto-login: an empty body falls back to PORTAL_USERNAME/PORTAL_PASSWORD,
  // which only succeeds if those env creds match an accounts[] entry.
  const tryUsername = username ?? config.portalCredentials?.username;
  const tryPassword = password ?? config.portalCredentials?.password;

  const account = authenticateAccount(config.accounts, tryUsername, tryPassword);
  if (!account) {
    res.status(401).json({ error: 'Invalid account credentials' });
    return;
  }

  req.session.isAuthenticated = true;
  req.session.accountUsername = account.username;
  // A fresh login starts with no active group (visible users differ per account).
  req.session.activeViewerIds = [];
  res.json({ ok: true, account: account.username });
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

// Parse a { pins: { [jellyfinUserId]: pin } } map from a request body.
function parsePins(body: unknown): Record<string, string> {
  const raw = (body as { pins?: unknown } | undefined)?.pins;
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

// Validate that a set of selected member ids is well-formed and visible to the
// account, then verify any required pins. Returns the resolved member viewers on
// success, or a { status, error } the caller should send. Shared by /api/group
// and /api/player/session so pin-gating is enforced everywhere a group is minted.
function resolveGroupMembers(
  account: ConfigAccount,
  memberIds: string[],
  pins: Record<string, string>,
): { ok: true; members: FamilyMember[] } | { ok: false; status: number; error: string } {
  if (!memberIds.length) {
    return { ok: false, status: 400, error: 'Choose at least one viewer' };
  }

  // Members must be among THIS account's visible users.
  const visible = visibleViewersForAccount(account, config.viewersByName);
  const visibleById = new Map(visible.map((viewer) => [viewer.id, viewer]));
  const members: FamilyMember[] = [];
  for (const memberId of memberIds) {
    const viewer = visibleById.get(memberId);
    if (!viewer) {
      return { ok: false, status: 400, error: `Unknown or not-visible viewer: ${memberId}` };
    }
    members.push(viewer);
  }

  const pinCheck = verifyGroupPins(account, config.users, members, pins);
  if (!pinCheck.ok) {
    // Never activate a group with a wrong/missing required pin.
    return { ok: false, status: 403, error: pinCheck.error };
  }

  return { ok: true, members };
}

app.post('/api/group', requireAuth, async (req, res) => {
  const account = accountForSession(req);
  if (!account) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const memberIds = Array.isArray(req.body?.memberIds)
    ? req.body.memberIds.filter((value: unknown): value is string => typeof value === 'string')
    : [];
  const pins = parsePins(req.body);

  const resolved = resolveGroupMembers(account, memberIds, pins);
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error });
    return;
  }

  // Persist the managed group NOW (on Continue), after pin verification. The key
  // is deterministic + order-independent, so an existing combination is reused
  // (never duplicated) and only a brand-new combination mints + persists a group.
  try {
    const memberJellyfinUserIds = resolved.members.map((member) => member.jellyfinUserId);
    const { groupKey, exists } = resolveGroupForMembers(
      memberJellyfinUserIds,
      appState.getGroupPlayerUsers(),
    );
    if (!exists) {
      const userId = await jellyfin.ensureGroupUser(groupKey);
      appState.setGroupPlayerUser(groupKey, userId, memberJellyfinUserIds);
      // Auto-generate + persist a default alias from member names in this
      // account's visible-user order (e.g. "Alice + Bob").
      const visible = visibleViewersForAccount(account, config.viewersByName);
      const alias = buildGroupAlias(resolved.members.map((member) => member.id), visible);
      appState.setGroupAlias(groupKey, alias);
    }
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Could not create group' });
    return;
  }

  req.session.activeViewerIds = resolved.members.map((member) => member.id);
  // The active group cleared pin-gating; the player-session mint can trust it.
  req.session.activeGroupPinVerified = true;
  res.json({ ok: true, activeViewerIds: req.session.activeViewerIds });
});

// The managed groups VISIBLE to the logged-in account: a group is visible iff
// ALL its members are within the account's visible users. Aliases (never the raw
// gbx-grp-<hash> name) are backfilled from member names when not stored.
app.get('/api/groups', requireAuth, (req, res) => {
  const account = accountForSession(req);
  if (!account) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const visible = visibleViewersForAccount(account, config.viewersByName);
  const groups = visibleGroupsForAccount(
    appState.getGroupPlayerUsers(),
    visible,
    appState.getGroupAliases(),
  );
  res.json({ groups });
});

app.post('/api/group/clear', requireAuth, (req, res) => {
  req.session.activeViewerIds = [];
  req.session.activeGroupPinVerified = false;
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
      const ignoreEntries = ignoreEntriesForSession(req);
      items = items.filter((item) => !isIgnored(ignoreEntries, item));
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
    const ignoreEntries = ignoreEntriesForSession(req);
    let candidates = await jellyfin.listItems(kind, genre);

    if (kidsOnly) {
      candidates = candidates.filter(isKidsContent);
    }

    const items = candidates
      .filter((item) => !watchedUnion.has(item.id) && !excludeIds.has(item.id) && !isIgnored(ignoreEntries, item))
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
    const ignoreEntries = ignoreEntriesForSession(req);
    const merged = await getContinueWatchingItems(viewers);
    const visible = merged.filter((item) => !isIgnored(ignoreEntries, item));
    if (jellyfinDebugEnabled) {
      for (const item of visible) {
        console.log(
          `[continue-watching] card type=${item.type} id=${item.id} name=${JSON.stringify(item.name)} ` +
          `seriesId=${JSON.stringify(item.seriesId)} season=${item.seasonNumber} episode=${item.episodeNumber} ` +
          `progress=${item.progressPercent} sourceViewer=${item.sourceViewerName}`,
        );
      }
    }
    const items = await withViewerWatchedState(visible, viewers);
    res.json({ items });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Continue watching lookup failed' });
  }
});

app.get('/api/ignored', requireAuth, requireViewerGroup, (req, res) => {
  const items = appState.getIgnoreEntries(activeGroupKey(req));
  res.json({ items });
});

// Ignore a card at the given scope. Body: { key, matchSeriesId, label }.
// `key` is the exact id to match (episode id for scope 'episode', series id for
// scope 'show', movie id for scope 'movie'); `matchSeriesId` is true only for
// whole-show scope. `label` is the display string captured at ignore-time from
// the card itself, so the ignored panel never needs a separate name lookup.
app.post('/api/ignored', requireAuth, requireViewerGroup, (req, res) => {
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  const matchSeriesId = Boolean(req.body?.matchSeriesId);
  const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';

  if (!key) {
    res.status(400).json({ error: 'key is required' });
    return;
  }

  const items = appState.ignoreItem(activeGroupKey(req), { key, matchSeriesId, label: label || key });
  res.json({ items });
});

app.delete('/api/ignored/:key', requireAuth, requireViewerGroup, (req, res) => {
  const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
  const items = appState.unignoreItem(activeGroupKey(req), key);
  res.json({ items });
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
    // Defense in depth: never mint a group player user for a group that hasn't
    // cleared pin-gating. The group is normally verified at /api/group, but a
    // direct mint must re-prove any required pins (accepting pins in the body).
    const account = accountForSession(req);
    if (!account) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!req.session.activeGroupPinVerified) {
      const pinCheck = verifyGroupPins(
        account,
        config.users,
        activeViewersForSession(req),
        parsePins(req.body),
      );
      if (!pinCheck.ok) {
        res.status(403).json({ error: pinCheck.error });
        return;
      }
      req.session.activeGroupPinVerified = true;
    }

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
    // Build (or reuse) the EFFECTIVE config: the read-only config.json is a source
    // of overrides that we migrate forward, seed from the bundled example, validate
    // (skip+warn), and cache in /data with provenance. We re-derive only when the
    // source file changed (sourceHash) OR the running image version changed
    // (builtForPackage) — otherwise reuse the cached effective config.
    const jellyfinUsers = await jellyfin.fetchUsers();
    const packageVersion = readPackageVersion();
    const sourceHash = readSourceHash();

    let effective = appState.getEffectiveConfig();
    if (effective && appState.isEffectiveConfigFresh(sourceHash, packageVersion)) {
      console.log('[startup] reusing cached effective config (source + image unchanged).');
    } else {
      const built = buildEffectiveConfig({ jellyfinUsers }, packageVersion);
      appState.setEffectiveConfig(built);
      effective = built;
      console.log(
        `[startup] derived effective config (schemaVersion ${built.schemaVersion}, ` +
        `package ${built.builtForPackage}); cached to /data.`,
      );
    }

    applyEffectiveConfig(effective);

    // Resolve configured user NAMES -> Jellyfin ids and keep the mapping in the
    // app's own (writable) in-memory state. Unresolvable names were already
    // dropped during the effective-config build, so this resolves cleanly.
    config.viewersByName = resolveViewers(config.users, jellyfinUsers);
  } catch (err) {
    console.error('[startup] Failed to build config from Jellyfin:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  startWatchedFanoutPoller();

  app.listen(config.port, () => {
    console.log(`Gogglebox listening on http://localhost:${config.port}`);
  });
})();
