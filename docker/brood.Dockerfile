# Brood service image. Build from the repo root:
#   docker build -t march-brood:latest -f docker/brood.Dockerfile .
# (or `npm run build:brood-image`).
#
# The container runs `march brood serve` — the session-state + lifecycle/teardown
# authority. Teardown reclaims artifacts by shelling out to docker (mounted host
# socket) and git, delegates steward-session removal to castra (#153) over HTTP,
# and removes worktrees/branches by EXACT tracked path (never a blanket prune —
# issue #155). See docker/brood.docker-compose.yml for mounts.
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
# /var/run/docker.sock). No agent-deck/tmux: steward teardown is delegated to
# castra over HTTP, so brood never drives agent-deck in the container.
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz" \
    | tar -xz -C /tmp \
  && mv /tmp/docker/docker /usr/local/bin/docker \
  && rm -rf /tmp/docker

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# `march` on PATH; a world-writable log dir so the service can write its log
# file under any runtime uid/gid the compose `user:` selects.
RUN ln -sf /app/dist/cli.js /usr/local/bin/march \
  && mkdir -p /march/logs \
  && chmod 0777 /march/logs

ENTRYPOINT ["march"]
CMD ["brood", "serve"]
