import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import session from 'express-session';

import {
  accountForToken,
  resolvePartyMemberSelection,
  verifyPartyPins,
  visibleViewersForAccount,
} from './accounts';
import { AppState } from './appState';
import { buildEffectiveConfig, loadConfig, readSourceHash, resolveViewers } from './config';
import { CachedEffectiveConfig } from './appState';
import { CURRENT_SCHEMA_VERSION } from './configMigrations';
import {
  ContinueWatchingCandidate,
  getProgressPropagationTargets,
  isIgnored,
  mergeContinueWatching,
} from './continueWatching';
import { derivePartyKey } from './partyKey';
import { buildPartyAlias, resolvePartyForMembers, visiblePartiesForAccount } from './parties';
import { EpisodeItem, JellyfinClient } from './jellyfin';
import {
  createLibraryQualityEvidence,
  rankRecommendationCandidates,
  toRecommendedItems,
} from './recommendationCore';
import {
  AccountV2,
  AppConfig,
  ContinueWatchingItem,
  FamilyMember,
  LibraryItem,
  LibraryKind,
  ViewerWatchedState,
} from './types';
import { computeWatchedFanout } from './watchedFanout';

// An episode row plus each active viewer's watched state for it — the shape
// GET /api/shows/:seriesId/episodes returns so the show detail modal can show
// per-watcher seen/unseen per episode (Show Detail Browser AC3).
export interface EpisodeItemWithWatched extends EpisodeItem {
  viewerWatched: ViewerWatchedState[];
}

const config = loadConfig();
const jellyfin = new JellyfinClient(config.jellyfinUrl, config.jellyfinApiKey);
const appState = new AppState();
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
// validated users/accounts/accessTokens plus the resolved playback/
// recommendation values.
function applyEffectiveConfig(effective: CachedEffectiveConfig): void {
  config.users = effective.users as typeof config.users;
  config.accounts = effective.accounts as typeof config.accounts;
  config.accessTokens = effective.accessTokens;
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

// All live Jellyfin viewers, resolved at startup (name -> Jellyfin viewer).
function allViewers(): FamilyMember[] {
  return Object.values(config.viewersByName);
}

// All live Jellyfin user NAMES, in Jellyfin list order — the universe wildcard
// tiers resolve against.
function allJellyfinNames(): string[] {
  return Object.keys(config.viewersByName);
}

// The account a session is logged in as, or null. Looked up live from config so
// a session can never outlive a removed account.
function accountForSession(req: express.Request): { accountKey: string; account: AccountV2 } | null {
  const accountKey = req.session.accountKey;
  if (!accountKey) {
    return null;
  }
  const account = config.accounts[accountKey];
  return account ? { accountKey, account } : null;
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

function requireViewerParty(
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

// Deterministic, order-independent key for the active viewer party, derived from
// the selected Jellyfin user ids. Same set of people -> same key.
function activePartyKey(req: express.Request): string {
  const jellyfinUserIds = activeViewersForSession(req).map((viewer) => viewer.jellyfinUserId);
  return derivePartyKey(jellyfinUserIds);
}

// The human-readable alias for the active party, or null when no party is
// active. Prefers the stored alias; falls back to a derived alias (member names
// joined " + " in the account's visible-user order) so the UI never shows the
// raw gbx-grp-<hash> name even for parties created before aliases existed.
function activePartyAlias(req: express.Request, account: AccountV2 | null): string | null {
  const members = activeViewersForSession(req);
  if (!account || members.length === 0) {
    return null;
  }
  const partyKey = activePartyKey(req);
  const stored = appState.getPartyAlias(partyKey);
  if (stored) {
    return stored;
  }
  const visible = visibleViewersForAccount(account, config.viewersByName, config.users);
  return buildPartyAlias(members.map((member) => member.id), visible) || null;
}

function ignoreEntriesForSession(req: express.Request) {
  return appState.getIgnoreEntries(activePartyKey(req));
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

// Attach, per episode row (show detail modal), each active viewer's played
// state for that exact episode item. Same live-read-from-Jellyfin approach as
// withViewerWatchedState above, just generalized to EpisodeItem (Show Detail
// Browser AC3 — never edits state, only reads it).
async function withEpisodeViewerWatchedState(
  episodes: EpisodeItem[],
  viewers: FamilyMember[],
): Promise<EpisodeItemWithWatched[]> {
  return Promise.all(
    episodes.map(async (episode) => {
      const viewerWatched: ViewerWatchedState[] = await Promise.all(
        viewers.map(async (viewer) => ({
          viewerId: viewer.id,
          viewerName: viewer.name,
          avatarUrl: viewer.avatarUrl ?? null,
          watched: await jellyfin.getItemPlayedState(viewer.jellyfinUserId, episode.id),
        })),
      );
      return { ...episode, viewerWatched };
    }),
  );
}

// Build the Express app and wire every route onto it. Extracted into a
// function (rather than acting directly on a module-level `app`) so an
// in-process test can construct a fresh app instance from injected
// config/jellyfin/appState — without requiring a live Jellyfin connection or
// running the production startup sequence below. Purely additive: the
// production path (bottom of this module) calls this once with the real
// config/jellyfin/appState, so route registration, middleware order, and
// runtime behavior are unchanged.
export function createApp(
  config: AppConfig,
  jellyfin: JellyfinClient,
  appState: AppState,
): express.Express {
  const app = express();

  function isKidsContent(item: LibraryItem): boolean {
    const rating = item.officialRating?.toUpperCase() ?? '';
    if (['G', 'PG', 'TV-Y', 'TV-Y7'].includes(rating)) {
      return true;
    }

    return item.genres.some((genre) => ['animation', 'family', 'kids'].includes(genre.toLowerCase()));
  }

  // All live Jellyfin viewers, resolved at startup (name -> Jellyfin viewer).
  function allViewers(): FamilyMember[] {
    return Object.values(config.viewersByName);
  }

  // All live Jellyfin user NAMES, in Jellyfin list order — the universe wildcard
  // tiers resolve against.
  function allJellyfinNames(): string[] {
    return Object.keys(config.viewersByName);
  }

  // The account a session is logged in as, or null. Looked up live from config so
  // a session can never outlive a removed account.
  function accountForSession(req: express.Request): { accountKey: string; account: AccountV2 } | null {
    const accountKey = req.session.accountKey;
    if (!accountKey) {
      return null;
    }
    const account = config.accounts[accountKey];
    return account ? { accountKey, account } : null;
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

  function requireViewerParty(
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

  // Deterministic, order-independent key for the active viewer party, derived from
  // the selected Jellyfin user ids. Same set of people -> same key.
  function activePartyKey(req: express.Request): string {
    const jellyfinUserIds = activeViewersForSession(req).map((viewer) => viewer.jellyfinUserId);
    return derivePartyKey(jellyfinUserIds);
  }

  // The human-readable alias for the active party, or null when no party is
  // active. Prefers the stored alias; falls back to a derived alias (member names
  // joined " + " in the account's visible-viewer order) so the UI never shows the
  // raw gbx-grp-<hash> name even for parties created before aliases existed.
  function activePartyAlias(req: express.Request, account: AccountV2 | null): string | null {
    const members = activeViewersForSession(req);
    if (!account || members.length === 0) {
      return null;
    }
    const partyKey = activePartyKey(req);
    const stored = appState.getPartyAlias(partyKey);
    if (stored) {
      return stored;
    }
    const visible = visibleViewersForAccount(account, config.viewersByName, config.users);
    return buildPartyAlias(members.map((member) => member.id), visible) || null;
  }

  function ignoreEntriesForSession(req: express.Request) {
    return appState.getIgnoreEntries(activePartyKey(req));
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

  // Attach, per episode row (show detail modal), each active viewer's played
  // state for that exact episode item. Same live-read-from-Jellyfin approach as
  // withViewerWatchedState above, just generalized to EpisodeItem (Show Detail
  // Browser AC3 — never edits state, only reads it).
  async function withEpisodeViewerWatchedState(
    episodes: EpisodeItem[],
    viewers: FamilyMember[],
  ): Promise<EpisodeItemWithWatched[]> {
    return Promise.all(
      episodes.map(async (episode) => {
        const viewerWatched: ViewerWatchedState[] = await Promise.all(
          viewers.map(async (viewer) => ({
            viewerId: viewer.id,
            viewerName: viewer.name,
            avatarUrl: viewer.avatarUrl ?? null,
            watched: await jellyfin.getItemPlayedState(viewer.jellyfinUserId, episode.id),
          })),
        );
        return { ...episode, viewerWatched };
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
    const auth = req.session.isAuthenticated ? accountForSession(req) : null;
    // Only this account's visible viewers, each carrying its tier for this
    // account — never the global user list, never the configured pins.
    const viewers = auth ? visibleViewersForAccount(auth.account, config.viewersByName, config.users) : [];

    const partyAlias = activePartyAlias(req, auth?.account ?? null);

    res.json({
      authenticated: Boolean(req.session.isAuthenticated && auth),
      // Auto-login is implicit: enabled when the ACCESS_TOKEN env var is set.
      // Field name kept from the portal-credentials era (e2e contract).
      portalAutoLoginEnabled: Boolean(config.envAccessToken),
      appName: config.appName,
      watchedThreshold: config.watchedThreshold,
      account: auth ? auth.accountKey : null,
      viewers,
      activeViewerIds: req.session.activeViewerIds ?? [],
      // The active party's human-readable alias (never the raw gbx-grp-<hash>),
      // or null when no party is active. Surfaced near "Change viewers" in the app.
      activePartyAlias: partyAlias,
      // Pre-rename compatibility field (identical value) for any client still
      // reading the old name. Never diverges from activePartyAlias above.
      activeGroupAlias: partyAlias,
    });
  });

  app.post('/api/auth/login', (req, res) => {
    const { token } = req.body as { token?: string };

    // Auto-login: an empty/missing token falls back to the ACCESS_TOKEN env var,
    // which only succeeds if it matches a configured access token.
    const tryToken = typeof token === 'string' && token ? token : config.envAccessToken ?? undefined;

    const match = accountForToken(config.accessTokens, config.accounts, tryToken);
    if (!match) {
      res.status(401).json({ error: 'Invalid access token' });
      return;
    }

    req.session.isAuthenticated = true;
    req.session.accountKey = match.accountKey;
    // A fresh login starts with no active party (visible viewers differ per account).
    req.session.activeViewerIds = [];
    res.json({ ok: true, account: match.accountKey });
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

  // Validate + pin-verify a selected member set against the live config (see
  // resolvePartyMemberSelection for the pure rules). Shared by /api/party,
  // /api/party/verify-pins and /api/player/session (and their /api/group*
  // compatibility aliases) so pin-gating is enforced everywhere a party is minted.
  function resolvePartyMembers(
    account: AccountV2,
    memberIds: string[],
    pins: Record<string, string>,
  ): { ok: true; members: FamilyMember[] } | { ok: false; status: number; error: string } {
    return resolvePartyMemberSelection(account, config.viewersByName, config.users, memberIds, pins);
  }

  // Parse the memberIds array off a party request body (same wire shape at
  // /api/party and /api/party/verify-pins, and their /api/group* aliases).
  function parseMemberIds(body: unknown): string[] {
    const raw = (body as { memberIds?: unknown } | undefined)?.memberIds;
    return Array.isArray(raw)
      ? raw.filter((value: unknown): value is string => typeof value === 'string')
      : [];
  }

  // UX preflight for the continue-time PIN modal: verify the prospective party's
  // membership + pins at the confirm click, WITHOUT activating or persisting
  // anything. Same wire shape and { status, error } verdicts as /api/party,
  // which stays authoritative (this endpoint never replaces its enforcement).
  function handleVerifyPartyPins(req: express.Request, res: express.Response): void {
    const auth = accountForSession(req);
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const resolved = resolvePartyMembers(auth.account, parseMemberIds(req.body), parsePins(req.body));
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }

    res.json({ ok: true });
  }
  app.post('/api/party/verify-pins', requireAuth, handleVerifyPartyPins);
  // Pre-rename compatibility alias — identical behavior.
  app.post('/api/group/verify-pins', requireAuth, handleVerifyPartyPins);

  async function handleCreateParty(req: express.Request, res: express.Response): Promise<void> {
    const auth = accountForSession(req);
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const memberIds = Array.isArray(req.body?.memberIds)
      ? req.body.memberIds.filter((value: unknown): value is string => typeof value === 'string')
      : [];
    const pins = parsePins(req.body);

    const resolved = resolvePartyMembers(auth.account, memberIds, pins);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }

    // Persist the managed party NOW (on Continue), after pin verification. The key
    // is deterministic + order-independent, so an existing combination is reused
    // (never duplicated) and only a brand-new combination mints + persists a party.
    try {
      const memberJellyfinUserIds = resolved.members.map((member) => member.jellyfinUserId);
      const { partyKey, exists } = resolvePartyForMembers(
        memberJellyfinUserIds,
        appState.getPartyPlayerUsers(),
      );
      if (!exists) {
        const userId = await jellyfin.ensurePartyUser(partyKey);
        appState.setPartyPlayerUser(partyKey, userId, memberJellyfinUserIds);
        // Auto-generate + persist a default alias from member names in this
        // account's visible-viewer order (e.g. "Alice + Bob").
        const visible = visibleViewersForAccount(auth.account, config.viewersByName, config.users);
        const alias = buildPartyAlias(resolved.members.map((member) => member.id), visible);
        appState.setPartyAlias(partyKey, alias);
      }
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : 'Could not create party' });
      return;
    }

    req.session.activeViewerIds = resolved.members.map((member) => member.id);
    // The active party cleared pin-gating; the player-session mint can trust it.
    req.session.activePartyPinVerified = true;
    res.json({ ok: true, activeViewerIds: req.session.activeViewerIds });
  }
  app.post('/api/party', requireAuth, handleCreateParty);
  // Pre-rename compatibility alias — identical behavior.
  app.post('/api/group', requireAuth, handleCreateParty);

  // The managed parties VISIBLE to the logged-in account: a party is visible iff
  // ALL its members are within the account's visible users. Aliases (never the raw
  // gbx-grp-<hash> name) are backfilled from member names when not stored.
  function handleListParties(req: express.Request, res: express.Response): void {
    const auth = accountForSession(req);
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const visible = visibleViewersForAccount(auth.account, config.viewersByName, config.users);
    const parties = visiblePartiesForAccount(
      appState.getPartyPlayerUsers(),
      visible,
      appState.getPartyAliases(),
    );
    res.json({
      parties,
      // Pre-rename compatibility field: the same list, shaped with `groupKey`
      // instead of `partyKey`, for any client still reading the old field names.
      groups: parties.map(({ partyKey, ...rest }) => ({ groupKey: partyKey, ...rest })),
    });
  }
  app.get('/api/parties', requireAuth, handleListParties);
  // Pre-rename compatibility alias — identical behavior.
  app.get('/api/groups', requireAuth, handleListParties);

  function handleClearParty(req: express.Request, res: express.Response): void {
    req.session.activeViewerIds = [];
    req.session.activePartyPinVerified = false;
    res.json({ ok: true, activeViewerIds: [] });
  }
  app.post('/api/party/clear', requireAuth, handleClearParty);
  // Pre-rename compatibility alias — identical behavior.
  app.post('/api/group/clear', requireAuth, handleClearParty);

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

  app.get('/api/recommendations', requireAuth, requireViewerParty, async (req, res) => {
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

      candidates = candidates
        .filter((item) => !watchedUnion.has(item.id) && !excludeIds.has(item.id) && !isIgnored(ignoreEntries, item));
      const evidence = createLibraryQualityEvidence(candidates);
      const items = toRecommendedItems(
        rankRecommendationCandidates(candidates, evidence, {
          channelWeights: { 'library-quality': 1 },
          limit: config.recommendations.count,
        }),
      );

      res.json({ items });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : 'Recommendation lookup failed' });
    }
  });

  app.get('/api/continue-watching', requireAuth, requireViewerParty, async (req, res) => {
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

  app.get('/api/ignored', requireAuth, requireViewerParty, (req, res) => {
    const items = appState.getIgnoreEntries(activePartyKey(req));
    res.json({ items });
  });

  // Ignore a card at the given scope. Body: { key, matchSeriesId, label }.
  // `key` is the exact id to match (episode id for scope 'episode', series id for
  // scope 'show', movie id for scope 'movie'); `matchSeriesId` is true only for
  // whole-show scope. `label` is the display string captured at ignore-time from
  // the card itself, so the ignored panel never needs a separate name lookup.
  app.post('/api/ignored', requireAuth, requireViewerParty, (req, res) => {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    const matchSeriesId = Boolean(req.body?.matchSeriesId);
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';

    if (!key) {
      res.status(400).json({ error: 'key is required' });
      return;
    }

    const items = appState.ignoreItem(activePartyKey(req), { key, matchSeriesId, label: label || key });
    res.json({ items });
  });

  app.delete('/api/ignored/:key', requireAuth, requireViewerParty, (req, res) => {
    const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
    const items = appState.unignoreItem(activePartyKey(req), key);
    res.json({ items });
  });

  // The show detail modal's episode list: every episode of one series
  // (grouped/filtered by season client-side), each carrying every active
  // viewer's watched state (AC3). An optional `q` scopes a keyword search to
  // THIS series only (AC4) — jellyfin.listEpisodes always sets ParentId, so a
  // keyword search here can never surface another show's episodes and is not a
  // general/global search endpoint.
  app.get('/api/shows/:seriesId/episodes', requireAuth, requireViewerParty, async (req, res) => {
    try {
      const seriesId = Array.isArray(req.params.seriesId) ? req.params.seriesId[0] : req.params.seriesId;
      const searchTerm = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : undefined;
      const viewers = activeViewersForSession(req);
      const episodes = await jellyfin.listEpisodes(seriesId, searchTerm);
      const items = await withEpisodeViewerWatchedState(episodes, viewers);
      res.json({ items });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : 'Could not load episodes' });
    }
  });

  app.post('/api/items/:itemId/watched', requireAuth, requireViewerParty, async (req, res) => {
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
  // episode/movie). The viewer must be in the active party. State lives in
  // Jellyfin; we return the new value so the client can reconcile.
  app.post('/api/items/:itemId/viewer-watched', requireAuth, requireViewerParty, async (req, res) => {
    try {
      const viewerId = typeof req.body?.viewerId === 'string' ? req.body.viewerId : '';
      const watched = Boolean(req.body?.watched);
      const viewer = activeViewersForSession(req).find((candidate) => candidate.id === viewerId);

      if (!viewer) {
        res.status(400).json({ error: 'Viewer must be in the active party' });
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

  app.post('/api/items/:itemId/progress/sync', requireAuth, requireViewerParty, async (req, res) => {
    try {
      const sourceViewerId = typeof req.body?.sourceViewerId === 'string' ? req.body.sourceViewerId : '';
      const playbackPositionTicks = Number(req.body?.playbackPositionTicks);
      const viewers = activeViewersForSession(req);
      const sourceViewer = viewers.find((viewer) => viewer.id === sourceViewerId);

      if (!sourceViewer) {
        res.status(400).json({ error: 'Source viewer must be in the active party' });
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

  app.delete('/api/items/:itemId/watched', requireAuth, requireViewerParty, async (req, res) => {
    try {
      const viewers = activeViewersForSession(req);
      const itemId = getItemId(req);
      await Promise.all(viewers.map((viewer) => jellyfin.markUnplayed(viewer.jellyfinUserId, itemId)));
      res.status(204).end();
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : 'Could not clear watch state' });
    }
  });

  // Stage A: mint a fresh Jellyfin playback session for the active party's
  // gbx-owned JF user, so the client can seed Jellyfin-web's localStorage and
  // auto-login in the /player tab. The active party id is the deterministic,
  // order-independent key derived from the active viewers' Jellyfin user ids
  // (activePartyKey / derivePartyKey) — same set of people -> same JF user. We
  // rotate a random password on every mint and persist only the party->userId
  // mapping (never the password).
  app.post('/api/player/session', requireAuth, requireViewerParty, async (req, res) => {
    try {
      // Defense in depth: never mint a party player user for a party that hasn't
      // cleared pin-gating. The party is normally verified at /api/party, but a
      // direct mint must re-prove any required pins (accepting pins in the body).
      const auth = accountForSession(req);
      if (!auth) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }
      if (!req.session.activePartyPinVerified) {
        const pinCheck = verifyPartyPins(
          auth.account,
          config.users,
          allJellyfinNames(),
          activeViewersForSession(req),
          parsePins(req.body),
        );
        if (!pinCheck.ok) {
          res.status(403).json({ error: pinCheck.error });
          return;
        }
        req.session.activePartyPinVerified = true;
      }

      const partyKey = activePartyKey(req);
      const userId = await jellyfin.ensurePartyUser(partyKey);
      // Stage B: persist the party player user id AND the member ids (the active
      // viewers' Jellyfin user ids) so the watched fan-out poller can map this
      // player user's sessions back to the individual members to mark played.
      const memberIds = activeViewersForSession(req).map((viewer) => viewer.jellyfinUserId);
      appState.setPartyPlayerUser(partyKey, userId, memberIds);

      const deviceId = crypto.randomUUID();
      const token = await jellyfin.rotatePasswordAndAuthenticate(
        userId,
        jellyfin.partyUserName(partyKey),
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

  app.get('/api/items/:itemId/playback-url', requireAuth, requireViewerParty, (req, res) => {
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

  app.get('/api/items/:itemId/playback-progress', requireAuth, requireViewerParty, async (req, res) => {
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

  return app;
}

const app = createApp(config, jellyfin, appState);

// ── Stage B: watched fan-out poller ────────────────────────────────────────
//
// A single server-side interval polls Jellyfin's active sessions. When a PARTY
// PLAYER user (minted by POST /api/player/session) crosses the watched threshold
// on the item it's playing, gbx marks that item Played for every INDIVIDUAL
// member id of the party. The decision logic is the pure computeWatchedFanout;
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
    // Map each party player jellyfinUserId -> the member ids to fan out to.
    const players = appState.getPartyPlayerUsers();
    const playerUserMembers = new Map<string, string[]>();
    for (const { jellyfinUserId, memberIds } of Object.values(players)) {
      if (jellyfinUserId && memberIds.length > 0) {
        playerUserMembers.set(jellyfinUserId, memberIds);
      }
    }
    if (playerUserMembers.size === 0) {
      // No minted party players yet (or none with members) — nothing to poll.
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

// Only run the production startup sequence (live Jellyfin fetch + listen)
// when this module is the process entrypoint (`npm start`/`dev:server`/the
// Docker CMD all run server.ts[/.js] directly) — never when it's imported as
// a library, e.g. by an in-process HTTP-route-level test that only needs
// createApp(). Purely additive: for every existing production invocation
// this is always true, so startup order/behavior is unchanged.
const isEntryPoint = require.main === module;

if (isEntryPoint) {
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
      if (effective && appState.isEffectiveConfigFresh(sourceHash, packageVersion, CURRENT_SCHEMA_VERSION)) {
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

      // Keep the name -> Jellyfin viewer mapping for ALL live Jellyfin users in
      // the app's own (writable) in-memory state — v2 wildcard tiers can include
      // users that never appear in users[].
      config.viewersByName = resolveViewers(jellyfinUsers);
    } catch (err) {
      console.error('[startup] Failed to build config from Jellyfin:', err instanceof Error ? err.message : err);
      process.exit(1);
    }

    startWatchedFanoutPoller();

    app.listen(config.port, () => {
      console.log(`Gogglebox listening on http://localhost:${config.port}`);
    });
  })();
}
