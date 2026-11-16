---
name: smithy.gh-issue
description: "GitHub issue operations: validate environment, search issues, create issues from a body file, and link blocked-by relationships. Use when an agent needs to read or create issues in the current repo."
allowed-tools: Bash(git config --get remote.origin.url) Bash(*/smithy.gh-issue/scripts/check-env.sh) Bash(*/smithy.gh-issue/scripts/search-issues.sh *) Bash(*/smithy.gh-issue/scripts/create-issue.sh *) Bash(*/smithy.gh-issue/scripts/link-blocked-by.sh *) mcp__github__issue_write mcp__github__search_issues
---
# smithy.gh-issue

Provides GitHub issue operations through two interchangeable paths:

1. **GitHub MCP server** (preferred when available) — calls
   `mcp__github__search_issues` and `mcp__github__issue_write` directly.
   No `gh` CLI dependency and no per-command approval prompts for the issue
   operations themselves. This is the only path that works on hosts without
   `gh` installed, such as Claude Code on the web. Validate Environment is
   the one exception: even on this path it reads the git remote through a
   single stable shell call, so a host with MCP tools but no shell at all
   must be given `owner` / `repo` some other way.
2. **Bundled `gh`-CLI shell scripts** (fallback) — four scripts in this
   skill's `scripts/` directory wrap `gh` invocations. Use these when the
   GitHub MCP server is not configured, and for Link Blocked-By, which has
   no MCP equivalent.

Reference the scripts as
`${CLAUDE_SKILL_DIR}/scripts/<script-name>`.



| Operation | MCP-first path | Script fallback |
|-----------|----------------|-----------------|
| Validate Environment | `git config --get remote.origin.url` (no `gh` needed) | `check-env.sh` |
| Search Issues | `mcp__github__search_issues` | `search-issues.sh <state> <query> [limit]` |
| Create Issue | `mcp__github__issue_write` (`method: "create"`) | `create-issue.sh "<title>" <body-file>` |
| Link Blocked-By | *(none — GitHub's MCP server exposes no `addBlockedBy` mutation)* | `link-blocked-by.sh <child> <blocker>` |

Each script is small and stable with a fixed set of `gh` calls (most use one;
`link-blocked-by.sh` makes a few — repo lookup, two node-id lookups, then the
mutation). The host's permission prompt sees one stable command per operation
instead of a long, ad-hoc `gh` invocation. This mirrors the
`smithy.pr-review` pattern.

## Path Selection

For each operation:

1. **Try MCP first.** If `mcp__github__<tool>` is in your available tool set,
   use it. The MCP path is faster (no shell hop for Search Issues or Create
   Issue), avoids permission prompts, and works regardless of whether `gh` is
   installed.
2. **Fall back to the script** if MCP is unavailable, returns a "tool not
   found" / connection error, or the host clearly lacks the MCP server. The
   scripts assume `gh` is on `PATH` and authenticated.

Decide path-by-path, not session-globally — some hosts may expose only a
subset of the MCP tools. Never call `gh` ad-hoc for these operations; go
through one of the two paths above so permissions stay scoped.

**Neither path available.** If the MCP tools are absent *and* `check-env.sh`
reports `gh` missing, stop the calling flow and tell the user that issue
creation needs either the GitHub MCP server configured or `gh` installed and
authenticated. Do not silently skip issue creation and report success.

---

## Operation: Validate Environment

Resolves the `owner` / `repo` / `ownerRepo` values every other operation
needs. Run this **once** at the start of any flow that will create or query
issues.

### MCP path

Read the git origin remote — this needs no `gh` and no MCP call:

```bash
git config --get remote.origin.url
```

Parse the output:

- `git@github.com:OWNER/REPO.git` → owner `OWNER`, repo `REPO`
- `https://github.com/OWNER/REPO.git` → owner `OWNER`, repo `REPO`
- `https://github.com/OWNER/REPO` (no `.git`) → owner `OWNER`, repo `REPO`

Strip a trailing `.git` if present. `ownerRepo` is `<owner>/<repo>`. If the
command returns nothing, there is no GitHub remote — stop and say so.

### Script fallback

Verifies the `gh` CLI is installed and the current directory is a GitHub
repo. Returns JSON with `owner`, `repo`, and `ownerRepo`. Exits non-zero with
a friendly stderr message on failure.

```bash
${CLAUDE_SKILL_DIR}/scripts/check-env.sh
```

---

## Operation: Search Issues

Searches issues in the current repo. Use this for duplicate detection and for
locating parent tickets when stitching artifacts together.

### MCP path

Call `mcp__github__search_issues` with `owner` and `repo` from Validate
Environment, the ticket title as `query`, and a result cap of about 10.

**Read the tool's own schema before composing the call — do not assume the
shape from this page.** `search_issues` differs across GitHub MCP server
versions in two ways that change what a correct call looks like:

- **`query` semantics.** Some versions match `query` semantically as natural
  language; others parse it as GitHub issue-search syntax. Passing the plain
  ticket title (e.g. `[Story] My Title`) is valid on both. Add a qualifier
  such as `in:title` **only** when the schema documents GitHub search syntax
  — on a natural-language version the qualifier is matched as literal words
  and widens the search rather than narrowing it.
- **Optional parameters.** Response-trimming parameters such as `fields` exist
  on some versions and not others. Pass one only if the schema in your tool
  set lists it; sending an unknown parameter can fail validation and push you
  onto the `gh` fallback, which is exactly the path a gh-less host does not
  have.

Filter the results yourself for the state you want (`open`, `closed`, or
both) — do not assume a state filter was applied. Because a title query can
return near-misses under either `query` semantics, always compare each
result's title against the one you are about to create before treating it as
a duplicate.

### Script fallback

```bash
${CLAUDE_SKILL_DIR}/scripts/search-issues.sh <state> <search-query> [limit]
```

- `state`: `open`, `closed`, or `all`.
- `search-query`: any gh-compatible search string. Add `in:title` to restrict
  the match to titles (e.g. `"[Story] My Title in:title"`).
- `limit`: optional, defaults to 10.

Either path yields `{number, title, state, body}` entries, empty when nothing
matches. The `body` field lets you disambiguate same-named items across
artifacts (e.g. milestones with the same name in different RFCs — match on
the `**Source**` line in the body).

---

## Operation: Create Issue

### MCP path

Call `mcp__github__issue_write` with `method: "create"`, the `owner` and
`repo` from Validate Environment, the `title`, and the full markdown `body`
as a string. No temp file is involved — pass the body directly. The response
carries the new issue's `number` and `html_url`; capture the number for
parent/child linking and for the orders summary table.

### Script fallback

Always write the body to a temp file first to avoid quoting problems with
markdown.

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

Output: JSON `{"number": N, "url": "..."}`. Clean up the temp body file after
creation.

---

## Operation: Link Blocked-By

Marks one issue as blocked by another via the GitHub `addBlockedBy` GraphQL
mutation. Use this after both the parent and child issues exist.

**There is no MCP path for this operation** — the GitHub MCP server exposes
no `addBlockedBy` equivalent (`sub_issue_write` writes parent/child hierarchy,
which is a different relationship, so do not substitute it). The script is
the only path.

```bash
${CLAUDE_SKILL_DIR}/scripts/link-blocked-by.sh <child-number> <blocker-number>
```

The script handles node-ID lookup and the mutation itself. Output: JSON
`{"child": N, "blocker": N}` on success. Errors (e.g. issues not found, repo
without sub-issue support) surface on stderr — treat them as best-effort and
continue rather than aborting the parent flow. On a host with no `gh` at all,
that best-effort rule is what applies: the issues are already created, so
report the unlinked pairs and carry on.
