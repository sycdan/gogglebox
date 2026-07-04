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

1. [ ] [proof](./.proofs/019f2aa8-492f-70f0-984e-d190346c435b.md) that config supports `accounts[account_key] = account_config` and `access_tokens[token] = account_key`, validates token uniqueness, and migrates older supported config versions automatically on startup.
2. [ ] [proof](./.proofs/019f2aa8-4931-7a1c-86ba-4785a38163c3.md) that portal login accepts a valid access token, rejects invalid tokens with a clear error, and stores the token locally until logout clears it.
3. [ ] [proof](./.proofs/019f2aa8-4933-796a-977a-7b9c756a7040.md) that account users render as primary users selected by default with avatars, secondary users visible and unselected by default, and an add-guest control matching avatar sizing.
4. [ ] [proof](./.proofs/019f2aa8-4934-7057-ac9a-c1ce09978cf1.md) that the add-guest flow lists eligible tertiary users, requires PIN entry for each selected guest that needs one, and prevents confirmation until required PINs are valid.
5. [ ] [proof](./.proofs/019f2aa8-4936-7965-b407-de265936e392.md) that continuing with a group that contains non-primary users shows a confirmation warning that watch progress will be affected for every user in the group.
6. [ ] [proof](./.proofs/019f2aa8-4937-78c2-84fc-7c0eadca4372.md) that existing group selection and Jellyfin player handoff continue to work for token-authenticated accounts in both sandbox proof and real-data UAT where available.
