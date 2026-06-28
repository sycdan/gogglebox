// Shared helper: discover which BASE a sandbox Jellyfin currently serves its API
// under. JF only serves the API under its configured network BaseUrl, so once we
// set BaseUrl=/player the BARE root 302-redirects and only /player works. But on
// a FRESH volume BaseUrl is unset (bare), and provisioning is what SETS /player —
// so the active base must be DISCOVERED, not assumed.
//
// Usage:
//   const base = await resolveJellyfinBase(process.env.JELLYFIN_URL);
//   const jf = makeJellyfin(base, apiKey);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Strip a trailing slash and a trailing /player so we get the BARE server root,
// regardless of whether the configured URL already includes the base path.
export function bareRoot(rawUrl) {
  return (rawUrl || 'http://jellyfin-sandbox:8096')
    .trim()
    .replace(/\/$/, '')
    .replace(/\/player$/, '');
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

// Resolve the active base for a sandbox JF: tries the bare root first (fresh
// volume), then <root>/player (already provisioned). Retries while JF boots.
// Returns the base URL string (no trailing slash).
export async function resolveJellyfinBase(rawUrl, { attempts = 120, delayMs = 2000, token } = {}) {
  const root = bareRoot(rawUrl);
  const player = `${root}/player`;
  for (let i = 0; i < attempts; i += 1) {
    if (await probeBase(root, { token })) return root;
    if (await probeBase(player, { token })) return player;
    await sleep(delayMs);
  }
  throw new Error(
    `Jellyfin not reachable on either ${root} or ${player} (is the sandbox up?)`,
  );
}
