# Auth Refactor

## Overview

Refactor portal access so a shared access token identifies the household account.
The account determines which Jellyfin users are primary, secondary, or tertiary,
how they appear in the portal, and when PIN confirmation is required before a
group can continue.

## Goals

- Replace username/password-first portal access with account access tokens that
  can be remembered locally until logout.
- Let each account define primary, secondary, and tertiary Jellyfin users with
  clear default selection and guest-add behavior.
- Protect watch progress by warning when groups include non-primary users.
- Keep config migrations automatic for older config shapes.

## Nongoals

- Do not change Jellyfin authentication itself.
- Do not require a manual config migration step.
- Do not remove support for existing config files that can be migrated forward.

## Acceptance Criteria

1. [ ] Config supports `accounts[account_key] = account_config` and `access_tokens[token] = account_key`, validates token uniqueness, and migrates older supported config versions automatically on startup. [proof](./proofs/a9ab7985-2346-4449-8fd0-d83a6f23f2e6.md)
2. [ ] Portal login accepts a valid access token, rejects invalid tokens with a clear error, and stores the token locally until logout clears it. [proof](./proofs/1cb3f031-7c98-4823-b000-3aedf3a8ed05.md)
3. [ ] Account users render as primary users selected by default with avatars, secondary users visible and unselected by default, and an add-guest control matching avatar sizing. [proof](./proofs/552e1fb3-239a-4b17-a745-82f6967efea5.md)
4. [ ] The add-guest flow lists eligible tertiary users, requires PIN entry for each selected guest that needs one, and prevents confirmation until required PINs are valid. [proof](./proofs/5b2ec9e5-367d-44d9-ae87-c09c8b2f6da8.md)
5. [ ] Continuing with a group that contains non-primary users shows a confirmation warning that watch progress will be affected for every user in the group. [proof](./proofs/c22cedb9-d1a8-4307-9d7b-ee809db7055a.md)
6. [ ] Existing group selection and Jellyfin player handoff continue to work for token-authenticated accounts in both sandbox proof and real-data UAT where available. [proof](./proofs/0998e07f-9014-4ea6-a6a2-51b1bf9b27b7.md)
