import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import dotenv from 'dotenv';

import { JellyfinClient } from './jellyfin';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const jellyfinUrl = process.env.JELLYFIN_URL?.trim();
const jellyfinApiKey = process.env.JELLYFIN_API_KEY?.trim();

function getRealEnv(): { url: string; key: string } {
  if (!jellyfinUrl || !jellyfinApiKey) {
    throw new Error('Missing JELLYFIN_URL or JELLYFIN_API_KEY in .env for real-service E2E tests.');
  }

  return { url: jellyfinUrl, key: jellyfinApiKey };
}

async function getFirstJellyfinUserId(url: string, key: string): Promise<string> {
  const usersUrl = new URL('/Users', url);
  const response = await fetch(usersUrl, {
    headers: {
      'X-Emby-Token': key,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Could not load Jellyfin users (${response.status}): ${body.slice(0, 200)}`);
  }

  const users = (await response.json()) as Array<{ Id?: string }>;
  const firstId = users.find((user) => typeof user.Id === 'string' && user.Id.length > 0)?.Id;
  if (!firstId) {
    throw new Error('No Jellyfin users were returned by /Users.');
  }

  return firstId;
}

test('real e2e: list movies and shows from live Jellyfin service', async () => {
  const env = getRealEnv();
  const client = new JellyfinClient(env.url, env.key);

  const movies = await client.listItems('movie');
  const shows = await client.listItems('show');

  assert.ok(Array.isArray(movies));
  assert.ok(Array.isArray(shows));

  if (movies.length > 0) {
    assert.equal(movies[0].type, 'movie');
    assert.ok(typeof movies[0].id === 'string' && movies[0].id.length > 0);
  }

  if (shows.length > 0) {
    assert.equal(shows[0].type, 'show');
    assert.ok(typeof shows[0].id === 'string' && shows[0].id.length > 0);
  }
});

test('real e2e: watched ids are available for movie and show kinds', async () => {
  const env = getRealEnv();
  const client = new JellyfinClient(env.url, env.key);
  const userId = await getFirstJellyfinUserId(env.url, env.key);

  const watchedMovies = await client.getWatchedItemIds(userId, 'movie');
  const watchedShows = await client.getWatchedItemIds(userId, 'show');

  assert.ok(watchedMovies instanceof Set);
  assert.ok(watchedShows instanceof Set);
});

test('real e2e: stream endpoint responds for at least one movie when available', async () => {
  const env = getRealEnv();
  const client = new JellyfinClient(env.url, env.key);
  const movies = await client.listItems('movie');

  if (movies.length === 0) {
    return;
  }

  const response = await client.fetchMovieStream(movies[0].id, 'bytes=0-1');
  assert.ok(response.status === 200 || response.status === 206);
});

test('real e2e: list episodes for one series when series exist', async () => {
  const env = getRealEnv();
  const client = new JellyfinClient(env.url, env.key);
  const shows = await client.listItems('show');

  if (shows.length === 0) {
    return;
  }

  const episodes = await client.listEpisodes(shows[0].id);
  assert.ok(Array.isArray(episodes));

  if (episodes.length > 0) {
    assert.ok(typeof episodes[0].id === 'string' && episodes[0].id.length > 0);
    assert.equal(episodes[0].seriesId, shows[0].id);
  }
});
