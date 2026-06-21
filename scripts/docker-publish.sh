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
IMAGE_TAG="${IMAGE_TAG:-latest}"
PLATFORM="${PLATFORM:-}"

if [[ -z "${REGISTRY_HOST}" ]]; then
	echo "set REGISTRY_HOST in .env or as env var, e.g. registry.example.com:5000" >&2
	exit 1
fi

# Build local image before tagging/pushing to registry.
IMAGE_REF="${IMAGE_NAME}:${IMAGE_TAG}"
build_args=()
if [[ -n "${PLATFORM}" ]]; then
	build_args+=(--platform "${PLATFORM}")
fi

printf 'Building image: %s\n' "${IMAGE_REF}"
docker build "${build_args[@]}" -t "${IMAGE_REF}" .

LOCAL_IMAGE_REF="${IMAGE_NAME}:${IMAGE_TAG}"
REMOTE_IMAGE_REF="${REGISTRY_HOST}/${IMAGE_NAME}:${IMAGE_TAG}"

printf 'Tagging image: %s -> %s\n' "${LOCAL_IMAGE_REF}" "${REMOTE_IMAGE_REF}"
docker tag "${LOCAL_IMAGE_REF}" "${REMOTE_IMAGE_REF}"

printf 'Pushing image: %s\n' "${REMOTE_IMAGE_REF}"
docker push "${REMOTE_IMAGE_REF}"
