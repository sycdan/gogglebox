#!/usr/bin/env bash
# docker compose for the e2e stack: docker-compose.base.yml with
# docker-compose.e2e.yml layered on it. Plain -f layering, not include, because
# older Compose releases (GitHub's runner) refuse to override included
# services. Pass any compose arguments, e.g.
# ./scripts/e2e.sh run --rm -e PROOF_FLOW=search proof
set -euo pipefail
cd "$(dirname "$0")/.."
env_files=(--env-file .env.e2e)
[[ -f .env.sbx ]] && env_files+=(--env-file .env.sbx)
exec docker compose "${env_files[@]}" -f docker-compose.base.yml -f docker-compose.e2e.yml "$@"
