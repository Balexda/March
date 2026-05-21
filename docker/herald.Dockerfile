# Herald service image. Build from the repo root:
#   docker build -t march-herald:latest -f docker/herald.Dockerfile .
# (or `npm run build:herald-image`).
#
# The container runs `march herald serve` — the system-state observation service
# (heartbeat + data collection calved off the legate loop). It OBSERVES the world
# each tick: `gh` for PR/CI/review state, `smithy` for readiness, `git` to read
# the repo, and Castra (over HTTP) for sessions/output. It records change events
# into an append-only log and serves that log (the legate's inbox). Unlike brood
# it never touches Docker, so there is no docker CLI / socket here. See
# docker/herald.docker-compose.yml for mounts.
# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim

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
# Observation toolchain: git (read repo), gh (PR/CI/review state), jq, curl.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    jq \
  && rm -rf /var/lib/apt/lists/*
# Seed GitHub's SSH host key so git-over-SSH verifies without a prompt.
RUN ssh-keyscan -t rsa,ed25519 github.com >> /etc/ssh/ssh_known_hosts 2>/dev/null || true
# gh CLI from its official apt repo (Herald reads PR/branch state via gh).
RUN mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Smithy CLI — Herald runs `smithy status` each observe tick to find ready work.
RUN npm install -g @balexda/smithy@latest && npm cache clean --force
COPY --from=build /app/dist ./dist
# `march` on PATH; a world-writable log dir so the service can write its log
# file under any runtime uid/gid the compose `user:` selects.
RUN ln -sf /app/dist/cli.js /usr/local/bin/march \
  && mkdir -p /march/logs \
  && chmod 0777 /march/logs

ENTRYPOINT ["march"]
CMD ["herald", "serve"]
