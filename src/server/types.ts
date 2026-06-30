export type LibraryKind = 'movie' | 'show';

export interface FamilyMember {
  id: string;
  jellyfinUserId: string;
  name: string;
  avatarUrl?: string | null;
}

// Config v2: a configured user, referenced by its (unique) Jellyfin name. The
// optional pin gates adding this user to a group from any account that marks
// them pin_required.
export interface ConfigUser {
  jellyfin_name: string;
  pin?: string;
}

// Config v2: a user an account may see, and whether forming a group with that
// user from this account requires the user's pin.
export interface VisibleUser {
  jellyfin_name: string;
  pin_required?: boolean;
}

// Config v2: a login account (a household). Authenticates with username/password
// and sees only its own visible_users.
export interface ConfigAccount {
  username: string;
  password: string;
  visible_users: VisibleUser[];
}

// Optional auto-login credentials sourced from PORTAL_USERNAME/PORTAL_PASSWORD.
// When set AND matching an accounts[] entry, that account is logged in
// automatically; otherwise the login screen is shown.
export interface PortalCredentials {
  username: string;
  password: string;
}

export interface AppConfig {
  appName: string;
  port: number;
  sessionSecret: string;
  watchedThreshold: number;
  // Auto-login credentials (PORTAL_USERNAME/PORTAL_PASSWORD), or null when unset.
  portalCredentials: PortalCredentials | null;
  jellyfinUrl: string;
  jellyfinApiKey: string;
  recommendations: {
    count: number;
  };
  users: ConfigUser[];
  accounts: ConfigAccount[];
  // Resolved at startup: configured Jellyfin name -> Jellyfin user (id/avatar).
  // Empty until the startup resolution runs (see resolveViewers / server.ts).
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
