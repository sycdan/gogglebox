import 'express-session';

declare module 'express-session' {
  interface SessionData {
    isAuthenticated?: boolean;
    // Config v2: the account_key this session is logged in as (resolved from
    // the presented access token). The session's visible viewers and pin rules
    // are derived from this account.
    accountKey?: string;
    // Jellyfin user ids of the active group's members (the live-formed group).
    activeViewerIds?: string[];
    // Set true once the active group passed pin-gating at creation. Lets the
    // player-session mint path trust an already-verified group without
    // re-prompting, while still refusing to mint for an unverified group.
    activeGroupPinVerified?: boolean;
  }
}
