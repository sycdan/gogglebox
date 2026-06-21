export type LibraryKind = 'movie' | 'show';

export interface FamilyMember {
  id: string;
  jellyfinUserId: string;
  name: string;
  avatarUrl?: string | null;
}

export interface GroupPreset {
  id: string;
  name: string;
  memberIds: string[];
}

export interface HouseholdSettings {
  username: string;
  password: string;
}

export interface AppConfig {
  appName: string;
  port: number;
  sessionSecret: string;
  watchedThreshold: number;
  portalAutoLogin: boolean;
  jellyfinUrl: string;
  jellyfinApiKey: string;
  household: HouseholdSettings;
  viewers: FamilyMember[];
  groups: GroupPreset[];
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

export interface ContinueWatchingItem extends LibraryItem {
  sourceViewerId: string;
  sourceViewerName: string;
  playbackPositionTicks: number;
  progressPercent: number;
  seriesId: string | null;
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}
