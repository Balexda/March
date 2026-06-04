FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest

# git: required so the in-container spawn wrapper can init a repo, commit the
# agent's work, and produce the patch via `git diff` (the worker never
# hand-renders a patch). ripgrep: the agent's default search tool.
# NOTE: `gh` is intentionally NOT installed — the worker never pushes or opens
# a PR; the steward session owns delivery and keeps `gh`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

RUN groupmod --new-name march node \
  && usermod --login march --home /home/march --move-home node \
  && mkdir -p /march/workspace \
  && chown -R march:march /march /home/march

# Commit identity is set per-spawn by the wrapper (git config user.email /
# user.name), so no image-level identity is needed.
WORKDIR /march/workspace
USER march

CMD ["claude", "--version"]
