# Statio service image. Build from the repo root:
#   docker build -t march-statio:latest -f docker/statio.Dockerfile .
# (or `npm run build:statio-image`).
#
# The container runs `march statio serve` — the forge-read gateway. It includes
# gh and git only for read-only forge access, without host-control tooling.
# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim

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
# Forge-read toolchain: gh plus git/repo metadata and curl for healthchecks.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
  && rm -rf /var/lib/apt/lists/*
# gh CLI from its official apt repo.
RUN mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

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
CMD ["statio", "serve", "--host", "0.0.0.0"]
