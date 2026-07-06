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
# Even after `compose down` exits, Docker Desktop on Windows (WSL2/Hyper-V
# backend) can lag briefly releasing the bind-mount handle before the host
# filesystem actually reflects it free — a race, not a permanent lock. Retry
# `git worktree remove` with backoff instead of failing hard on the first
# attempt.
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

delay=1
attempt=1
max_attempts=5
until git worktree remove "$worktree" --force 2>/tmp/teardown-session-worktree-remove.err; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "warn: '$worktree' still locked after $max_attempts attempts; unregistering the worktree administratively and leaving the directory for a later manual delete" >&2
    cat /tmp/teardown-session-worktree-remove.err >&2
    git worktree prune
    rmdir "$worktree" 2>/dev/null || true
    break
  fi
  sleep "$delay"
  delay=$((delay * 2))
  attempt=$((attempt + 1))
done
rm -f /tmp/teardown-session-worktree-remove.err

git branch -D "$session_name"
