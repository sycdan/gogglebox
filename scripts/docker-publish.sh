#!/usr/bin/env bash
set -euo pipefail

# Load env file if present to provide defaults
if [[ -f ".env" ]]; then
	set -a
	source .env
	set +a
fi

REGISTRY_HOST="${REGISTRY_HOST:-}"
IMAGE_NAME="${IMAGE_NAME:-gogglebox}"
PLATFORM="${PLATFORM:-}"

if [[ -z "${REGISTRY_HOST}" ]]; then
	echo "set REGISTRY_HOST in .env or as env var, e.g. registry.example.com:5000" >&2
	exit 1
fi

# Build local image before tagging/pushing to registry.
# Fixed internal tag used only as the local build/source for `docker tag`.
IMAGE_REF="${IMAGE_NAME}:build"
build_args=()
if [[ -n "${PLATFORM}" ]]; then
	build_args+=(--platform "${PLATFORM}")
fi

printf 'Building image: %s\n' "${IMAGE_REF}"
docker build "${build_args[@]}" -t "${IMAGE_REF}" .

# Compute a timestamped version tag: yyyy.m.d.<minute-of-day> (0-1439).
# Force base-10 so month/day/hour/minute have no leading zeros and aren't
# parsed as octal (08, 09). Year stays 4-digit.
VERSION_TAG="$(date +%Y).$(( 10#$(date +%m) )).$(( 10#$(date +%d) )).$(( 10#$(date +%H) * 60 + 10#$(date +%M) ))"

printf 'Version tag: %s\n' "${VERSION_TAG}"

# Push both "latest" and the computed version tag from the same built image.
for tag in latest "${VERSION_TAG}"; do
	REMOTE_IMAGE_REF="${REGISTRY_HOST}/${IMAGE_NAME}:${tag}"
	printf 'Tagging image: %s -> %s\n' "${IMAGE_REF}" "${REMOTE_IMAGE_REF}"
	docker tag "${IMAGE_REF}" "${REMOTE_IMAGE_REF}"
	printf 'Pushing image: %s\n' "${REMOTE_IMAGE_REF}"
	docker push "${REMOTE_IMAGE_REF}"
done
