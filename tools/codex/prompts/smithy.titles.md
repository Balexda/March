# smithy.titles

This prompt is the **single source of truth** for artifact title conventions
across all smithy planning commands. Every command that produces or parses
artifacts (spark, ignite, render, mark, cut, strike, orders) references this
prompt to ensure consistent naming.

---

## Document Title Conventions

Every artifact file begins with an H1 heading that follows this pattern:
`# <Type>: <Title>`

| Artifact | H1 Format | Example |
|----------|-----------|---------|
| PRD | `# PRD: <Title>` | `# PRD: Prompt Template Linter` |
| RFC | `# RFC: <Title>` | `# RFC: Plugin System` |
| Feature Map | `# Feature Map: <Title>` | `# Feature Map: Core Pipeline` |
| Feature Spec | `# Feature Specification: <Title>` | `# Feature Specification: Webhook Support` |
| Data Model | `# Data Model: <Title>` | `# Data Model: Webhook Support` |
| Contracts | `# Contracts: <Title>` | `# Contracts: Webhook Support` |
| Tasks | `# Tasks: <Title>` | `# Tasks: Send Webhook on Build Complete` |
| Strike | `# Strike: <Title>` | `# Strike: Add Verbose Flag` |

**Rules**:
- Always use a colon and single space after the type prefix: `<Type>: <Title>`.
- Title is in title case.
- The title should be concise — aim for 3-8 words.

---

## Sub-Element Title Conventions

Sub-elements within artifacts use **numbered headings with colon separators**:

| Sub-Element | Format | Example |
|-------------|--------|---------|
| Milestone | `### Milestone <N>: <Title>` | `### Milestone 1: Core Pipeline Commands` |
| Feature | `### Feature <N>: <Title>` | `### Feature 1: Template Deployment` |
| User Story | `### User Story <N>: <Title> (Priority: P<N>)` | `### User Story 1: Deploy Prompts (Priority: P1)` |
| Slice | `## Slice <N>: <Title>` | `## Slice 1: Add Template Reader` |

**Rules**:
- All sub-elements use **colon** (`:`) as the separator between number and title.
- Numbers are sequential starting at 1 within their parent artifact.
- User stories include priority inline in parentheses after the title.
- Slice headings are H2 (`##`); all others are H3 (`###`).

**Backward compatibility**: When **parsing** existing artifacts, also accept an
em dash (`—`) as the separator (e.g., `### User Story 1 — <Title>`). Older
specs may use this format. Always **write** new artifacts with the colon format.

---

## Slug & Folder Conventions

Slugs are derived from titles using **kebab-case**: lowercase, hyphens for spaces,
alphanumeric characters only.

| Artifact | Folder Pattern | Example |
|----------|----------------|---------|
| PRD | `docs/prds/<YYYY>-<NNN>-<slug>.prd.md` (flat file, no folder) | `docs/prds/2026-001-prompt-lint.prd.md` |
| RFC | `docs/rfcs/<YYYY>-<NNN>-<slug>/` | `docs/rfcs/2026-001-plugin-system/` |
| Feature Map | Co-located in RFC folder | `docs/rfcs/2026-001-plugin-system/01-core-pipeline.features.md` |
| Spec | `specs/<YYYY-MM-DD>-<NNN>-<slug>/` | `specs/2026-03-14-001-webhook-support/` |
| Tasks | Co-located in spec folder | `specs/.../03-send-webhook.tasks.md` |
| Strike | `specs/strikes/` | `specs/strikes/2026-03-14-verbose-flag.strike.md` |

**Numbering**:
- `<NNN>` is zero-padded to 3 digits (001, 002, ...).
- Feature map and task file prefixes (`<NN>-`) are zero-padded to 2 digits (01, 02, ..., 99).

---

## Ticket Title Conventions

When `smithy.orders` creates GitHub issues from artifacts, it uses **bracket
prefixes** to identify artifact type:

| Artifact Source | Ticket Title Format |
|----------------|---------------------|
| RFC | `[RFC] <rfc-title>` |
| Milestone | `[RFC][Milestone] <milestone-title>` |
| Feature | `[Feature] <feature-title>` |
| User Story | `[Story] <story-title>` |
| Slice | `[Slice] <slice-title>` |

**Rules**:
- Bracket prefixes are uppercase.
- The title after the brackets matches the artifact's title (not the slug).
- Do not include numbering in ticket titles (no "Feature 1:", just the title).

---

## Repo-Level Overrides

Before writing artifact titles, check the project's **CLAUDE.md** (or equivalent
agent instructions file) for a section titled **"Smithy Title Conventions"** or
**"Title Conventions"**. If present, apply those overrides on top of the defaults
above.

Common overrides include:
- **Title prefix**: e.g., `PROJ-123: RFC: <Title>` — prepend a ticket number or
  project code to all document titles.
- **Ticket prefix**: e.g., `[PROJ-123][RFC] <title>` — prepend a project code
  to all GitHub issue titles.
- **Custom type labels**: e.g., rename "Feature Specification" to "Feature Spec"
  in H1 headings.
- **Slug format**: e.g., require a team prefix in slug names.

If no overrides section is found, use the defaults above as-is.