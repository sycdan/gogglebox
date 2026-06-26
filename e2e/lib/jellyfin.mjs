// Minimal Jellyfin REST helper for proof flows that need to seed their own
// fixture data (so a proof is self-contained instead of depending on whatever
// happens to be in the test server). It mirrors the exact endpoints the app
// server uses in src/server/jellyfin.ts:
//
//   GET  /Users                                          -> list users
//   GET  /Items?ParentId=<series>&IncludeItemTypes=Episode (sorted air order)
//   POST /Users/<userId>/Items/<itemId>/UserData         -> set PlaybackPositionTicks
//   POST /Users/<userId>/PlayedItems/<itemId>            -> mark played
//   DELETE /Users/<userId>/PlayedItems/<itemId>          -> mark unplayed
//
// Auth uses the api_key query param + X-Emby-Token header, same as the server.

const TICKS_PER_MINUTE = 60 * 10_000_000;

export function makeJellyfin(rawUrl, apiKey) {
  const baseUrl = (rawUrl ?? '').trim().replace(/\/$/, '');
  if (!baseUrl || !apiKey) {
    throw new Error('JELLYFIN_URL / JELLYFIN_API_KEY not set in the proof environment');
  }

  async function request(pathname, { method = 'GET', query = {}, body } = {}) {
    const url = new URL(pathname, baseUrl);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    url.searchParams.set('api_key', apiKey);
    const res = await fetch(url, {
      method,
      headers: {
        'X-Emby-Token': apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Jellyfin ${method} ${pathname} -> ${res.status} ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') ?? '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  return {
    async listUsers() {
      const data = await request('/Users');
      return (Array.isArray(data) ? data : []).map((u) => ({ id: u.Id, name: u.Name }));
    },

    // Series with episodes, recursive, so we can pick a mid-series episode.
    async listSeries(limit = 40) {
      const data = await request('/Items', {
        query: {
          Recursive: 'true',
          IncludeItemTypes: 'Series',
          SortBy: 'SortName',
          SortOrder: 'Ascending',
          Limit: limit,
        },
      });
      return (data?.Items ?? []).map((s) => ({ id: s.Id, name: s.Name }));
    },

    // Movies, recursive, with runtime so we can set a partial position.
    async listMovies(limit = 40) {
      const data = await request('/Items', {
        query: {
          Recursive: 'true',
          IncludeItemTypes: 'Movie',
          SortBy: 'SortName',
          SortOrder: 'Ascending',
          Fields: 'RunTimeTicks',
          Limit: limit,
        },
      });
      return (data?.Items ?? []).map((m) => ({
        id: m.Id,
        name: m.Name,
        runtimeTicks: typeof m.RunTimeTicks === 'number' ? m.RunTimeTicks : 0,
      }));
    },

    // Episodes of a series in SxxExx (season/episode index) order. This MUST
    // match the order the app's anchor uses (listSeriesEpisodesPlayedState sorts
    // by ParentIndexNumber,IndexNumber). Production-order shows diverge between
    // premiere-date order and index order; staging the seed by premiere date
    // would put a viewer on the wrong (e.g. latest SxxExx) episode and make the
    // fixture's expectations disagree with the app.
    async listEpisodes(seriesId) {
      const data = await request('/Items', {
        query: {
          Recursive: 'true',
          ParentId: seriesId,
          SortBy: 'ParentIndexNumber,IndexNumber',
          SortOrder: 'Ascending',
          IncludeItemTypes: 'Episode',
          Fields: 'RunTimeTicks,ParentIndexNumber,IndexNumber,SeriesId,SeriesName',
          Limit: '1000',
        },
      });
      return (data?.Items ?? [])
        // Defensive client-side sort so order is index-based regardless of server.
        .slice()
        .sort((a, b) =>
          ((a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0))
          || ((a.IndexNumber ?? 0) - (b.IndexNumber ?? 0)))
        .map((e) => ({
        id: e.Id,
        name: e.Name,
        seriesId: e.SeriesId ?? seriesId,
        seriesName: e.SeriesName ?? '',
        seasonNumber: typeof e.ParentIndexNumber === 'number' ? e.ParentIndexNumber : null,
        episodeNumber: typeof e.IndexNumber === 'number' ? e.IndexNumber : null,
        runtimeTicks: typeof e.RunTimeTicks === 'number' ? e.RunTimeTicks : 0,
      }));
    },

    // Mark an item played for a user (POST), same as server markPlayed.
    async markPlayed(userId, itemId) {
      await request(`/Users/${userId}/PlayedItems/${itemId}`, { method: 'POST' });
    },

    // Mark unplayed (DELETE), same as server markUnplayed.
    async markUnplayed(userId, itemId) {
      await request(`/Users/${userId}/PlayedItems/${itemId}`, { method: 'DELETE' });
    },

    // Set a partial playback position so the item surfaces on /Items/Resume.
    // Mirrors server setPlaybackPosition: POST UserData { PlaybackPositionTicks, Played:false }.
    async setPlaybackPosition(userId, itemId, ticks) {
      await request(`/Users/${userId}/Items/${itemId}/UserData`, {
        method: 'POST',
        body: { PlaybackPositionTicks: Math.max(0, Math.floor(ticks)), Played: false },
      });
    },

    // Every Movie + Episode id in the library, used by the deterministic reset to
    // zero out playback positions (PlayedItems clears Played, but a leftover
    // PlaybackPositionTicks would still surface an item on /Items/Resume).
    async listAllPlayableIds() {
      const data = await request('/Items', {
        query: {
          Recursive: 'true',
          IncludeItemTypes: 'Movie,Episode',
          Limit: 10000,
        },
      });
      return (data?.Items ?? []).map((i) => i.Id);
    },

    // Clear EVERY played item for a user in one call (no per-item loop). Returns
    // the sandbox user to a clean played-state slate fast, no rescan needed.
    async clearPlayedItems(userId) {
      await request(`/Users/${userId}/PlayedItems`, { method: 'DELETE' });
    },

    // DETERMINISTIC RESET: return ALL users to a clean played-state slate.
    //   - clear every user's PlayedItems (Played flags), and
    //   - zero every Movie/Episode PlaybackPositionTicks (resume positions).
    // Immutable library/users/key persist; only mutable played-state resets. The
    // model for flows is: reset() -> seed fixture -> assert.
    async resetAllPlayedState(log = () => {}) {
      const users = await this.listUsers();
      const itemIds = await this.listAllPlayableIds();
      for (const user of users) {
        // Try the bulk clear first; fall back to per-item DELETE if unsupported.
        try {
          await this.clearPlayedItems(user.id);
        } catch {
          for (const id of itemIds) await this.markUnplayed(user.id, id).catch(() => {});
        }
        // Zero any lingering resume positions (PlayedItems doesn't touch these).
        for (const id of itemIds) {
          await this.setPlaybackPosition(user.id, id, 0).catch(() => {});
        }
      }
      log(`[reset] cleared played-state for ${users.length} user(s) across ${itemIds.length} item(s).`);
    },
  };
}

export { TICKS_PER_MINUTE };
