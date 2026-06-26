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

test('fetchMovieStream uses query token and forwards range header', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));

    assert.equal(url.searchParams.get('api_key'), 'abc123');
    assert.equal(url.searchParams.get('static'), 'true');
    assert.equal((init?.headers as Record<string, string>).Range, 'bytes=0-10');
    assert.equal((init?.headers as Record<string, string>)['X-Emby-Token'], 'abc123');

    return new Response(null, { status: 206 });
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    const response = await client.fetchMovieStream('item1', 'bytes=0-10');

    assert.equal(response.status, 206);
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

test('fetchItemNames requests ids in one call and maps id to name', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = (async (input: URL | string) => {
    callCount += 1;
    const url = new URL(String(input));
    assert.match(url.pathname, /\/Items$/);
    assert.equal(url.searchParams.get('Ids'), 'show-a,show-b');

    return new Response(
      JSON.stringify({
        Items: [
          { Id: 'show-a', Name: 'Show A', Type: 'Series' },
          { Id: 'show-b', Name: 'Show B', Type: 'Series' },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    // Duplicate id should be de-duped into a single request param.
    const names = await client.fetchItemNames(['show-a', 'show-b', 'show-a']);

    assert.equal(callCount, 1);
    assert.equal(names.get('show-a'), 'Show A');
    assert.equal(names.get('show-b'), 'Show B');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchItemNames skips the request and returns empty for no ids', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    const names = await client.fetchItemNames([]);
    assert.equal(called, false);
    assert.equal(names.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchItemNames omits unresolved ids so callers can fall back', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ Items: [{ Id: 'show-a', Name: 'Show A', Type: 'Series' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;

  try {
    const client = new JellyfinClient('https://example.com', 'abc123');
    const names = await client.fetchItemNames(['show-a', 'deleted-id']);
    assert.equal(names.get('show-a'), 'Show A');
    assert.equal(names.has('deleted-id'), false);
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
