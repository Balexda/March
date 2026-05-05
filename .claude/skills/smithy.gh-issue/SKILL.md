---
name: smithy.gh-issue
description: "GitHub issue operations: validate environment, search issues, create issues from a body file, and link blocked-by relationships. Use when an agent needs to read or create issues in the current repo."
allowed-tools: Bash(*/smithy.gh-issue/scripts/check-env.sh) Bash(*/smithy.gh-issue/scripts/search-issues.sh *) Bash(*/smithy.gh-issue/scripts/create-issue.sh *) Bash(*/smithy.gh-issue/scripts/link-blocked-by.sh *)
---
# smithy.gh-issue

Provides GitHub issue operations via shell scripts bundled in this skill's `scripts/`
directory. Reference them as `${CLAUDE_SKILL_DIR}/scripts/<script-name>`.

Each operation is implemented as a small, stable script with a fixed set of
`gh` calls (most use one; `link-blocked-by.sh` makes a few — repo lookup, two
node-id lookups, then the mutation). The host's permission prompt sees one
stable command per operation instead of a long, ad-hoc `gh` invocation. This
mirrors the `smithy.pr-review` pattern.

---

## Operation: Validate Environment

Verifies the `gh` CLI is installed and the current directory is a GitHub repo.
Returns JSON with `owner`, `repo`, and `ownerRepo`. Exits non-zero with a
friendly stderr message on failure.

```bash
${CLAUDE_SKILL_DIR}/scripts/check-env.sh
```

Run this **once** at the start of any flow that will create or query issues.

---

## Operation: Search Issues

Searches issues in the current repo. Use this for duplicate detection and for
locating parent tickets when stitching artifacts together.

```bash
${CLAUDE_SKILL_DIR}/scripts/search-issues.sh <state> <search-query> [limit]
```

- `state`: `open`, `closed`, or `all`.
- `search-query`: any gh-compatible search string. Add `in:title` to restrict
  the match to titles (e.g. `"[Story] My Title in:title"`).
- `limit`: optional, defaults to 10.

Output is a JSON array of `{number, title, state, body}`. Empty array (`[]`)
when nothing matches. The `body` field lets you disambiguate same-named items
across artifacts (e.g. milestones with the same name in different RFCs — match
on the `**Source**` line in the body).

---

## Operation: Create Issue

Creates a GitHub issue in the current repo from a title and a body file. Always
write the body to a temp file first to avoid quoting problems with markdown.

**Step 1 — write the body:**
```bash
cat > /tmp/smithy_issue_body.md << 'BODY'
## Heading

Body content with `code`, **bold**, etc.
BODY
```

**Step 2 — create the issue:**
```bash
${CLAUDE_SKILL_DIR}/scripts/create-issue.sh "<title>" /tmp/smithy_issue_body.md
```

Output: JSON `{"number": N, "url": "..."}`. Capture the `number` for parent/child
linking and for the orders summary table.

Clean up the temp body file after creation.

---

## Operation: Link Blocked-By

Marks one issue as blocked by another via the GitHub `addBlockedBy` GraphQL
mutation. Use this after both the parent and child issues exist.

```bash
${CLAUDE_SKILL_DIR}/scripts/link-blocked-by.sh <child-number> <blocker-number>
```

The script handles node-ID lookup and the mutation itself. Output: JSON
`{"child": N, "blocker": N}` on success. Errors (e.g. issues not found, repo
without sub-issue support) surface on stderr — treat them as best-effort and
continue rather than aborting the parent flow.
