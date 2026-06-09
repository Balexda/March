# Legate service image. Build from the repo root:
#   docker build -t march-legate:latest -f docker/legate.Dockerfile .
# (or `npm run build:legate-image`).
#
# The container runs `march legate serve` — the profile-agnostic Legate service.
# One container drives EVERY registered profile: each tick it lists the profiles
# from Herald's registry (the source of truth), drains the single multiplexed
# Herald event stream, and runs the deterministic two-stage tick per profile. It
# reaches Castra/Brood/Hatchery/Herald over HTTP (no Docker socket — it asks those
# services to act rather than shelling docker), and shells git/gh/smithy against
# the mounted repos. See docker/legate.docker-compose.yml for mounts.
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
# Toolchain the deterministic tick shells out to: git/gh (PR + branch state),
# jq, python3, and tmux/openssh (parity with the host the workers run under).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    gnupg \
    jq \
    openssh-client \
    python3 \
    tmux \
  && rm -rf /var/lib/apt/lists/*
# Seed GitHub's SSH host key so git-over-SSH verifies without a prompt.
RUN ssh-keyscan -t rsa,ed25519 github.com >> /etc/ssh/ssh_known_hosts 2>/dev/null || true
# gh CLI from its official apt repo (the legate reads PR/branch state via gh).
RUN mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Smithy CLI — the legate runs `smithy status` each tick to find ready work.
RUN npm install -g @balexda/smithy@0.5.13 && npm cache clean --force
COPY --from=build /app/dist ./dist
# `march` on PATH; a world-writable log dir so the service can write its log
# file under any runtime uid/gid the compose `user:` selects.
RUN ln -sf /app/dist/cli.js /usr/local/bin/march \
  && mkdir -p /march/logs \
  && chmod 0777 /march/logs

ENTRYPOINT ["march"]
CMD ["legate", "serve"]
