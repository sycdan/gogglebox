// Shared helper: wait for the sandbox Jellyfin API at its normalized bare origin.
// Sandbox volumes are disposable; if an old volume was configured with a Jellyfin
// BaseUrl such as /player, recreate the sandbox volumes instead of supporting
// both shapes.
//
// Usage:
//   const base = await resolveJellyfinBase(process.env.JELLYFIN_URL);
//   const jf = makeJellyfin(base, apiKey);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function bareRoot(rawUrl) {
  return (rawUrl || 'http://jellyfin-sandbox:8096')
    .trim()
    .replace(/\/$/, '');
}

// True if GET <base>/System/Info/Public returns 200 (a live API at this base).
export async function probeBase(base, { token } = {}) {
  try {
    const res = await fetch(new URL('System/Info/Public', `${base.replace(/\/$/, '')}/`), {
      headers: token ? { 'X-Emby-Token': token } : {},
      redirect: 'manual',
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

// Returns the normalized base URL string (no trailing slash) once reachable.
export async function resolveJellyfinBase(rawUrl, { attempts = 120, delayMs = 2000, token } = {}) {
  const root = bareRoot(rawUrl);
  for (let i = 0; i < attempts; i += 1) {
    if (await probeBase(root, { token })) return root;
    await sleep(delayMs);
  }
  throw new Error(
    `Jellyfin not reachable at ${root} (is the sandbox up? If an old sandbox volume still uses BaseUrl=/player, recreate the sandbox volumes.)`,
  );
}
