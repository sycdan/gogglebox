#!/usr/bin/env bash
# Sandbox stack: base + seeded offline Jellyfin overlay. Saves typing -f -f.
#   ./scripts/sbx.sh up -d server client
#   ./scripts/sbx.sh run --rm sandbox-reset
#   PROOF_FLOW=mark-all-watched ./scripts/sbx.sh run --rm proof
set -euo pipefail
exec docker compose -f docker-compose.yml -f docker-compose.sbx.yml "$@"
