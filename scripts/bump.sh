#!/usr/bin/env bash
# Bump package.json to a PRERELEASE of today's calendar release version and commit
# it. Run this before pushing an image change to main — the pre-push hook refuses a
# push to main that changed an image input (a Dockerfile COPY source) without a
# version bump, so every publish-worthy change carries a fresh, promotable version.
# (Docs/test/tooling-only pushes need no bump.)
#
#   version = <YYYY.M.D>-<ms-since-midnight-UTC>
#
# The date already lives in the main version parts, so the suffix is just the
# milliseconds elapsed since the start of that UTC day (0..86399999) — effectively
# unique per bump (a collision would need two bumps in the same millisecond).
# Anything after the `-` makes it a prerelease in semver, and a plain integer is a
# valid identifier (never prints with a leading zero). Once pushed, publish.yml
# builds + tests an image tagged with this exact version; release.yml later promotes
# that image to the clean <YYYY.M.D> tag and strips the suffix.
#
# Runs npm inside the node container (the host has only docker + git); commits on
# the host with git.
set -euo pipefail

cd "$(dirname "$0")/.."

day="$(date -u +%Y-%m-%d)"
base="$(date -u +%Y.%-m.%-d)"
midnight_s="$(date -u -d "${day}T00:00:00Z" +%s)"
now_ms="$(date -u +%s%3N)"
ms=$(( now_ms - midnight_s * 1000 ))
version="${base}-${ms}"

# npm version updates package.json AND package-lock.json; --no-git-tag-version
# keeps it from creating its own commit/tag (we commit on the host below).
docker compose run --rm --no-deps -T deps npm version "$version" --no-git-tag-version >/dev/null

git add package.json package-lock.json
git commit -m "chore: bump to ${version}"

echo "bumped to ${version}"
