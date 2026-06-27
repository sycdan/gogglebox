#!/usr/bin/env bash
# UAT stack: base + the developer's REAL Jellyfin overlay. Saves typing -f -f.
#   ./scripts/uat.sh up -d server client
#   ./scripts/uat.sh run --rm proof
set -euo pipefail
exec docker compose -f docker-compose.yml -f docker-compose.uat.yml "$@"
