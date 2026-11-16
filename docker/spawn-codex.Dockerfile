FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.169.0

# git: required so the in-container spawn wrapper can init a repo, commit the
# agent's work, and produce the patch via `git diff` (the worker never
# hand-renders a patch). ripgrep: the agent's default search tool.
# NOTE: `gh` is intentionally NOT installed — the worker never pushes or opens
# a PR; the steward session owns delivery and keeps `gh`. Commit identity is set
# per-spawn by the wrapper, so no image-level identity is needed.
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
