---
name: smithy.pr-review
description: "GitHub PR review operations: list inline comments, reply to comments. Use when handling review feedback on an open pull request."
allowed-tools: Bash(*/smithy.pr-review/scripts/find-pr.sh) Bash(*/smithy.pr-review/scripts/get-comments.sh *) Bash(*/smithy.pr-review/scripts/reply-comment.sh *)
---
# smithy.pr-review

Provides GitHub PR review operations via shell scripts bundled in this skill's `scripts/`
directory. Reference them as `${CLAUDE_SKILL_DIR}/scripts/<script-name>`.

---

## Operation: Find Open PR

Detects the open PR for the current branch. Returns JSON with `owner`, `repo`, `pr`,
and `ownerRepo` fields. Returns empty object `{}` if no open PR exists.

```bash
${CLAUDE_SKILL_DIR}/scripts/find-pr.sh
```

---

## Operation: List Inline Comments

Fetches all **unresolved** review threads with their full reply chains. Resolved threads
are automatically filtered out.

```bash
${CLAUDE_SKILL_DIR}/scripts/get-comments.sh <ownerRepo> <pr-number>
```

The result is an array of **threads** (one entry per review thread). Each thread:
- `isResolved`: always `false` (resolved threads are filtered out)
- `comments[]`: full reply chain for this thread, **oldest first**. Each comment:
  `databaseId`, `body`, `path`, `diffHunk`, `author.login`, `createdAt`

To work a thread: read the full `comments[]` chain for context — the **last** entry
is the most recent reply and typically has the highest-priority context (e.g. a
follow-up or escalation from the reviewer). Use `comments[0].databaseId` as the
reply target when posting a response to this thread.

---

## Operation: Reply to a Comment

Posts an inline reply to a specific review comment. Write the reply body to a temp JSON
file first to avoid quoting issues, then POST it.

**Step 1 — write reply body:**
```bash
cat > /tmp/smithy_reply_<databaseId>.json << 'EOF'
{"body": "your reply text here"}
EOF
```

**Step 2 — post reply:**
```bash
${CLAUDE_SKILL_DIR}/scripts/reply-comment.sh <ownerRepo> <pr-number> <databaseId> /tmp/smithy_reply_<databaseId>.json
```

For a **fix** reply: `"Fixed in <commit-sha>: <one-line explanation of what changed and why>"`
For a **decline** reply: `"Not addressed: <explanation — why the comment doesn't apply, or what was misunderstood>"`

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
