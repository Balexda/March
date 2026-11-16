# Tessera service image. Build from the repo root:
#   docker build -t march-tessera:latest -f docker/tessera.Dockerfile .
# (or `npm run build:tessera-image`).
#
# The container runs `march tessera serve` — the credential entitlement
# service. It talks to the forge over HTTPS only, so the runtime installs no
# forge CLI and no version-control tooling: just CA roots and curl for the
# container healthcheck.
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
# Only what the healthcheck and outbound HTTPS need.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# `march` on PATH; a world-writable log dir so the service can write its log
# file under any runtime uid/gid.
RUN ln -sf /app/dist/cli.js /usr/local/bin/march \
  && mkdir -p /march/logs \
  && chmod 0777 /march/logs

ENTRYPOINT ["march"]
CMD ["tessera", "serve", "--host", "0.0.0.0"]
