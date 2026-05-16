---
name: smithy.pr-review
description: "GitHub PR review operations: list inline comments, reply to comments. Use when handling review feedback on an open pull request."
allowed-tools: Bash(git remote get-url *) Bash(git branch --show-current) Bash(git config --get remote.origin.url) Bash(*/smithy.pr-review/scripts/find-pr.sh) Bash(*/smithy.pr-review/scripts/get-comments.sh:*) Bash(*/smithy.pr-review/scripts/reply-comment.sh:*) mcp__github__list_pull_requests mcp__github__pull_request_read mcp__github__add_reply_to_pull_request_comment _list_pull_request_review_threads _reply_to_review_comment
---
# smithy.pr-review

Provides GitHub PR review operations through Codex's GitHub app connector,
with the bundled `gh`-CLI scripts kept as a fallback:

1. **Codex GitHub app connector** (preferred when available) — use the
   GitHub app actions directly for review-thread operations:
   `_list_pull_request_review_threads` and `_reply_to_review_comment`.
   If those actions are not already visible in your tool set, use tool
   discovery for "GitHub pull request review threads reply" before falling
   back to shell. This path avoids `gh` for listing/replying to review
   threads and avoids shell permission prompts.
2. **Bundled `gh`-CLI shell scripts** (fallback) — three scripts in this
   skill's `scripts/` directory wrap `gh` invocations. Use these when
   the GitHub app connector is unavailable, a needed action is missing, or
   you need to discover the open PR for the current branch.

| Operation             | Codex app path                         | Script fallback                                                                  |
|-----------------------|----------------------------------------|----------------------------------------------------------------------------------|
| Find Open PR          | Use known PR context if available; otherwise use fallback script | `./.agents/skills/smithy.pr-review/scripts/find-pr.sh` |
| List Inline Comments  | `_list_pull_request_review_threads`    | `./.agents/skills/smithy.pr-review/scripts/get-comments.sh <ownerRepo> <pr-number>` |
| Reply to a Comment    | `_reply_to_review_comment`             | `./.agents/skills/smithy.pr-review/scripts/reply-comment.sh <ownerRepo> <pr-number> <comment-id> <body-file>` |

## Path Selection

For each operation:

1. **Try the Codex GitHub app first** for listing and replying to review
   threads. If the app actions are not visible, use tool discovery before
   falling back to shell.
2. **Use known PR context when present.** If the user, current task, or
   previous tool output already identifies `owner/repo` and PR number, do
   not run the Find Open PR fallback just to rediscover it.
3. **Fall back to the script** if the GitHub app connector is unavailable,
   returns a tool-not-found / connection error, lacks the needed action, or
   the operation is Find Open PR and no PR number is known.

---

## Operation: Find Open PR

Detects the open PR for the current branch.

### Codex app path

The discovered Codex GitHub app actions do not provide a direct "find open PR
for this branch" operation. If `repo_full_name` and `pr_number` are already
known from the conversation or prior tool output, use them and skip this
operation. Otherwise use the script fallback below.

### Script fallback

```bash
./.agents/skills/smithy.pr-review/scripts/find-pr.sh
```

Returns JSON with `owner`, `repo`, `pr`, and `ownerRepo` fields, or `{}`
if no open PR exists for the current branch.

---

## Operation: List Inline Comments

Fetches review threads on the PR with their full reply chains.

### Codex app path

Call `_list_pull_request_review_threads` with:
- `repo_full_name`: `"<owner>/<repo>"`
- `pr_number`

The response contains GraphQL review thread nodes with resolved state,
comment bodies, and comment IDs. Filter out resolved threads before handing
them to the caller — only unresolved threads need a reply.

### Script fallback

```bash
./.agents/skills/smithy.pr-review/scripts/get-comments.sh <ownerRepo> <pr-number>
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
  - Codex app path: the numeric ID of the thread's top-level inline
    review comment
  - Script path: `comments[0].databaseId`

---

## Operation: Reply to a Comment

Posts an inline reply to a specific review thread.

### Codex app path

Call `_reply_to_review_comment` with:
- `repo_full_name`: `"<owner>/<repo>"`
- `pr_number`
- `comment_id`: the numeric ID of the thread's top-level inline review
  comment
- `comment`: the reply text

### Script fallback

Write the reply body to a temp JSON file first to avoid quoting issues,
then POST it:

```bash
cat > /tmp/smithy_reply_<databaseId>.json << 'EOF'
{"body": "your reply text here"}
EOF
./.agents/skills/smithy.pr-review/scripts/reply-comment.sh <ownerRepo> <pr-number> <databaseId> /tmp/smithy_reply_<databaseId>.json
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
