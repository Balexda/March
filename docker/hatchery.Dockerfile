# Hatchery service image. Build from the repo root:
#   docker build -t march-hatchery:latest -f docker/hatchery.Dockerfile .
# (or `npm run build:hatchery-image`).
#
# The container runs `march hatchery serve` and performs the full spawn flow by
# shelling out to docker (mounted host socket) and git, and driving interactive
# sessions through the Castra HTTP API (no agent-deck binary or tmux socket
# mount) — see docker/hatchery.docker-compose.yml for the required mounts/env.
# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim
ARG DOCKER_CLI_VERSION=27.3.1

# --- build: bundle the CLI (needs dev deps: tsup) ---
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# `npm run build` also runs `scripts/generate-skills.mjs` (per-context march.*
# skill variants), so the generator + its inputs must be present.
COPY scripts ./scripts
RUN npm run build

# --- runtime ---
FROM ${NODE_IMAGE} AS runtime
ARG DOCKER_CLI_VERSION
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
  && rm -rf /var/lib/apt/lists/*
# Static docker CLI only (the daemon is the host's, reached via the mounted
# /var/run/docker.sock). agent-deck/tmux are no longer needed in this image:
# interactive sessions are driven through the Castra HTTP API.
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz" \
    | tar -xz -C /tmp \
  && mv /tmp/docker/docker /usr/local/bin/docker \
  && rm -rf /tmp/docker

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# `march` on PATH; a world-writable log dir so the service can write its log
# file under any runtime uid/gid the compose `user:` selects (a fresh named
# volume inherits this mode on first mount).
RUN ln -sf /app/dist/cli.js /usr/local/bin/march \
  && mkdir -p /march/logs \
  && chmod 0777 /march/logs

ENTRYPOINT ["march"]
CMD ["hatchery", "serve"]
