import 'express-session';

declare module 'express-session' {
  interface SessionData {
    isAuthenticated?: boolean;
    // Config v2: the account_key this session is logged in as (resolved from
    // the presented access token). The session's visible viewers and pin rules
    // are derived from this account.
    accountKey?: string;
    // Jellyfin user ids of the active party's members (the live-formed party,
    // formerly called a "group").
    activeViewerIds?: string[];
    // Set true once the active party passed pin-gating at creation. Lets the
    // player-session mint path trust an already-verified party without
    // re-prompting, while still refusing to mint for an unverified party.
    // Sessions are in-memory only (never persisted to disk), so this field was
    // renamed cleanly from `activeGroupPinVerified` with no rollout concern.
    activePartyPinVerified?: boolean;
  }
}
