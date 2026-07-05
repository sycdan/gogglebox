export type LibraryKind = 'movie' | 'show';

export interface FamilyMember {
  id: string;
  jellyfinUserId: string;
  name: string;
  avatarUrl?: string | null;
}

// Config v2: a configured user, referenced by its (unique) Jellyfin name. The
// pin registry: the optional pin gates adding this user to a party whenever
// they resolve to the tertiary (guest) tier for the logged-in account.
export interface ConfigUser {
  jellyfin_name: string;
  pin?: string;
}

// Config v2: a login account (a household), keyed by account_key in
// AppConfig.accounts. Tier lists are arrays of Jellyfin user NAMES; the viewer
// universe is ALL live Jellyfin users (not just users[]):
//   - primary_users: selected by default when the picker loads (deselectable).
//     Omitted/null => [].
//   - secondary_users: listed after primaries, unselected by default.
//     Omitted/null => WILDCARD: all live Jellyfin users minus primaries minus
//     explicit tertiaries. Explicit [] => none.
//   - tertiary_users (guests): not shown as cards; addable only via the
//     pin-gated "add guest" flow. Omitted/null => WILDCARD: all live Jellyfin
//     users minus primaries minus resolved secondaries. Explicit [] => none.
// Precedence when a name appears in multiple explicit lists:
// primary > secondary > tertiary (keep highest, warn at startup).
export interface AccountV2 {
  primary_users?: string[] | null;
  secondary_users?: string[] | null;
  tertiary_users?: string[] | null;
}

export interface AppConfig {
  appName: string;
  port: number;
  sessionSecret: string;
  watchedThreshold: number;
  // Optional auto-login token from the ACCESS_TOKEN env var, or null when
  // unset. When it matches a configured access token, an empty login body
  // authenticates as that token's account (the portal auto-login).
  envAccessToken: string | null;
  jellyfinUrl: string;
  jellyfinApiKey: string;
  recommendations: {
    count: number;
  };
  users: ConfigUser[];
  // account_key -> tiered account config.
  accounts: Record<string, AccountV2>;
  // access token -> account_key. Login is by token ONLY; tokens must be unique.
  accessTokens: Record<string, string>;
  // Resolved at startup: Jellyfin name -> Jellyfin user (id/avatar), for ALL
  // live Jellyfin users (wildcard tiers may include unconfigured users). Empty
  // until the startup resolution runs (see resolveViewers / server.ts).
  viewersByName: Record<string, FamilyMember>;
}

export interface LibraryItem {
  id: string;
  name: string;
  type: LibraryKind;
  overview: string;
  year: number | null;
  runtimeMinutes: number | null;
  rating: number | null;
  genres: string[];
  officialRating: string | null;
  imageUrl: string | null;
  backdropUrl: string | null;
  playable: boolean;
}

export interface ViewerWatchedState {
  viewerId: string;
  viewerName: string;
  avatarUrl?: string | null;
  watched: boolean;
}

export interface ContinueWatchingItem extends LibraryItem {
  sourceViewerId: string;
  sourceViewerName: string;
  playbackPositionTicks: number;
  progressPercent: number;
  seriesId: string | null;
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  viewerWatched?: ViewerWatchedState[];
}
