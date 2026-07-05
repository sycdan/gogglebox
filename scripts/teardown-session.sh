#!/usr/bin/env bash
# Tear down one ./sessions/<session_name> worktree: stop/remove every Docker
# container and volume for that session's compose project (compose derives the
# project name from the worktree's folder name), then remove the worktree and
# its branch.
#
# The `deps` service (npm ci) is a depends_on for check/test/server/etc, not
# the target of `run --rm` — it exits 0 but is never removed, and an exited
# container can still hold the bind-mounted worktree dir open (observed on
# Windows), which then wedges `git worktree remove` with a permission/busy
# error. `compose down` is what actually removes it; deleting the worktree dir
# first does not.
#
# Usage: scripts/teardown-session.sh <session_name>
set -euo pipefail

session_name="${1:?usage: scripts/teardown-session.sh <session_name>}"
worktree="./sessions/${session_name}"

if [ -d "$worktree" ]; then
  # No -p: compose auto-derives the project name from this directory, which is
  # the same auto-derivation subagents get from plain `docker compose ...` run
  # inside the worktree (per AGENTS.md's examples, which never pass -p).
  ( cd "$worktree" && docker compose down -v --remove-orphans ) || true
fi

git worktree remove "$worktree" --force
git branch -D "$session_name"
