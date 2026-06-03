FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.136.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@openai/codex@${CODEX_VERSION}"

RUN groupmod --new-name march node \
  && usermod --login march --home /home/march --move-home node \
  && mkdir -p /march/workspace /march/codex-home \
  && chown -R march:march /march /home/march

ENV CODEX_HOME=/march/codex-home
WORKDIR /march/workspace
USER march

CMD ["codex", "--version"]
