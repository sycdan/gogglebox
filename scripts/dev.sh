#!/usr/bin/env bash
# docker compose for the hot-reload dev stack: the e2e stack plus
# docker-compose.dev.yml. Pass any compose arguments, e.g. ./scripts/dev.sh up -d
set -euo pipefail
exec "$(dirname "$0")/e2e.sh" -f docker-compose.dev.yml "$@"
