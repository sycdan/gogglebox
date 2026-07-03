import assert from 'node:assert/strict';
import test from 'node:test';

import { JellyfinClient } from './jellyfin';

test('listItems sends movie auth header and maps playable movies', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ input: String(input), init });

    return new Response(
      JSON.stringify({
        Items: [
          {
            Id: 'm1',
            Name: 'Movie One',
            Type: 'Movie',
            Genres: ['Drama'],
            ImageTags: { Primary: 'tag1' },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    const items = await client.listItems('movie');

    assert.equal(items.length, 1);
    assert.equal(items[0].playable, true);
    assert.equal(items[0].id, 'm1');

    assert.equal(calls.length, 1);
    assert.match(calls[0].input, /\/Items\?/);
    assert.equal((calls[0].init?.headers as Record<string, string>)['X-Emby-Token'], 'abc123');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getWatchedItemIds uses movie-only filter for movie mode', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | string) => {
    calls.push(String(input));

    return new Response(JSON.stringify({ Items: [{ Id: 'm1', Name: 'Movie One', Type: 'Movie' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    const watched = await client.getWatchedItemIds('user1', 'movie');

    assert.equal(watched.has('m1'), true);
    assert.equal(calls.length, 1);

    const url = new URL(calls[0]);
    assert.equal(url.searchParams.get('IncludeItemTypes'), 'Movie');
    assert.equal(url.searchParams.has('Fields'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getWatchedItemIds adds series ids in show mode', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | string) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('IncludeItemTypes'), 'Series,Episode');

    return new Response(
      JSON.stringify({
        Items: [
          { Id: 'episode1', Name: 'Ep 1', Type: 'Episode', SeriesId: 'series1' },
          { Id: 'series1', Name: 'Series 1', Type: 'Series' },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    const watched = await client.getWatchedItemIds('user1', 'show');

    assert.equal(watched.has('episode1'), true);
    assert.equal(watched.has('series1'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('markPlayed and markUnplayed call expected verbs', async () => {
  const calls: Array<{ input: string; method: string }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ input: String(input), method: String(init?.method ?? 'GET') });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    await client.markPlayed('user1', 'item1');
    await client.markUnplayed('user1', 'item1');

    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[1].method, 'DELETE');
    assert.match(calls[0].input, /\/Users\/user1\/PlayedItems\/item1/);
    assert.match(calls[1].input, /\/Users\/user1\/PlayedItems\/item1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('buildPlaybackUrl returns an origin-relative web player path with autoplay', () => {
  // No base path -> path starts at /web/index.html (origin-relative, no host).
  const client = new JellyfinClient('https://example.com', 'abc123');
  const raw = client.buildPlaybackUrl('item1');

  assert.equal(raw.startsWith('/web/index.html#/details?'), true);

  const url = new URL(raw, 'http://localhost:8080');
  assert.equal(url.origin, 'http://localhost:8080');
  assert.equal(url.pathname, '/web/index.html');

  const hashParams = new URLSearchParams(url.hash.replace(/^#\/details\?/, ''));
  assert.equal(hashParams.get('id'), 'item1');
  assert.equal(hashParams.get('autoplay'), 'true');
  assert.equal(hashParams.has('startPositionTicks'), false);
  assert.equal(hashParams.has('startTimeTicks'), false);
});

test('buildPlaybackUrl preserves a configured Jellyfin base path origin-relative', () => {
  const client = new JellyfinClient('http://jellyfin.example.test/jf', 'abc123');
  const raw = client.buildPlaybackUrl('item1');

  assert.equal(raw.startsWith('/jf/web/index.html#/details?'), true);

  const url = new URL(raw, 'http://localhost:8080');
  assert.equal(url.pathname, '/jf/web/index.html');
});

test('buildPlaybackUrl includes start ticks when provided', () => {
  const client = new JellyfinClient('https://example.com', 'abc123');
  const url = new URL(client.buildPlaybackUrl('item1', 25_000_000), 'http://localhost:8080');
  const hashParams = new URLSearchParams(url.hash.replace(/^#\/details\?/, ''));

  assert.equal(hashParams.get('startPositionTicks'), '25000000');
  assert.equal(hashParams.get('startTimeTicks'), '25000000');
});

test('request preserves a configured base path on API calls', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | string) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ Items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    // No base path: /Items resolves directly under the host.
    const noPath = new JellyfinClient('http://host:8096', 'abc123');
    await noPath.listItems('movie');
    const noPathUrl = new URL(calls[0]);
    assert.equal(noPathUrl.pathname, '/Items');

    // Configured base path: the base path MUST be preserved on the REST call.
    const withPath = new JellyfinClient('http://host:8096/jf', 'abc123');
    await withPath.listItems('movie');
    const withPathUrl = new URL(calls[1]);
    assert.equal(withPathUrl.pathname, '/jf/Items');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ensureGroupUser reuses an existing group user and creates one when missing', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string }> = [];

  // First scenario: user already exists -> no creation call.
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), method: String(init?.method ?? 'GET'), body: init?.body as string });
    return new Response(
      JSON.stringify([{ Id: 'existing-id', Name: 'gbx-grp-group1' }]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('http://host:8096', 'abc123');
    const id = await client.ensureGroupUser('group1');
    assert.equal(id, 'existing-id');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/Users$/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Second scenario: user missing -> POST /Users/New then POST policy.
  calls.length = 0;
  let step = 0;
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), method: String(init?.method ?? 'GET'), body: init?.body as string });
    step += 1;
    if (step === 1) {
      // /Users list (empty)
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (step === 2) {
      // /Users/New
      return new Response(JSON.stringify({ Id: 'new-id', Name: 'gbx-grp-group2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // /Users/new-id/Policy
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('http://host:8096', 'abc123');
    const id = await client.ensureGroupUser('group2');
    assert.equal(id, 'new-id');
    assert.equal(calls.length, 3);
    assert.match(calls[1].url, /\/Users\/New$/);
    assert.equal(calls[1].method, 'POST');
    assert.match(String(calls[1].body), /gbx-grp-group2/);
    assert.match(calls[2].url, /\/Users\/new-id\/Policy$/);
    // JF 10.9.11 requires the provider ids on the policy update or the cold
    // create path 400s on the first mint ("PasswordResetProviderId required").
    const policyBody = JSON.parse(String(calls[2].body));
    assert.equal(
      policyBody.AuthenticationProviderId,
      'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
    );
    assert.equal(
      policyBody.PasswordResetProviderId,
      'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rotatePasswordAndAuthenticate resets+sets password then authenticates', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers?: Record<string, string>; body?: string }> = [];

  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? 'GET'),
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body as string,
    });
    if (String(input).endsWith('/Users/AuthenticateByName')) {
      return new Response(
        JSON.stringify({ AccessToken: 'tok-1', ServerId: 'srv-1', User: { Id: 'user-1' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('http://host:8096', 'abc123');
    const result = await client.rotatePasswordAndAuthenticate('user-1', 'gbx-grp-group1', 'device-abc');

    assert.deepEqual(result, { accessToken: 'tok-1', userId: 'user-1', serverId: 'srv-1' });
    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /\/Users\/user-1\/Password$/);
    assert.match(String(calls[0].body), /ResetPassword/);
    assert.match(calls[1].url, /\/Users\/user-1\/Password$/);
    assert.match(String(calls[1].body), /NewPw/);
    assert.match(calls[2].url, /\/Users\/AuthenticateByName$/);
    const authHeader = (calls[2].headers as Record<string, string>)['X-Emby-Authorization'];
    assert.match(authHeader, /DeviceId="device-abc"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listEpisodes requests episode metadata and maps season info', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | string) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('ParentId'), 'series1');
    assert.equal(url.searchParams.get('IncludeItemTypes'), 'Episode');

    return new Response(
      JSON.stringify({
        Items: [
          {
            Id: 'ep1',
            Name: 'Pilot',
            Type: 'Episode',
            SeriesId: 'series1',
            SeriesName: 'Series 1',
            ParentIndexNumber: 1,
            IndexNumber: 1,
          },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    const episodes = await client.listEpisodes('series1');

    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].seriesId, 'series1');
    assert.equal(episodes[0].seasonNumber, 1);
    assert.equal(episodes[0].episodeNumber, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listContinueWatching requests resume endpoint and maps user progress', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | string) => {
    const url = new URL(String(input));
    assert.match(url.pathname, /\/Users\/user1\/Items\/Resume$/);
    assert.equal(url.searchParams.get('IncludeItemTypes'), 'Episode');

    return new Response(
      JSON.stringify({
        Items: [
          {
            Id: 'ep42',
            Name: 'The Hospies',
            Type: 'Episode',
            SeriesId: 'series1',
            SeriesName: "Schitt's Creek",
            ParentIndexNumber: 4,
            IndexNumber: 7,
            RunTimeTicks: 1_200_000_000,
            UserData: {
              PlaybackPositionTicks: 300_000_000,
              PlayedPercentage: 25,
              Played: false,
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    const items = await client.listContinueWatching('user1', 'show');

    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'ep42');
    assert.equal(items[0].type, 'show');
    assert.equal(items[0].progressPercent, 0.25);
    assert.equal(items[0].seriesName, "Schitt's Creek");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('setPlaybackPosition posts user-data payload without marking played', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    assert.match(String(input), /\/Users\/user2\/Items\/ep42\/UserData$/);
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.PlaybackPositionTicks, 555000000);
    assert.equal(body.Played, false);

    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    await client.setPlaybackPosition('user2', 'ep42', 555000000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getItemPlayedState reads the Played field from UserData', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | string) => {
    assert.match(String(input), /\/Users\/user2\/Items\?/);
    return new Response(
      JSON.stringify({
        Items: [
          {
            Id: 'ep42',
            UserData: {
              Played: true,
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    const watched = await client.getItemPlayedState('user2', 'ep42');
    assert.equal(watched, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listShowContinueWatching combines Resume and NextUp and prefers resume for overlapping series', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url.pathname);

    if (url.pathname.endsWith('/Items/Resume')) {
      return new Response(
        JSON.stringify({
          Items: [
            {
              Id: 'ep-s3e5',
              Name: 'Rooms by the Hour',
              Type: 'Episode',
              SeriesId: 'series-schitts-creek',
              SeriesName: "Schitt's Creek",
              ParentIndexNumber: 3,
              IndexNumber: 5,
              RunTimeTicks: 1_200_000_000,
              UserData: {
                PlaybackPositionTicks: 300_000_000,
                PlayedPercentage: 25,
                IsPlayed: false,
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (url.pathname === '/Shows/NextUp') {
      assert.equal(url.searchParams.get('UserId'), 'user1');
      return new Response(
        JSON.stringify({
          Items: [
            {
              Id: 'ep-s3e6',
              Name: 'Motel Review',
              Type: 'Episode',
              SeriesId: 'series-schitts-creek',
              SeriesName: "Schitt's Creek",
              ParentIndexNumber: 3,
              IndexNumber: 6,
            },
            {
              Id: 'ep-bf-s1e2',
              Name: 'Second Episode',
              Type: 'Episode',
              SeriesId: 'series-bob-favorite',
              SeriesName: "Bob's Favorite",
              ParentIndexNumber: 1,
              IndexNumber: 2,
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    return new Response(JSON.stringify({ Items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    const items = await client.listShowContinueWatching('user1');

    assert.equal(calls.some((pathname) => pathname.endsWith('/Items/Resume')), true);
    assert.equal(calls.includes('/Shows/NextUp'), true);
    assert.equal(items.length, 2);

    const schitts = items.find((item) => item.seriesId === 'series-schitts-creek');
    assert.ok(schitts);
    assert.equal(schitts?.id, 'ep-s3e5');
    assert.equal(schitts?.progressPercent, 0.25);

    const bobs = items.find((item) => item.seriesId === 'series-bob-favorite');
    assert.ok(bobs);
    assert.equal(bobs?.id, 'ep-bf-s1e2');
    assert.equal(bobs?.progressPercent, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function episodeListResponse() {
  return new Response(
    JSON.stringify({
      Items: [
        { Id: 'ep-s1e1', Name: 'Pilot', Type: 'Episode', SeriesId: 'series1', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 1 },
        { Id: 'ep-s1e2', Name: 'Second', Type: 'Episode', SeriesId: 'series1', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 2 },
        { Id: 'ep-s2e1', Name: 'Premiere', Type: 'Episode', SeriesId: 'series1', SeriesName: 'Show', ParentIndexNumber: 2, IndexNumber: 1 },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

test('getNextEpisode returns the following episode in air order, crossing seasons', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => episodeListResponse()) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');

    const midSeason = await client.getNextEpisode('series1', 1, 1);
    assert.equal(midSeason?.id, 'ep-s1e2');

    // End of a season rolls into the next season's premiere.
    const crossSeason = await client.getNextEpisode('series1', 1, 2);
    assert.equal(crossSeason?.id, 'ep-s2e1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getNextEpisode returns null for the last episode of a series', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => episodeListResponse()) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    const next = await client.getNextEpisode('series1', 2, 1);
    assert.equal(next, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getNextEpisode returns null when the current episode is not found', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => episodeListResponse()) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    const next = await client.getNextEpisode('series1', 9, 9);
    assert.equal(next, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchUsers maps jellyfin users to FamilyMember list and builds avatar URLs', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | string) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/Users');

    return new Response(
      JSON.stringify([
        { Id: 'user1', Name: 'Alice', PrimaryImageTag: 'img-tag-1' },
        { Id: 'user2', Name: 'Bob' },
      ]),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    const users = await client.fetchUsers();

    assert.equal(users.length, 2);
    assert.equal(users[0].id, 'user1');
    assert.equal(users[0].name, 'Alice');
    assert.equal(users[0].jellyfinUserId, 'user1');
    assert.ok(users[0].avatarUrl);
    assert.match(users[0].avatarUrl as string, /\/Users\/user1\/Images\/Primary/);
    assert.match(users[0].avatarUrl as string, /tag=img-tag-1/);
    assert.equal(users[1].avatarUrl, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
