import 'express-session';

declare module 'express-session' {
  interface SessionData {
    isAuthenticated?: boolean;
    // Config v2: the username of the account this session is logged in as. The
    // session's visible users and pin rules are derived from this account.
    accountUsername?: string;
    // Jellyfin user ids of the active group's members (the live-formed group).
    activeViewerIds?: string[];
    // Set true once the active group passed pin-gating at creation. Lets the
    // player-session mint path trust an already-verified group without
    // re-prompting, while still refusing to mint for an unverified group.
    activeGroupPinVerified?: boolean;
  }
}
