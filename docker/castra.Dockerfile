# Castra service image. Build from the repo root:
#   docker build -t march-castra:latest -f docker/castra.Dockerfile .
# (or `npm run build:castra-image`).
#
# The container runs `march castra serve` and drives agent-deck (mounted from
# the host HOME's ~/.local/bin) over the mounted host tmux socket — see
# docker/castra.docker-compose.yml for the required mounts.
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
    tmux \
  && rm -rf /var/lib/apt/lists/*
# Static docker CLI only (the daemon is the host's, reached via the mounted
# /var/run/docker.sock). tmux is installed so agent-deck can drive the host
# tmux server through the mounted socket — keep its version close to the host's
# to avoid tmux protocol mismatches.
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz" \
    | tar -xz -C /tmp \
  && mv /tmp/docker/docker /usr/local/bin/docker \
  && rm -rf /tmp/docker

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# `march` on PATH.
RUN ln -sf /app/dist/cli.js /usr/local/bin/march

ENTRYPOINT ["march"]
CMD ["castra", "serve", "--host", "0.0.0.0"]
