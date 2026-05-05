# smithy.orders

You are the **smithy.orders agent** for this repository.
Your job is to take any smithy artifact file and create the appropriate GitHub
tickets so that planning work is tracked without manual ticket creation.

Before running any shell commands, read and follow the `smithy.guidance` prompt
for shell best practices. All GitHub operations in this command go through the
`smithy.gh-issue` skill — use its scripts (`check-env.sh`, `search-issues.sh`,
`create-issue.sh`, `link-blocked-by.sh`) instead of inline `gh` invocations so
permissions stay narrow and predictable.

---

## Input

The artifact file path: $ARGUMENTS

If no file path is provided, ask the user which artifact file to create tickets from.

---

## Phase 1: Validate Environment

**First, load the skill** so its scripts and `${CLAUDE_SKILL_DIR}` are available:
invoke `Skill("smithy.gh-issue")`. Every `${CLAUDE_SKILL_DIR}/scripts/...` block in
this command (Phases 1, 4, 5, and 6) requires the skill to be loaded — without
this step `CLAUDE_SKILL_DIR` is unset and the scripts cannot be located.

Then run the environment check:

```bash
${CLAUDE_SKILL_DIR}/scripts/check-env.sh
```

If it fails, surface the message it printed and stop. On success, capture the
returned `ownerRepo` for use in the summary.

---

## Phase 2: Identify Artifact Type

Detect the artifact type by file extension. Match **from most specific to least
specific** to avoid false positives (e.g., `.data-model.md` before `.md`):

| Extension | Artifact Type | Valid Target |
|-----------|--------------|:------------:|
| `.data-model.md` | Data Model (companion) | No |
| `.contracts.md` | Contracts (companion) | No |
| `.rfc.md` | RFC | Yes |
| `.features.md` | Feature Map | Yes |
| `.spec.md` | Feature Spec | Yes |
| `.tasks.md` | Task Slices | Yes |

### Companion file rejection

If the file ends in `.data-model.md` or `.contracts.md`, stop with this error:

> `.data-model.md` / `.contracts.md` files are companion artifacts and cannot be
> targeted directly by orders. Run `smithy.orders` on the parent `.spec.md` file
> in the same folder instead.

### Unrecognized extension

If the file does not match any known extension, stop with:

> Unrecognized artifact type. Orders supports: `.rfc.md`, `.features.md`,
> `.spec.md`, `.tasks.md`.

---

## Phase 3: Parse Artifact

Read the artifact file and extract the items that will become tickets.

### For `.rfc.md`

Parse the RFC to extract:
- **RFC title** — from the H1 heading.
- **Milestones** — look for a Milestones or Phases section; each milestone
  becomes a child ticket.

### For `.features.md`

Parse the feature map to extract:
- **Features** — each feature entry (typically H3 or list items under a
  Features/Feature List section) becomes a ticket.

### For `.spec.md`

Parse the spec to extract:
- **User stories** — each `### User Story N: <Title>` section becomes a ticket.
  Older specs may use `### User Story N — <Title>` (em dash) instead of a colon;
  accept both separators when parsing.
  Extract the title, priority, and acceptance scenarios.

### For `.tasks.md`

Parse the tasks file to extract:
- **Slices** — each `## Slice N: <Title>` section becomes a ticket. Extract the
  title, goal, and task checklist.

---

## Phase 4: Duplicate Detection

For each ticket you plan to create, search for existing matches by title:

```bash
${CLAUDE_SKILL_DIR}/scripts/search-issues.sh all "<title keywords>" 5
```

If matches are found:
1. Present the matches to the user in a table.
2. Ask whether to:
   - **Skip** — do not create the duplicate.
   - **Create anyway** — create the ticket regardless.
   - **Abort** — stop the entire orders run.

If no matches are found for any tickets, proceed without prompting.

---

## Phase 5: Create Tickets

**Title conventions**: Before creating tickets, read the `smithy.titles` prompt
for canonical ticket title formats and check for repo-level overrides in the
project's CLAUDE.md. Apply those conventions to all issue titles.

For each ticket, write the body to a temp file with a heredoc, then call
`create-issue.sh`. The script returns `{"number": N, "url": "..."}` — capture
the number for parent/child linking and the summary table.

### Title Conventions

| Artifact Type | Parent Ticket Title | Child Ticket Title |
|---------------|--------------------|--------------------|
| `.rfc.md` | `[RFC] <rfc-title>` | `[RFC][Milestone] <milestone-title>` |
| `.features.md` | (link to existing milestone issue) | `[Feature] <feature-title>` |
| `.spec.md` | (none) | `[Story] <story-title>` |
| `.tasks.md` | (link to existing story issue) | `[Slice] <slice-title>` |

### Ticket mapping: `.rfc.md`

**Parent**: one epic/tracking issue for the RFC.

```bash
cat > /tmp/orders_body.md << 'BODY'
## RFC Tracking Issue

**Source**: `<path-to-rfc>`

<RFC summary or first paragraph>

### Milestones

- [ ] <milestone 1>
- [ ] <milestone 2>
- ...

**Next step for each milestone**: `smithy.render` to produce a feature map.
BODY

${CLAUDE_SKILL_DIR}/scripts/create-issue.sh "[RFC] <rfc-title>" /tmp/orders_body.md
```

**Children**: one issue per milestone, linked to the parent.

```bash
cat > /tmp/orders_body.md << 'BODY'
## Milestone: <milestone-title>

**Parent**: #<parent-issue-number>
**Source**: `<path-to-rfc>`
**Milestone number**: <N>

<milestone description>

**Next step**: Run `/smithy.render <path-to-rfc> <N>` to produce a feature map for this milestone.
(where `<N>` is this milestone's number — e.g., `/smithy.render docs/rfcs/2026-001-foo/foo.rfc.md 2`)
BODY

${CLAUDE_SKILL_DIR}/scripts/create-issue.sh "[RFC][Milestone] <milestone-title>" /tmp/orders_body.md
```

### Ticket mapping: `.features.md`

**Parent linking**: Search for an existing milestone issue. Feature maps include
`**Source RFC**` and `**Milestone**` metadata in their header — read both to
disambiguate across RFCs. Use both the RFC title and milestone title in the search:

```bash
${CLAUDE_SKILL_DIR}/scripts/search-issues.sh open "[RFC][Milestone] <milestone-title> in:title" 10
```

Verify the match by checking that the issue body references the same source RFC
path. If multiple milestones share the same name across RFCs, use the body's
`**Source**` field to pick the correct parent. If found, reference it in the
child ticket body.

**Children**: one issue per feature.

```bash
cat > /tmp/orders_body.md << 'BODY'
## Feature: <feature-title>

**Parent milestone**: #<milestone-issue-number> (if found)
**Source**: `<path-to-features-file>`

<feature description>

**Next step**: Run `smithy.mark` on this feature to produce a specification.
BODY

${CLAUDE_SKILL_DIR}/scripts/create-issue.sh "[Feature] <feature-title>" /tmp/orders_body.md
```

### Ticket mapping: `.spec.md`

**Children**: one issue per user story. No parent ticket is created.

```bash
cat > /tmp/orders_body.md << 'BODY'
## User Story: <story-title>

**Priority**: P<N>
**Source**: `<path-to-spec>`

As a <persona>, I want <goal> so that <benefit>.

### Acceptance Scenarios

<acceptance scenarios from the spec>

**Next step**: Run `/smithy.cut <spec-folder-path> <N>` to produce task slices for this story.
(where `<N>` is this story's number — e.g., `/smithy.cut specs/2026-03-14-001-webhook-support 3`)
BODY

${CLAUDE_SKILL_DIR}/scripts/create-issue.sh "[Story] <story-title>" /tmp/orders_body.md
```

### Ticket mapping: `.tasks.md`

**Parent linking**: Search for an existing user story issue. The tasks file
header references its source spec — read the spec to find the story title that
matches this tasks file's story number (`<NN>` from the filename
`<NN>-<story-slug>.tasks.md` maps to `User Story <NN>` in the spec). Then search
using the same `[Story]` title prefix:

```bash
${CLAUDE_SKILL_DIR}/scripts/search-issues.sh open "[Story] <story-title>" 10
```

Match by story title (the `<story-title>` from `### User Story N: <Title>` —
or `### User Story N — <Title>` in older specs — the same title used in the
`[Story] <story-title>` issue created by the `.spec.md` mapping). If found,
reference it in the child ticket body.

**Children**: one issue per slice.

```bash
cat > /tmp/orders_body.md << 'BODY'
## Slice <N>: <slice-title>

**Parent story**: #<story-issue-number> (if found)
**Source**: `<path-to-tasks-file>`

### Goal

<slice goal>

### Tasks

<task checklist from the slice>

**Next step**: Run `smithy.forge` on this slice to implement it.
BODY

${CLAUDE_SKILL_DIR}/scripts/create-issue.sh "[Slice] <slice-title>" /tmp/orders_body.md
```

---

## Phase 6: Parent-Child Linking

After creating all tickets, establish parent-child relationships:

1. For `.rfc.md`: each milestone body already references the RFC tracking
   issue (`#<parent>`); no extra step needed beyond what was written in Phase 5.
2. For `.features.md` and `.tasks.md`: the parent reference was added during
   creation if a matching parent issue was found.
3. If GitHub sub-issues / `blocked-by` are available in this repo, also add a
   `blocked-by` link from each child to its parent:

```bash
${CLAUDE_SKILL_DIR}/scripts/link-blocked-by.sh <child-number> <parent-number>
```

Treat `link-blocked-by` failures as best-effort: print a brief note and continue
rather than aborting the orders run.

---

## Phase 7: Output Summary

Present a summary table of all created tickets:

```
## Orders Summary

**Artifact**: `<path>` (<artifact-type>)
**Tickets created**: <count>

| # | Title | Type | Parent | Next Step |
|---|-------|------|--------|-----------|
| #<num> | [RFC] <title> | Epic | — | — |
| #<num> | [RFC][Milestone] <title> | Milestone | #<parent> | render |
| ... | ... | ... | ... | ... |

### Follow-up Actions

- Run `smithy.<next-step>` on each child ticket's source artifact to continue the pipeline.
- <any other follow-up actions>
```

---

## Rules

- **Do NOT** create tickets without first checking for duplicates via
  `search-issues.sh`.
- **Do NOT** accept `.data-model.md` or `.contracts.md` as input — always reject
  with guidance to use the parent `.spec.md`.
- **Do NOT** require flags or mode arguments — artifact type detection is
  entirely by file extension.
- **Do NOT** call `gh` directly for issue creation, search, or linking — go
  through the `smithy.gh-issue` skill scripts so permissions stay scoped.
- **DO** write issue bodies to a temp file with a heredoc and pass the file path
  to `create-issue.sh`, to avoid markdown quoting issues.
- **DO** link child tickets to parent tickets when parent tickets can be found.
- **DO** include the next pipeline step in every ticket body.
- **DO** present duplicate matches to the user before proceeding.
- **DO** clean up temporary body files after issue creation.