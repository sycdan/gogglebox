# Sandbox tooling image: Node (for the generator/provisioner/reset scripts) plus
# ffmpeg (for encoding the tiny real .mp4 stubs). Kept separate from the app's
# node:22-alpine so we get a stable ffmpeg without bloating other services.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
