---
name: smithy.pr-review
description: "GitHub PR review operations: list inline comments, reply to comments. Use when handling review feedback on an open pull request."
allowed-tools: Bash(git remote get-url *) Bash(git branch --show-current) Bash(git config --get remote.origin.url) Bash(*/smithy.pr-review/scripts/find-pr.sh) Bash(*/smithy.pr-review/scripts/get-comments.sh:*) Bash(*/smithy.pr-review/scripts/reply-comment.sh:*) mcp__github__list_pull_requests mcp__github__pull_request_read mcp__github__add_reply_to_pull_request_comment
---
# smithy.pr-review

Provides GitHub PR review operations through two interchangeable paths:

1. **GitHub MCP server** (preferred when available) — calls
   `mcp__github__list_pull_requests`, `mcp__github__pull_request_read`,
   and `mcp__github__add_reply_to_pull_request_comment` directly. No
   shell, no `gh` CLI dependency, no per-command approval prompts.
2. **Bundled `gh`-CLI shell scripts** (fallback) — three scripts in this
   skill's `scripts/` directory wrap `gh` invocations. Use these when
   the GitHub MCP server is not configured (e.g. claude.ai web without
   the MCP, local Claude Code installs that have not added the GitHub
   MCP, or any other non-MCP host).

| Operation             | MCP-first path                                    | Script fallback                                                                  |
|-----------------------|---------------------------------------------------|----------------------------------------------------------------------------------|
| Find Open PR          | `mcp__github__list_pull_requests`                 | `${CLAUDE_SKILL_DIR}/scripts/find-pr.sh`                                         |
| List Inline Comments  | `mcp__github__pull_request_read` (`get_review_comments`) | `${CLAUDE_SKILL_DIR}/scripts/get-comments.sh <ownerRepo> <pr-number>`     |
| Reply to a Comment    | `mcp__github__add_reply_to_pull_request_comment`  | `${CLAUDE_SKILL_DIR}/scripts/reply-comment.sh <ownerRepo> <pr-number> <id> <body-file>` |

## Path Selection

For each operation:

1. **Try MCP first.** If `mcp__github__<tool>` is in your available
   tool set, use it. The MCP path is faster (no shell hop), avoids
   permission prompts, and works regardless of whether `gh` is
   installed.
2. **Fall back to the script** if MCP is unavailable, returns a
   "tool not found" / connection error, or the host clearly lacks the
   MCP server. The scripts assume `gh` is on `PATH` and authenticated.

Decide path-by-path, not session-globally — some hosts may expose only a
subset of the MCP tools.

---

## Operation: Find Open PR

Detects the open PR for the current branch.

### MCP path

Resolve `owner` and `repo` from the git origin remote, then call
`list_pull_requests`:

```bash
git config --get remote.origin.url
```

Parse the output:

- `git@github.com:OWNER/REPO.git` → owner `OWNER`, repo `REPO`
- `https://github.com/OWNER/REPO.git` → owner `OWNER`, repo `REPO`
- `https://github.com/OWNER/REPO` (no `.git`) → owner `OWNER`, repo `REPO`

Strip a trailing `.git` if present. Get the branch:

```bash
git branch --show-current
```

If the branch is empty (detached HEAD), there is no PR to find — stop.

Then call `mcp__github__list_pull_requests` with:
- `owner`, `repo` — resolved above
- `head`: `"<owner>:<branch>"` (the GitHub `head` filter requires the
  `<user>:<branch>` form — pass the same `owner` you resolved from the
  remote, then a colon, then the branch name)
- `state`: `"open"`
- `perPage`: `1`

If the response array is empty, treat as "no open PR for this branch".
Otherwise capture `number` from the first entry.

### Script fallback

```bash
${CLAUDE_SKILL_DIR}/scripts/find-pr.sh
```

Returns JSON with `owner`, `repo`, `pr`, and `ownerRepo` fields, or `{}`
if no open PR exists for the current branch.

---

## Operation: List Inline Comments

Fetches review threads on the PR with their full reply chains.

### MCP path

Call `mcp__github__pull_request_read` with:
- `method`: `"get_review_comments"`
- `owner`, `repo`, `pullNumber`
- `perPage`: `100` (max). The `get_review_comments` method is
  **cursor-paginated** (not page-numbered): if `pageInfo.hasNextPage ==
  true` in the response, fetch the next page by passing `after` set to
  `pageInfo.endCursor`. Do **not** rely on a numeric `page` parameter
  for this method — it is silently ignored, so a PR with more than 100
  review threads would have its tail dropped.

The response is an object with:
- `review_threads[]` — array of review threads. Each thread has
  `is_resolved`, `is_outdated`, `is_collapsed`, plus `comments`
  containing the reply chain. Each comment carries `id` (the numeric
  `databaseId` used as `commentId` for replies), `body`, `path`,
  `diffHunk`, `author.login` (or `user.login`), and `createdAt`.
  Comments are ordered oldest → newest within a thread.
- `pageInfo` — `{ hasNextPage, endCursor, ... }` for cursor pagination.

**Filter out threads where `is_resolved == true`** before handing them
to the caller — only unresolved threads need a reply.

### Script fallback

```bash
${CLAUDE_SKILL_DIR}/scripts/get-comments.sh <ownerRepo> <pr-number>
```

Returns a JSON array of **threads** (one entry per review thread). Each
thread has:
- `isResolved`: always `false` — resolved threads are filtered out by
  the script's `gh api graphql` query.
- `comments[]`: the full reply chain, **oldest first**. Each comment
  carries `databaseId`, `body`, `path`, `diffHunk`, `author.login`, and
  `createdAt`.

Returns `[]` if there are no unresolved review threads.

### Working a thread (both paths)

- Read the **full** `comments[]` chain — the **last** comment is the
  most recent reply and typically has the highest-priority context (a
  follow-up or escalation from the reviewer takes precedence over the
  original).
- The reply target is the **root comment**:
  - MCP path: `comments[0].id`
  - Script path: `comments[0].databaseId`

---

## Operation: Reply to a Comment

Posts an inline reply to a specific review thread.

### MCP path

Call `mcp__github__add_reply_to_pull_request_comment` with:
- `owner`, `repo`, `pullNumber`
- `commentId`: the **root** comment's `id` (`comments[0].id` from the
  thread)
- `body`: the reply text (plain string — no temp-file or JSON wrapping
  is needed; this is one of the simplifications over the script path).

### Script fallback

Write the reply body to a temp JSON file first to avoid quoting issues,
then POST it:

```bash
cat > /tmp/smithy_reply_<databaseId>.json << 'EOF'
{"body": "your reply text here"}
EOF
${CLAUDE_SKILL_DIR}/scripts/reply-comment.sh <ownerRepo> <pr-number> <databaseId> /tmp/smithy_reply_<databaseId>.json
```

### Reply body conventions (both paths)

- For a **fix** reply: `"Fixed in <commit-sha>: <one-line explanation of what changed and why>"`
- For a **decline** reply: `"Not addressed: <explanation — why the comment doesn't apply, or what was misunderstood>"`

---

## Decision Criteria: Fix vs. Decline

When evaluating a review comment, apply these criteria:

**Fix when:**
- The comment identifies a clear bug, typo, wrong logic, or naming issue
- The change is mechanical and low-risk (no design tradeoffs)
- The reviewer's reasoning is sound

**Decline when:**
- The comment is a stylistic preference where the current approach is equally valid
- Accepting would expand scope beyond the PR's intent
- The comment is based on a misunderstanding of the intent (explain why)
- The change requires design discussion or dependency-version approval
