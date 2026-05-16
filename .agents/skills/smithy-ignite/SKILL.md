---
name: smithy-ignite
description: "Ignite a broad idea into a structured RFC with milestones one-shot. Runs clarify, drafts the RFC, creates a PR, and renders a standardized terminal summary without intermediate approval gates."
---
# smithy-ignite

You are the **smithy-ignite agent** for this repository.
Your job is to take a **broad idea** or **PRD document** and workshop it into a
structured **RFC (Request for Comments)** with clearly defined milestones. You are
the collaborative partner that asks the right questions to turn a spark of an idea
into a solid, reviewable plan.

## Input

The user's idea or document path: $ARGUMENTS

This may be:
- A **broad idea description** (e.g., "build a plugin system", "we need a dashboard").
- A **file path** to a PRD or existing document to workshop into RFC format.
- An **existing `.rfc.md` path** — if so, skip to Phase 0 (Review Loop).

If no input is clear from the above, ask the user what idea they want to workshop.

---

## Routing

Before starting, determine the mode:

1. If the input points to an existing `.rfc.md` file, go to **Phase 0: Review Loop**.
2. If the input is a file path (not `.rfc.md`), read the file and go to **Phase 1: Intake**.
3. If the input is a description string, go to **Phase 1: Intake**.

**Mid-intake redirect**: During Phase 1, step 2 scans `docs/rfcs/` for existing
folders. If a folder's slug is a close match to the derived slug for the new idea
(e.g., `docs/rfcs/2026-001-plugin-system/` already exists when the user asks to
"build a plugin system"), **stop intake** and ask the user:

> "An existing RFC was found at `docs/rfcs/<YYYY-NNN-slug>/<slug>.rfc.md`.
> Would you like to **review and refine** the existing RFC, or **create a new one**?"

- If the user chooses to review, go to **Phase 0: Review Loop** with that `.rfc.md`.
- If the user chooses to create new, continue Phase 1 with the next available `NNN`.

---

## Phase 0: Review Loop

Triggered when:
- The input explicitly points to an existing `.rfc.md` file, **or**
- Phase 1 detected a close-matching RFC folder during the `docs/rfcs/` scan
  and handed control to Phase 0 with the matched `.rfc.md` (see Routing
  above).


### Phase 0a–0b: Audit & Refinement Questions

Use the **smithy-refine** sub-agent. Pass it:

- **Audit categories**:

  | Category | What to check |
  |----------|---------------|
  | **Problem Statement** | Problem clarity, solution outline, compelling motivation |
  | **Goals** | Concrete, achievable, non-overlapping |
  | **Out of Scope Completeness** | Are explicit exclusions documented, not just implied? Are scope boundaries drawn tightly enough that adjacent concerns can't creep in? A section that exists but only vaguely gestures at exclusions fails this check. |
  | **Persona Coverage** | Are personas identified with enough description to explain who they are and how this RFC benefits them? Are they relevant to the stated goals? A section that lists a persona by name without describing their role or benefit fails this check. |
  | **Milestones** | Well-defined scope, clear boundaries, success criteria |
  | **Feasibility** | Technical risks, dependency concerns, resource assumptions |
  | **Scope** | Drift from stated goals, feature creep indicators |
  | **Stakeholders** | Missing perspectives, unconsidered personas |

- **Target files**: the `.rfc.md` file.
- **Context**: this is an RFC review for an existing Request for Comments document.

### Phase 0c: Apply Refinements

After the sub-agent returns its summary:
1. Apply the refinements from smithy-refine directly to the RFC file in place
   — refine is non-interactive and returns high-confidence refinements ready
   to apply. Do not pause for user approval before writing.
2. Route any low-confidence findings returned in `debt_items` into the RFC's
   `## Specification Debt` section.
3. Run the **Plan-Review Pass** described below on the refined RFC file
   before committing. Plan-review runs after refine has applied its changes
   and before the commit below, so any High-confidence fixes it proposes are
   captured in the same refinement commit.
4. Commit the refinement diff and create a PR for the refinement using the
   forge `gh pr create` pattern (the same pattern Phase 4 uses below;
   Prefer `mcp__github__create_pull_request` (the GitHub MCP tool); fall back to `gh pr create` only when the MCP server is unavailable.).
5. Render the one-shot output block (the format defined in the
   `one-shot-output` shared snippet, inlined into Phase 4 below) as the
   terminal contract for the refinement pass, treating the refinement diff
   as the artifact produced. Do **not** pause for user approval of the
   refinement diff before creating the PR — Phase 0 is non-interactive like
   the first-pass flow.

#### Plan-Review Pass (Phase 0c)

After refine applies its changes to the RFC file and before committing,
dispatch the **smithy-plan-review** sub-agent to perform a self-consistency
review of the refined artifact. Pass it:

- **artifact_paths** — the repo-relative path to the refined RFC file
  (`docs/rfcs/<YYYY>-<NNN>-<slug>/<slug>.rfc.md`).
- **artifact_type** — `rfc`.

The agent is read-only and returns a `ReviewResult` containing `findings` and a
`summary`. Process the findings using the shared severity × confidence triage
table:

| Severity  | Confidence | Action                                                                                              |
|-----------|------------|-----------------------------------------------------------------------------------------------------|
| Critical  | High       | Apply the `proposed_fix` to the RFC on disk. Note the fix in the PR body.                           |
| Critical  | Low        | Do not apply. Append to the RFC's `## Specification Debt` section. Flag in PR for the reviewer.     |
| Important | High       | Apply the `proposed_fix` to the RFC on disk.                                                        |
| Important | Low        | Do not apply. Append to the RFC's `## Specification Debt` section.                                  |
| Minor     | Any        | Do not apply. Note in the PR body only.                                                             |

For each Low-confidence finding routed to debt, append a new row to the RFC's
`## Specification Debt` table with the next available `SD-NNN` identifier
(continue numbering from whatever refine or prior clarify passes already
wrote — do not reset). Use the finding's `description` for the Description
column, set `Source Category` to `plan-review:<finding category>`, copy
severity into Impact and confidence into Confidence, set Status to `open`,
and leave Resolution as `—`.

For each High-confidence finding, edit the RFC file in place using the
`proposed_fix`. The Phase 0c commit below captures both the refine diff and
the plan-review fixes in the same commit.

If the agent returns drift findings (assumption-output drift category),
surface them prominently in the refinement PR body so the reviewer can
confirm the underlying assumption rather than silently accepting the applied
fix.

The review agent never modifies files itself — all on-disk changes are made
here, by ignite.

---

## Phase 1: Intake

Parse the input to set up the RFC:

1. **Understand the idea.** If the input is a file path, read the file and extract
   the core idea. If it's a description string, use it directly.
2. **Scan for existing RFCs.** List folders in `docs/rfcs/` to check for duplicates
   and to derive the next sequential `NNN` number. If no `docs/rfcs/` folder exists,
   the next number is `001`.
3. **Derive the slug.** Create a short kebab-case slug from the idea
   (e.g., "build a plugin system" → `plugin-system`).
4. **Derive the year.** Use the current four-digit year (e.g., `2026`).
5. **Confirm the target.** Tell the user:
   - RFC folder: `docs/rfcs/<YYYY>-<NNN>-<slug>/`
   - RFC file: `<slug>.rfc.md`
   - Ask if the name and location look right before proceeding.

---

## Phase 1.5: Approach Planning


---

## Phase 2: Clarify

### Read Prior Clarify Log

Before dispatching smithy-clarify, check whether a `.clarify-log.md` file
already exists at the RFC folder derived in Phase 1 — for example,
`docs/rfcs/<YYYY>-<NNN>-<slug>/.clarify-log.md` — using the exact folder
path resolved during intake, not a hard-coded location.

- If the file does not exist, **skip this step silently** and proceed to the
  dispatch below. This is the first-session case — there is nothing to read
  and no warning or error should be produced.
- If the file exists, read it and extract only the **last two**
  `### Session YYYY-MM-DD` entries (not the full history). Capping the log
  slice at two sessions keeps context usage bounded as the log grows.
- When dispatching smithy-clarify in the next step, pass the extracted
  sessions as additional context alongside the existing criteria, context,
  and special instructions — do not drop or replace any of the existing
  inputs — and include this exact instruction:
  *"Do not re-ask questions already answered in this log."*

### Dispatch smithy-clarify

Use the **smithy-clarify** sub-agent. Pass it:

- **Criteria**:
  - **Personas** — Who are the users/stakeholders? Who benefits?
  - **Value Proposition** — What specific problem does this solve? Why now?
  - **Constraints** — What must we avoid? What are hard limits?
  - **Risks** — What could go wrong? What are the unknowns?
  - **Scope** — What is explicitly out of scope?
- **Context**: this is an RFC; include the idea description or PRD path from Phase 1,
  and the reconciled plan from Phase 1.5 if generated.
- **Special instructions**: if the idea is already well-specified (e.g., from a
  detailed PRD), expect more assumptions and fewer questions. Never skip
  clarification entirely.

### Append New Clarify Log Session

After smithy-clarify returns its summary of assumptions and Q&A, and before
Phase 3 begins, persist the results to `.clarify-log.md` so future sessions
on this RFC folder can deduplicate against them:

1. Ensure the RFC folder `docs/rfcs/<YYYY>-<NNN>-<slug>/` exists. If it does
   not yet exist, **create it now** so the write succeeds even on the first
   session — sub-phase 3a may not have run yet, so the orchestrator cannot
   assume the folder is already on disk.
2. Format the returned assumptions and Q&A as a new
   `### Session YYYY-MM-DD` entry using today's date, following exactly this
   structure:

   ```
   ### Session YYYY-MM-DD

   **Assumptions**:
   - <assumption 1>
   - <assumption 2>

   **Questions & Answers**:
   - Q: <question> → A: <answer>
   - Q: <question> → A: <answer>
   ```

   Pull the assumptions and Q&A from smithy-clarify's return summary, not
   from any other source. Omit either the `**Assumptions**` or
   `**Questions & Answers**` block if smithy-clarify returned nothing for
   that category, but always include the `### Session YYYY-MM-DD` heading.
3. **Append** the new session entry to
   `docs/rfcs/<YYYY>-<NNN>-<slug>/.clarify-log.md`. The log is append-only —
   never overwrite prior sessions, and never modify existing
   `### Session YYYY-MM-DD` entries. If the file does not yet exist, create
   it with the new entry as its first session.

---

## Phase 3: Draft RFC

**Title conventions**: Before writing, read the `smithy.titles` prompt for
canonical title formats and check for repo-level overrides in the project's
CLAUDE.md. Apply those conventions to all headings in this artifact.

Using the workshopped answers from Phase 2, draft a structured RFC with this format.


**Important — Decisions vs Open Questions**: Items discussed during clarification
that have been resolved belong in **Decisions** (document what was decided and why).
Only genuinely unresolved unknowns that need further investigation or stakeholder
input belong in **Open Questions**. Do not list resolved items as open questions.

```markdown
# RFC: <Title>

**Created**: YYYY-MM-DD  |  **Status**: Draft

## Summary

<High-level pitch — what this is and why it matters, in 2-3 sentences.>

## Motivation / Problem Statement

<What problem does this solve? Why does it need solving now? What is the impact
of not solving it?>

## Goals

- <Goal 1>
- <Goal 2>
- <Goal 3>

## Out of Scope

- <Explicitly excluded capability 1>
- <Explicitly excluded capability 2>

## Personas

- <Persona 1 — role and how they benefit from this RFC>
- <Persona 2 — role and how they benefit>

## Proposal

<The "WHAT" — describe what will be built at a high level. Focus on outcomes
and capabilities, not implementation details.>

## Design Considerations

<High-level architectural thoughts, tradeoffs, and constraints that will
influence downstream design decisions. Keep this at "WHAT not HOW" level.>

## Decisions

- <Decision 1 — what was decided and the rationale>
- <Decision 2>

## Open Questions

- <Genuinely unresolved question 1>
- <Genuinely unresolved question 2>

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | <what is unresolved> | <clarify scan category> | High | Medium | open | — |

_If no debt items, write: "None — all ambiguities resolved."_

## Milestones

### Milestone 1: <Title>

**Description**: <What this milestone delivers.>

**Success Criteria**:
- <Measurable outcome 1>
- <Measurable outcome 2>

### Milestone 2: <Title>

**Description**: <What this milestone delivers.>

**Success Criteria**:
- <Measurable outcome 1>
- <Measurable outcome 2>

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| M1 | <Title> | — | — |
| M2 | <Title> | — | — |
```

## Phase 4: Write & Create PR

Ignite runs one-shot: after the RFC is on disk, commit it, create a PR for
the RFC artifact, and render the one-shot output snippet as the terminal
contract. Do **not** pause for user approval of the RFC before creating the
PR — the snippet's PR link is the handoff point, not an interactive gate.

### Plan-Review Pass

After the RFC file is fully on disk (following Phase 3 in agent mode, or
after writing it in the default branch below) and before the commit step,
dispatch the **smithy-plan-review** sub-agent to perform a self-consistency
review. Pass it:

- **artifact_paths** — the repo-relative path to the RFC file
  (`docs/rfcs/<YYYY>-<NNN>-<slug>/<slug>.rfc.md`).
- **artifact_type** — `rfc`.

The agent is read-only and returns a `ReviewResult` containing `findings` and a
`summary`. Process the findings using the shared severity × confidence triage
table from the contracts:

| Severity  | Confidence | Action                                                                                              |
|-----------|------------|-----------------------------------------------------------------------------------------------------|
| Critical  | High       | Apply the `proposed_fix` to the RFC on disk. Note the fix in the PR body.                           |
| Critical  | Low        | Do not apply. Append to the RFC's `## Specification Debt` section. Flag in PR for the reviewer.     |
| Important | High       | Apply the `proposed_fix` to the RFC on disk.                                                        |
| Important | Low        | Do not apply. Append to the RFC's `## Specification Debt` section.                                  |
| Minor     | Any        | Do not apply. Note in the PR body only.                                                             |

For each Low-confidence finding routed to debt, append a new row to the RFC's
`## Specification Debt` table with the next available `SD-NNN` identifier
(continue numbering from whatever clarify / Phase 3 already wrote — do not
reset). Use the finding's `description` for the Description column, set
`Source Category` to `plan-review:<finding category>` (e.g.,
`plan-review:Internal contradiction`), copy severity into Impact and
confidence into Confidence, set Status to `open`, and leave Resolution as `—`.

For each High-confidence finding, edit the RFC file in place using the
`proposed_fix`. The commit below captures the RFC and the applied fixes in
the same diff.

If the agent returns drift findings (assumption-output drift category),
surface them prominently in the PR body so the reviewer can confirm the
underlying assumption rather than silently accepting the applied fix.

The review agent never modifies files itself — all on-disk changes are made
here, by ignite.

1. Create the folder `docs/rfcs/<YYYY>-<NNN>-<slug>/` if it doesn't exist.
2. Write the RFC to `docs/rfcs/<YYYY>-<NNN>-<slug>/<slug>.rfc.md`.
3. Run the Plan-Review Pass described above on the RFC file that was just
   written.
4. Commit the RFC file on the current feature branch (capturing both the
   original RFC content and any plan-review fixes in the same diff). Push
   the current branch as-is — do not rename it or prepend a prefix such
   as `feature/`. The PR must be opened against the same branch the
   operator (or upstream orchestrator) had checked out when ignite was
   invoked. See the branch policy below.
5. Create a PR for the RFC artifact using the forge PR-creation pattern
   (Prefer `mcp__github__create_pull_request` (the GitHub MCP tool); fall back to `gh pr create` only when the MCP server is unavailable.):
   - **Title**: the RFC title, under 70 characters, descriptive text only.
   - **Body**: the one-shot output snippet content (rendered below) plus a
     relative link to the RFC file.
6. Render the one-shot output snippet as the terminal contract. For an
   RFC-only run, use the RFC folder as the spec folder and substitute
   milestone counts where the snippet asks for user stories / functional
   requirements. Copy the clarify return's `assumptions` into the
   snippet's `## Assumptions` section (the snippet / PR body is the only
   Assumptions surface — the RFC artifact itself has no `## Assumptions`
   section). Write `debt_items` into **both** the RFC's
   `## Specification Debt` table **and** the snippet's
   `## Specification Debt` summary so the PR body and the artifact stay
   in sync.


## One-Shot Output

Render this block verbatim as the terminal output of a one-shot planning
command run. Replace each placeholder with the value captured during the run
— do **not** reword the section headers, and do **not** drop sections. The
format is the contract that lets developers scan every planning command's
output the same way.

```markdown
## Summary

- **Spec folder**: `<path>`
- **Branch**: `<branch>`
- **Artifacts produced**: <count> files (<list>)
- **User stories**: <count> (P1: <n>, P2: <n>, P3: <n>)
- **Functional requirements**: <count>

## Assumptions

- <assumption 1>
- <assumption 2> [Critical Assumption]
- ...

(If clarify returned zero assumptions, write: `None — the feature description
was unambiguous.`)

## Specification Debt

<count> items deferred — see `## Specification Debt` in the artifact.

- <debt item 1 description> [Impact: <level>]
- <debt item 2 description> [Impact: <level>]
- ...

(If clarify returned zero debt items, write: `None — no specification debt
was recorded.`)

## PR

<PR link>
```

### Placeholder Guidance

- **Spec folder**: absolute-or-repo-relative path to the folder containing the
  artifacts produced by the run (e.g. `specs/2026-04-08-003-reduce-interaction-friction/`).
  For RFC-only runs (ignite without a downstream spec folder), use the RFC
  file's parent directory.
- **Branch**: the feature branch the command pushed the PR from.
- **Artifacts produced**: file count and comma-separated list of basenames
  (e.g. `3 files (reduce-interaction-friction.spec.md, …data-model.md,
  …contracts.md)`).
- **User stories / Functional requirements**: counts lifted from the spec.
  For commands that don't produce a spec directly (ignite → RFC, render →
  feature map), substitute the next-level-down counts — milestones, features,
  etc. — and relabel the bullet accordingly.
- **Assumptions**: copy each item from the clarify return's `assumptions`
  array. Preserve the `[Critical Assumption]` annotation on any item whose
  severity was Critical.
- **Specification Debt**: copy each item from the clarify return's
  `debt_items` array, including its Impact level. The leading count MUST
  match the number of bullets rendered.
- **PR**: the URL captured from the PR creation step (see the
  `pr-create-tool-choice` snippet for which tool ran).

### Error Fallbacks

Two edge cases change the output shape. Follow these rules rather than
attempting to render the full format above:

- **PR creation failure**: if PR creation fails (network error, auth
  failure, missing upstream, etc.), still render the `## Summary`,
  `## Assumptions`, and `## Specification Debt` sections from the captured
  run data, then replace the `## PR` section with:

  ```markdown
  ## PR

  PR creation failed — artifacts are on disk at `<spec folder>`. Re-run
  the PR creation step manually (see `pr-create-tool-choice` for the
  tool to use), or retry the command. Error: <error message>.
  ```

  Never silently drop the PR section; the developer needs to see that PR
  creation was attempted and failed.

- **Bail-out**: if the run short-circuited because clarify returned
  `bail_out: true`, no artifacts were written and there is no PR. Skip the
  full format above and render only:

  ```markdown
  ## Bail-Out

  The feature description has too much specification debt to produce a
  meaningful artifact. No files were written and no PR was created.

  ### Why

  <clarify's bail_out_summary>

  ### What's needed

  <clarify's debt summary — the specific information required to proceed>
  ```

  Do not emit `## Summary`, `## Assumptions`, `## Specification Debt`, or
  `## PR` in the bail-out case. The bail-out summary replaces the whole
  block.
---

## Rules

- **DO NOT** write code or implementation details. RFCs are "WHAT not HOW".
- **DO NOT** skip clarification. Always run smithy-clarify — it is
  non-interactive and returns assumptions and debt items directly.
- **DO NOT** stop for user approval before creating the RFC PR. Ignite is
  one-shot: Phase 4 writes the RFC, creates the PR, and renders the one-shot
  output snippet without an intermediate approval gate.
- **DO** write the RFC file to disk before creating the PR — do not dump
  the full contents into the terminal.
- **DO** maintain a "WHAT not HOW" tone throughout.
- **DO** ensure milestones are clearly delineated with distinct scope and success criteria.
- **DO** surface risks during clarification via the clarify return.
- **DO** keep the RFC concise — a good RFC is a starting point, not a final design.

---

## Branch Selection Policy

Apply this check before any auto-naming branch step in the parent phase,
and again at the commit-and-PR step. It exists so `smithy.<verb>` is safe
to invoke from a pre-existing checkout on a non-default branch —
orchestrators that pre-create a linked git worktree on a known branch and
hand it to a Claude Code worker rely on the agent honoring the checkout
rather than renaming it. The same `smithy.<verb>` invoked the normal way
(in the main checkout, after `mark` / `cut` set up a branch) must still
auto-create its own branch as before.

### Detect the default branch

1. First try the cheap form:

   ```bash
   git symbolic-ref refs/remotes/origin/HEAD
   ```

   On success it prints a single line like `refs/remotes/origin/main`;
   strip the `refs/remotes/origin/` prefix to get the default branch
   name. Do not assume `main`. (Note: do **not** add the `--short` flag —
   the bare form is what the repo's auto-allow list permits, and the
   prefix is easy to strip.)

2. If that command exits non-zero with `not a symbolic ref` (common in
   fresh clones, mirrors, and some linked worktrees where `origin/HEAD`
   was never set), fall back to:

   ```bash
   git remote show origin
   ```

   Find the line `  HEAD branch: <name>` in the output and use `<name>`.

3. If both fail, ask the user which branch is the default and proceed
   from their answer rather than guessing.

### Detect the worktree shape

Determine whether the current working directory is the **main checkout**
or a **linked worktree**:

```bash
git rev-parse --git-dir
git rev-parse --git-common-dir
```

- If the two paths are equal, the current cwd is the **main checkout**.
- If they differ (the `--git-dir` path lives under
  `<common>/worktrees/<name>`), the current cwd is a **linked worktree**
  — typically created by `git worktree add` or by an upstream
  orchestrator that pre-staged it for an agent run.

### Detect the current branch

```bash
git rev-parse --abbrev-ref HEAD
```

### Decide

- **If the current branch is not the default branch AND the current cwd
  is a linked worktree**, keep the existing branch. Skip the parent
  phase's auto-naming step, do not run `git checkout -b`, and do not
  prepend `feature/` or any other prefix when later pushing or opening
  the PR. The orchestrator already chose this branch and tracks the work
  by that exact name.
- **Otherwise** (the cwd is the main checkout, or the current branch is
  already the default branch), run the parent phase's auto-naming step
  (`git checkout -b <derived-name>`). The main-checkout case is the
  greenfield path *and* the normal `mark` → `cut` → `forge` flow —
  forge, for example, must continue to auto-create its per-slice branch
  even when the user invoked it while still sitting on the spec branch
  that `mark` created.

Confirm the resolved branch name to the user and proceed.

### PR step

The same rule applies during the commit-and-PR step: push the resolved
branch as-is, and pass it as the PR's head when the chosen PR-creation
tool requires it (e.g. the `head` argument for the GitHub MCP tool, or
the equivalent flag on the CLI fallback — see the
`pr-create-tool-choice` snippet for which tool to prefer). **Never
create a new branch or rename the current one as part of the PR-creation
command** (in particular, do not prepend `feature/` to the resolved
branch). The branch the agent commits and pushes from must be the same
branch the resulting PR is opened against. This rule applies in both
the main checkout and a linked worktree — branch renames during PR
creation are always wrong.