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
# tmux version MUST match the host tmux server Castra drives over the mounted
# socket: a client cannot speak to a server of a different protocol version
# ("server exited unexpectedly"). The host runs 3.6a (linuxbrew), newer than
# bookworm's apt tmux (3.3a), so build it from source. Override to match your
# host (`tmux -V`).
ARG TMUX_VERSION=3.6a

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
ARG TMUX_VERSION
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
  && rm -rf /var/lib/apt/lists/*
# tmux from source, pinned to ${TMUX_VERSION} so the client protocol matches the
# host tmux server agent-deck drives over the mounted socket. The build deps
# (which include the libevent/ncurses runtime libs tmux links) are left in place
# — purging + autoremove strips those runtime libs.
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends build-essential libevent-dev libncurses-dev bison pkg-config; \
  curl -fsSL "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" -o /tmp/tmux.tgz; \
  tar -xzf /tmp/tmux.tgz -C /tmp; \
  cd "/tmp/tmux-${TMUX_VERSION}"; \
  ./configure; \
  make -j"$(nproc)"; \
  make install; \
  cd /; \
  rm -rf /tmp/tmux* /var/lib/apt/lists/*; \
  tmux -V
# Static docker CLI only (the daemon is the host's, reached via the mounted
# /var/run/docker.sock).
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
