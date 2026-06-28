// Stage A: seed Jellyfin-web's localStorage so opening /player in a new tab on
// the SAME origin auto-logs-in as the gbx-controlled, per-group Jellyfin user.
//
// localStorage is per-ORIGIN. Because the front-door proxy serves both the gbx
// client (/) and Jellyfin-web (/player) from one origin, JS at / can write the
// keys Jellyfin-web reads. We persist NOTHING here that isn't ephemeral: the
// access token is short-lived and rotated on every mint.

export interface PlayerSessionPayload {
  serverId: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  // Origin-relative base path Jellyfin-web is served under (e.g. "/player").
  playerOrigin: string;
}

// A minimal localStorage-like surface so this is testable without a DOM.
export interface LocalStorageLike {
  setItem(key: string, value: string): void;
}

// Build the Jellyfin-web `jellyfin_credentials` value for the current origin.
// The server address points at the same-origin /player base so Jellyfin-web
// talks to the proxy, not the internal Jellyfin host.
//
// CRITICAL (jellyfin-apiclient 10.9.11): ConnectionManager resolves the address
// it hands to the ApiClient constructor PURELY from LastConnectionMode, via:
//   switch (mode) {
//     case 0: return server.LocalAddress;   // Local
//     case 2: return server.ManualAddress;  // Manual
//     case 1: return server.RemoteAddress;  // Remote
//     default: return ManualAddress || LocalAddress || RemoteAddress;
//   }
// (verified by grepping /player/web/node_modules.jellyfin-apiclient.bundle.js).
// We previously set LastConnectionMode:1 (Remote) with ONLY ManualAddress, so it
// read RemoteAddress (absent) -> the ApiClient ctor threw "Must supply a
// serverAddress" and React never mounted (splash stall). Fix: use mode 0 (Local,
// reads LocalAddress) AND populate EVERY address field with the same value so the
// resolution is correct regardless of which field/mode a given version reads.
export function buildJellyfinCredentials(
  payload: PlayerSessionPayload,
  origin: string,
  now: number = Date.now(),
): string {
  const address = `${origin}${payload.playerOrigin}`;
  return JSON.stringify({
    Servers: [
      {
        Id: payload.serverId,
        AccessToken: payload.accessToken,
        UserId: payload.userId,
        // Belt-and-suspenders: every address field set to the same same-origin
        // /player base. LocalAddress is what mode 0 reads; the rest cover any
        // other version/mode path. Extra address fields are harmless.
        Address: address,
        LocalAddress: address,
        ManualAddress: address,
        RemoteAddress: address,
        DateLastAccessed: now,
        // 0 = Local in jellyfin-apiclient's ConnectionMode enum {Local:0,
        // Remote:1, Manual:2} -> resolver returns LocalAddress (non-empty).
        LastConnectionMode: 0,
      },
    ],
  });
}

// Seed every Jellyfin-web localStorage key needed for silent auto-login. The
// _deviceId2 value MUST equal the deviceId used at mint, or the token is bound
// to a different device and auth fails.
export function seedJellyfinWebSession(
  storage: LocalStorageLike,
  payload: PlayerSessionPayload,
  origin: string,
  now: number = Date.now(),
): void {
  storage.setItem('jellyfin_credentials', buildJellyfinCredentials(payload, origin, now));
  storage.setItem('_deviceId2', payload.deviceId);
  storage.setItem('enableAutoLogin', 'true');
}
