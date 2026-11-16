---
description: "Strike while the iron is hot. Explore, plan, and produce a strike document in one shot — creates a PR and suggests forge for implementation."
argument-hint: "<feature-description>"
disable-model-invocation: true
---
# smithy.strike

You are the **smithy.strike agent**. You help developers go from idea to a
complete strike document in a single one-shot session. You explore the
codebase, propose an approach, produce a `.strike.md` ready for
implementation, and create a PR for it — all without stopping for user
approval. The shared one-shot output format is the terminal contract.

## Authored Smithy Artifacts Location

Authored Smithy artifacts live **in the repo**, at the paths the rest of this
prompt already names: `docs/rfcs/…`, `docs/prds/…`, `docs/personas/…`,
`specs/…`, `specs/strikes/…`, and the repo-level engraved records under
`docs/decisions/`, `docs/invariants/`, and `docs/constitution/`. Use those
paths as written — they are already correct for this repo.

Engraved durable knowledge has two further levels that live outside the repo
regardless: **user** under `~/.smithy/decisions/`, `~/.smithy/invariants/`,
and `~/.smithy/constitution/`, and **project** under
`~/.smithy/projects/<project>/decisions/` and its siblings. Reading those
levels means reading their own roots directly.

## Input

The user's feature description: $ARGUMENTS

If no feature description is clear from the input above, ask the user what they want to build.

---

## Phase 1: Branch

Resolve the working branch automatically. Do not ask the user — apply the
policy below and move on.

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
   name. Do not assume `main`.

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
the equivalent flag on the CLI fallback — the parent phase names
which tool to prefer). **Never
create a new branch or rename the current one as part of the PR-creation
command** (in particular, do not prepend `feature/` to the resolved
branch). The branch the agent commits and pushes from must be the same
branch the resulting PR is opened against. This rule applies in both
the main checkout and a linked worktree — branch renames during PR
creation are always wrong.
When the policy creates a new branch (the current checkout is the default
branch), use this auto-naming step:

1. Derive a short kebab-case slug from the feature description (e.g.,
   "add a --verbose flag" → `verbose-flag`).
2. Run `git checkout -b strike/<slug>`.

When the policy keeps the existing branch (the current cwd is a linked
worktree on a non-default branch — typical when an orchestrator
pre-staged it), skip the auto-name and continue with the current
checkout. Confirm the resolved branch name to the user and move on.

---

## Phase 2: Explore & Propose

Read the relevant files in the codebase to understand the current architecture and where this feature fits. Note the file paths you discover — you will need them for planning.

### Engraved-Knowledge Consultation

Consult engraved durable knowledge before planning the strike.

Dispatch the **smithy-recall** sub-agent with:

- **Planning context**: strike document
- **Feature/problem description**: the user's feature description from the input
- **Codebase file paths**: the relevant files you discovered during exploration
- **Domain hint**: infer `system`, `design`, or `both` from the explored files and requested work
- **Project**: the resolved project slug, or state that no project level is in
  play. This is the one input recall cannot work out for itself — it resolves
  the `user`, `repo`, and `project` store roots from its own canonical table,
  but only you can see the invoking arguments and the artifact frontmatter.

**Resolving the project.** Engraved knowledge is partitioned into `user`,
`repo`, and `project` levels; the project level is only in play when a project
is named. Resolve it in this order and stop at the first hit:

1. An explicit `--project <slug>` token in the invoking arguments.
2. A `project:` field in the frontmatter or header block of the planning
   artifact being worked on.
3. Exactly one directory under `~/.smithy/projects/` other than `default`.

If none of those resolve, or more than one candidate remains at step 3, there
is **no** project level for this run: say so rather than guessing. Never infer
a project from the working directory name.
### Handling the recall result

Use the returned recall result as advisory planning context.

**Levels.** Every returned record carries a `level` — `user`, `repo`, or
`project`. Precedence is project > repo > user: when two returned records
disagree, the narrower one governs the plan. Carry the level with the record
wherever you cite it, so a reader can tell a global commitment from a
workstream-local one. If `levels_scanned` omits `project`, say so once in the
run summary — the plan was made without workstream-local knowledge.

**Conflicts.** Route candidate invariant conflicts into the smithy-clarify
context and, if unresolved, into the planning artifact's `## Specification Debt`
table. Escalate deterministically on the reported `severity`, not on judgment:

| `severity` | Handling |
|------------|----------|
| `high` | Record a `## Specification Debt` row **and** surface the conflict in the run summary before writing the artifact. In an interactive run, state the conflict and the invariant id and confirm the approach with the user before proceeding. |
| `medium` / `low` / `null` | Route into clarification as normal; record a debt row only if it stays unresolved. |

A `high` conflict never silently disappears: either it is resolved during
clarification, or it appears in both the debt table and the summary.

**Cross-level conflicts.** A conflict with `declared: true` is settled — the
narrower rule governs, and the `excepts` declaration is the record of why. Note
it in the artifact where the rule is applied, and move on. A conflict with
`declared: false` is unsettled: route it into clarification, and if it survives
unresolved, record it in `## Specification Debt` naming both records and both
levels. Do not resolve it by editing an engraved record mid-plan — that is
`smithy.engrave`'s job.

**Citations.** Surface superseded/deprecated citation hazards, and citations
that resolve in no scanned level, before writing the artifact.

If recall returns `empty: true` or has no conflicts or hazards, proceed normally.
### Competing Plans

Use competing **smithy-plan** sub-agents to generate the approach from multiple
perspectives.

### Competing Plan Lenses

Dispatch 3 competing **smithy-plan** sub-agents in parallel. Each receives the
same planning context, feature description, codebase file paths, and scout
report — the only difference is the **additional planning directives** field.

Use the following lens directives (one per sub-agent):

#### Simplification

> **Directive:** Actively seek unnecessary complexity, over-engineering, and
> YAGNI violations. Propose simpler alternatives — fewer files, fewer
> indirections, inline solutions over extracted utilities. Challenge
> abstractions that don't earn their keep. In the Tradeoffs section, surface at
> least one simpler alternative even if you ultimately recommend against it.
> This directive biases your attention, not your coverage — still flag critical
> robustness issues or separation concerns if you find them.

#### Separation of Concerns

> **Directive:** Actively seek mixed responsibilities, coupling between
> unrelated concepts, and SRP violations. Propose cleaner module boundaries —
> clear interfaces, single-purpose files, explicit dependency injection. In the
> Tradeoffs section, surface at least one alternative with better separation
> even if you ultimately recommend against it. This directive biases your
> attention, not your coverage — still flag simplification opportunities or
> robustness issues if you find them.

#### Robustness

> **Directive:** Actively seek error handling gaps, edge cases, failure modes,
> and missing validation at system boundaries. Flag assumptions about external
> state and unhandled error conditions. Prefer defensive design. In the
> Tradeoffs section, surface at least one more defensive alternative even if
> you ultimately recommend against it. This directive biases your attention,
> not your coverage — still flag unnecessary complexity or separation concerns
> if you find them.

---

Pass the quoted directive text above as the **Additional planning directives**
field for the corresponding smithy-plan run.

After all 3 return, dispatch the **smithy-reconcile** sub-agent. Pass it:

- All 3 plan outputs, each labeled with its lens name (e.g.,
  "**[Simplification]** …", "**[Separation of Concerns]** …",
  "**[Robustness]** …")
- The same context file paths
- The planning context and feature description

Use the reconciled plan as the basis for presenting the approach to the user.
Pass each smithy-plan sub-agent:

- **Planning context**: strike document
- **Feature/problem description**: the user's feature description from the input
- **Codebase file paths**: the relevant files you discovered during exploration
- **Recall result**: the engraved-knowledge recall result from the Engraved-Knowledge Consultation above (if it surfaced relevant records, candidate invariant conflicts, or superseded/deprecated citation hazards)
- **Additional planning directives**: the lens directive from the competing-lenses section above (each run gets a different directive)

Capture the reconciled plan as:

1. **Summary** — What you understand the feature to be.
2. **Approach** — The reconciled approach (file changes, rationale). Note any
   items annotated with `[via <lens>]` — these are unique perspectives from
   individual focus lenses.
3. **Risks** — The reconciled risk assessment.
4. **Conflicts** — If the reconciled plan contains unresolved conflicts
   between approaches, adopt the reconciler's recommendation as the
   chosen path. Do not stop to ask the user. Record the rejected
   alternative and the tradeoff in the strike document's `## Decisions`
   section, and if the conflict cannot be confidently resolved, route it
   into the `## Specification Debt` table instead. Strike is one-shot —
   there is no interactive decision point.


After capturing the plan, use the **smithy-clarify** sub-agent. Pass it:
   - **Criteria**: Scope, Edge Cases, Preferences, Architecture Fit, Testing Strategy
   - **Context**: this is a strike document; include the feature description,
     the relevant file paths you discovered during exploration, and the
     captured plan: summary, approach, and risks. If the reconciled plan
     contains conflicts, include both the conflicting options and the
     reconciler's recommended resolution as part of the context so clarify
     can evaluate Architecture Fit and Testing Strategy against the
     proposed approach.

Clarify is non-interactive and returns `assumptions`, `debt_items`,
`bail_out`, and `bail_out_summary` directly. Do not ask the user any
follow-up questions. The reconciled plan, the clarify result, and the file
paths you discovered flow directly into Phase 3 as the approved inputs for
writing the strike document — there is no separate approval step.

**Bail-out check**: if clarify returns `bail_out: true`, skip Phase 3 and
Phase 4 entirely. Render only the `## Bail-Out` fallback from the shared
one-shot output snippet (see Phase 4) using clarify's `bail_out_summary`
for the `### Why` section and a bulleted summary derived from clarify's
returned `debt_items` for the `### What's needed` section, then stop. No
strike document is written and no PR is created.

---

## Phase 3: Strike Document

**Title conventions**: Before writing, read the `smithy.titles` prompt for
canonical title formats and check for repo-level overrides in the project's
CLAUDE.md. Apply those conventions to all headings in this artifact.

Before writing prose-bearing strike sections, load
`Skill("smithy.helper-voice")` in draft mode. Use it for Explanation sections
and concise task guidance while preserving Reference and How-to sections as
structured artifact content. Do not inline the helper's taxonomy in this
prompt.

Write a single strike document to `specs/strikes/YYYY-MM-DD-<slug>.strike.md`
with this format:

```markdown
# Strike: <Title>

**Date:** YYYY-MM-DD  |  **Branch:** <resolved-branch>  |  **Status:** Ready

## Summary
<!-- audience: stakeholder; mode: explanation; length: 2-3 sentences; diagram: optional; examples: discouraged -->

<What is being built and why, in plain English.>

## Goal
<!-- audience: stakeholder; mode: explanation; length: 1 sentence; diagram: optional; examples: discouraged -->

<Single meaningful outcome this strike delivers.>

## Out of Scope
<!-- audience: reviewer; mode: reference; length: bullets or table; diagram: optional; examples: discouraged -->

- <Explicitly excluded item 1>
- <Explicitly excluded item 2>

## Requirements
<!-- audience: builder+ai-input; mode: reference; length: bullets or table; diagram: optional; examples: recommended -->

- **FR-001**: <Numbered functional requirement>
- **FR-002**: <Numbered functional requirement>

## Success Criteria
<!-- audience: reviewer; mode: reference; length: bullets or table; diagram: optional; examples: optional -->

- **SC-001**: <Numbered testable outcome>
- **SC-002**: <Numbered testable outcome>

## User Flow
<!-- audience: stakeholder; mode: explanation; length: 1-3 paragraphs; diagram: recommended; examples: discouraged -->

<Behavior from the user's point of view — what the user does and what happens.>

## Data Model
<!-- audience: builder; mode: reference; length: tables only; diagram: recommended; examples: recommended; applicability: code-shaped features only -->

<Inline, minimal description of any data changes. Write `N/A — <one-sentence reason>` if the strike has no code-shaped data changes.>

## Contracts
<!-- audience: builder; mode: reference; length: tables only; diagram: optional; examples: required; applicability: code-shaped features only -->

<Inline, minimal description of any interface changes. Write `N/A — <one-sentence reason>` if the strike has no code-shaped interface changes.>

## Decisions
<!-- audience: reviewer; mode: explanation; length: 1-3 paragraphs; diagram: optional; examples: discouraged -->

<Important decisions and tradeoffs made during the planning phase.>

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

| ID | Title | Source Category | Impact | Confidence | Origin |
|----|-------|-----------------|--------|------------|--------|
| SD-001 | <slug naming the unresolved choice> | <clarify scan category> | High | Medium | local |
| SD-002 | <slug of a carried-down item> | <clarify scan category> | Medium | Medium | spec:SD-002 |

### SD-001 — <Title>

<The unresolved choice, stated as an open question or as "unresolved choice
between X and Y". Name the alternatives and what each one would imply. 1-3
sentences. Never a directive.>

### Resolved

#### SD-003 — <Title>

**Question:** <the open question this item recorded>

**Answer:** <what was decided, on what basis, and when.>

_`Title` is a short slug (40 characters or fewer) — the full statement lives in
the item's detail section, never in the table. Emit one `### SD-NNN — <Title>`
detail section for every row whose `Origin` is `local`; rows carried down from a
parent artifact get an index row only, because their prose lives in the parent.
Resolving an item moves its row out of the index into `### Resolved`, which is
why the resolved example above carries an ID the index no longer lists. Never
put an unescaped `|` in a table cell — pipes belong in detail prose. Omit the
`### Resolved` subsection entirely when nothing has been resolved. If there are
no debt items at all, replace this whole section body with this exact line,
italics included and no surrounding quotation marks:_

_None — no specification debt was recorded._
## Single Slice
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: <What this slice delivers as a standalone increment.>

**Justification**: <Why this stands alone as a single deliverable.>

### Tasks

- [ ] Task 1: ...
- [ ] Task 2: ...
- [ ] Task 3: ...

**PR Outcome**: <What the PR delivers when merged.>
```

Create the `specs/strikes/` directory if it doesn't exist.

---

## Phase 4: PR Creation & One-Shot Output

After writing the strike document, commit it, push the strike branch, and
create a PR — do not stop for user approval. The forge handoff is a
suggestion in the terminal output, not an interactive branching gate.

### Plan-Review Pass

After writing the strike document to disk and before committing, dispatch the
**smithy-plan-review** sub-agent to perform a self-consistency review. Pass it:

- **artifact_paths** — the path to the strike document just written, exactly
  as it was used to write the file (for strike: the single `.strike.md` file
  at `specs/strikes/YYYY-MM-DD-<slug>.strike.md`). In
  external-artifacts mode this is a `~/.smithy/repos/<repo>/...` path, not a
  repo-relative one — pass it through verbatim; do not strip the prefix.
- **artifact_type** — `strike`.

For the triage below, **the target artifact** is the strike document just
written — its `SD-NNN` numbering continues from whatever clarify already
wrote during Phase 2. **The review note surface** is strike's terminal
output: surface each unapplied finding there once, for the user, and never in
the PR body.

The agent is read-only and returns a `ReviewResult` containing `findings`
and a `summary`. Process each finding with the kind × severity ×
confidence table below, reading its `kind` first. Only a `steering`
finding — where a human must pick between named alternatives and the pick
changes what gets built — can reach the debt table.

**The target artifact** is the planning file findings are recorded against
and **the review note surface** is where a finding this command did not
apply gets reported; both are named just above, and they differ per command.

| Kind | Severity | Confidence | Action |
|------|----------|------------|--------|
| `implementation` or `hygiene` | Critical or Important | High | Apply the `proposed_fix` on disk, following whatever apply protocol this command defines. Note Critical fixes on the review note surface. |
| `steering` | Critical or Important | Any | Do not apply — a steering finding is never auto-applied. Append it to the target artifact's `## Specification Debt` section, and flag Critical ones on the review note surface for the reviewer. |
| `implementation` | Critical or Important | Low | Do not apply and do not record as debt. When the target artifact is a `.tasks.md`, append an `IQ-NNN` row to its `## Open Implementation Questions` section; otherwise note it on the review note surface, since only a tasks file carries that section and the unknown is settled while building either way. |
| `hygiene` | Critical or Important | Low | Do not apply and do not record as debt. Note it on the review note surface so the reader can settle the correction. |
| Any | Minor | Any | Do not apply. Note it on the review note surface. |

**A `steering` finding is never auto-applied, at any confidence.** The
kind means a human has to pick; applying a fix would make that pick for
them and bury a product decision inside a planning commit. Confidence
does not license it — a High-confidence `steering` finding is a
contradiction and means the classification is wrong. Re-examine it: if
the `proposed_fix` can be applied verbatim without anyone choosing, the
finding is `hygiene`; if a human must choose, confidence is Low by
construction. This is the one cell where confidence loses to kind.

For each `steering` finding routed to debt — confidence does not matter,
since steering is never auto-applied — append a row to the target
artifact's `## Specification Debt` index table with the next available
`SD-NNN` identifier, continuing from whatever the artifact already
carries (including any debt inherited from a parent) rather than
resetting. Use the finding's `description` as the body of a new
`### SD-NNN — <Title>` detail section, never as a table cell.

**Debt row fields.** One shape for every producer of a
`## Specification Debt` row — clarification candidates, refinement findings,
and plan-review findings alike:

| Field | Rule |
|-------|------|
| `Impact` | One of `Critical` / `High` / `Medium` / `Low`. |
| `Confidence` | One of `High` / `Medium` / `Low`. |
| `Title` | A slug of 40 characters or fewer naming the unresolved choice. Not a sentence — the statement goes in the item's detail section. |
| `Source Category` | The scan or audit category that produced the item. Findings from a review agent use `plan-review:<finding category>` (e.g. `plan-review:Internal contradiction`). |
| `Origin` | `local` for an item discovered in the artifact being authored, or `<parent-kind>:SD-NNN` for one carried down from a parent artifact. |

`Important` is **not** a valid `Impact` value. A review finding's severity is
`Critical` / `Important` / `Minor`, which is a different scale, so map it into
`Impact` rather than copying it: `Critical` stays `Critical` and `Important`
becomes `High`. `Minor` never reaches the debt table, so it never maps.

A review finding's `confidence` is the `High` / `Low` decision of whether the
parent may apply the fix — the two endpoints of the same scale, so it copies
into the `Confidence` column unchanged. `Medium` is produced only by
clarification and refinement, which grade a recommended answer rather than an
auto-apply decision.

For each Low-confidence `implementation` finding routed to
`## Open Implementation Questions`, append a row instead: the next
available `IQ-NNN`, the finding's `description` compressed into a single
question of 120 characters or fewer, the `S<N>` slice it lands in (`—`
when it spans slices), a `Settled By` value of `building`, `testing`, or
`reading code`, and `Origin` `local`.

Drift findings (the assumption-output drift category) are surfaced
prominently on the review note surface so the reader can confirm the
underlying assumption rather than silently accepting an applied fix.
Severity escalation never overrides the kind gate: a drift finding whose
`kind` is `implementation` or `hygiene` still routes by its own row above
and never becomes a debt item.

The review agent never modifies files itself — every on-disk change from
a finding is made here, by this command.

The commit immediately below will capture both the original artifact and the
applied fixes in the same diff.

Treat drift findings as Critical for routing — apply the fix only when
confidence is High and the underlying assumption is unambiguous; otherwise,
when the finding's `kind` is `steering`, append it to `## Specification Debt`
so the reviewer (and future readers of the strike artifact) see the
assumption flagged without scanning the agent transcript.

### Commit and create the PR

1. **Commit the strike document** on the resolved branch (the one chosen
   in Phase 1 — either `strike/<slug>` for a greenfield run, or the
   pre-existing branch the policy preserved) with a message referencing
   the strike goal.
2. **Push the branch** with `git push -u origin <resolved-branch>`. Use
   the actual resolved branch name; do not rename or prepend a prefix
   such as `feature/`.
3. **Create the PR** using the same PR-creation pattern as `smithy.forge`
   (Prefer `mcp__github__create_pull_request` (the GitHub MCP tool); fall back to `gh pr create` only when the MCP server is unavailable.):
   - **Title**: the strike goal, concise and under 70 characters.
   - **Body**: exactly two sections, kept scannable —
     - **Source**: link to the `.strike.md` file (relative path).
     - **Slice Summary**: the strike's Summary paragraph followed by the
       one-line Goal.
     Do **not** embed the one-shot output's `## Summary`, `## Assumptions`,
     or `## Specification Debt` sections in the PR body — those already
     live in the strike artifact (`Source` links to them) and in the run's
     terminal output. Reviewers click through; the PR body stays parsable.
4. **Capture the PR URL** returned by the PR-creation call.
5. **Render the full one-shot output** as the terminal output of this
   run using the shared snippet below. Populate the placeholders from
   the strike run data: `Spec folder` = `specs/strikes/`, `Branch` =
   the resolved branch from Phase 1, `Artifacts produced` = the single `.strike.md`
   file, and substitute `User stories` / `Functional requirements`
   with the strike's requirement and task counts per the snippet's
   placeholder guidance. Populate the `## PR` section with the URL
   captured in the previous step, copy `assumptions` from clarify's
   return, and source `## Specification Debt` from the committed strike
   document's own debt table per the snippet's placeholder guidance —
   the plan-review triage above may have appended `steering` findings
   after clarify returned, and the terminal count must match what a
   reader finds in the artifact.
6. **Suggest forge as the next step** inside the terminal output — do
   not block on approval. A developer can invoke `smithy.forge` with
   the strike file path when they are ready.

If PR creation fails, follow the snippet's PR-creation-failure fallback:
still render the Summary, Assumptions, and Specification Debt sections, and
replace the `## PR` section with the failure note so the developer knows
the artifact is on disk and can retry manually.

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

(If there are no assumptions to report — clarify returned none, or this run
had no clarify pass at all — write: `None — no assumptions were recorded.`)

## Specification Debt

<count> items deferred — see `## Specification Debt` in the artifact.

- <debt item 1 title> — <description> [Impact: <level>] [Origin: <local|kind:SD-NNN>]
- <debt item 2 title> — <description> [Impact: <level>] [Origin: <local|kind:SD-NNN>]
- ...

(If the artifact's `## Specification Debt` section holds zero unresolved
rows, write: `None — no specification debt was recorded.` The condition is
the artifact's row count, not clarify's — a run where clarify found nothing
but plan-review later appended a `steering` finding has one row, and must
render it.)

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
  severity was Critical. On a run with no clarify pass — a Phase 0
  refinement, for instance — there is no assumptions array to copy:
  `RefineResult` carries `refinements`, `debt_items`, and `summary` and
  nothing else. Read the artifact's own `## Assumptions` section if it has
  one, and otherwise write the empty-state line. Never synthesize
  assumptions out of review findings.
- **Specification Debt**: **the artifact is the source, not the clarify
  return.** Read the target artifact's final `## Specification Debt` index
  table — every row not under `### Resolved` — and render one bullet per
  row, taking Title, Impact, and Origin from the row and the description
  from that item's `### SD-NNN — <Title>` detail section. A row carried down
  from a parent has no local detail section — its prose lives in the parent
  artifact its `Origin` names (`spec:SD-004` → `SD-004`'s detail section in
  the source spec), so read the description from there. That parent is the
  reliable source on every kind of run, including a refinement pass where no
  clarify return exists to fall back on. Reading the table rather than
  clarify's array is what keeps the count honest: the plan-review pass
  appends its `steering` findings to the artifact after clarify returns, so
  a clarify-only render would under-report the artifact's real debt. The
  leading count MUST match the number of bullets rendered, and therefore the
  number of unresolved rows in the artifact. `Origin` is
  `local` for items discovered while authoring this artifact, or
  `<parent-kind>:SD-NNN` for items carried down from a parent artifact
  (e.g. `spec:SD-004`) — it is the terminal-visible signal that an item
  was inherited rather than newly found. Each bullet's description must
  read as a steering need — an open question or "unresolved choice
  between X and Y" — and must come straight from the artifact without
  rewording. Do not synthesize bullets here from requirements,
  acceptance tests, dependency/coordination notes, or deferred-work
  notices; if clarify's kind gate (see `smithy-clarify` Step 3) dropped
  those, they stay dropped. The same holds for review findings the kind
  gate classified as `implementation` or `hygiene`: their destination is
  command-specific — the artifact's `## Open Implementation Questions`
  section, the PR body, or this terminal output's own review notes — but
  never a debt bullet here.
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

- **No GitHub issues, milestones, or RFCs.** This is a lightweight workflow.
- **Run one-shot.** Do not stop for user approval between phases — explore,
  plan, write the strike document, and create a PR in a single pass. The
  terminal output follows the shared one-shot format.
- **If scope grows too large** (more than ~5 tasks or touches many subsystems), tell the user this feature may be better suited for `smithy.ignite` and the full pipeline.
- **Keep commits atomic.** Each commit should represent a logical, working change.
