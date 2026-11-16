---
description: "Ignite a broad idea into a structured RFC with milestones one-shot. Runs clarify, drafts the RFC, creates a PR, and renders a standardized terminal summary without intermediate approval gates."
argument-hint: "<idea|prd-path|rfc-path>"
disable-model-invocation: true
---
# smithy.ignite

You are the **smithy.ignite agent** for this repository.
Your job is to take a **broad idea** or **PRD document** and workshop it into a
structured **RFC (Request for Comments)** with clearly defined milestones. You are
the collaborative partner that asks the right questions to turn a spark of an idea
into a solid, reviewable plan.

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

## Persona Artifact Convention

Persona files are durable, cross-RFC reference artifacts. Store them flat at
`docs/personas/<slug>.persona.md`, where `<slug>` is a
kebab-case slug derived from the persona name or role. Do not add a date or
sequence prefix. The filename slug is the stable identity for discovery and
matching; `.persona.md` files do not carry a separate machine-readable identity
key such as `slug:` or `**Role**:`, and there is no persona registry or index.

The canonical file shape is:

```markdown
# Persona: <Name/Role>

**Created**: YYYY-MM-DD

<Narrative prose describing the persona's role and context.>

<Narrative prose describing the friction they experience today.>

<Narrative prose describing how their work changes when relevant capabilities ship.>
```

Each persona file contains exactly one persona. The body is narrative prose,
not a bullet inventory, and stays reusable across RFCs rather than tied to one
solution. Persona files sit outside the `## Dependency Order` lineage: they
must not include M/F/US/S identifiers, a `## Dependency Order` section, or an
inline `## Specification Debt` table.
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

1. If the input points to an existing `.rfc.md` file, go to **Phase 0** —
   Phase 0's state-detection step now classifies the file itself and decides
   whether to review a complete RFC, resume a partial one from its first
   missing sub-phase, or treat a header-only file as fresh.
2. If the input is a file path (not `.rfc.md`), read the file and go to
   **Phase 1: Intake**.
3. If the input is a description string and no matching `docs/rfcs/` folder
   is found during intake, go to **Phase 1: Intake** as normal — this is the
   default new-idea path and Phase 1 proceeds unchanged for genuinely new
   ideas.

**Mid-intake redirect**: During Phase 1, step 2 scans `docs/rfcs/` for existing
folders. If a folder's slug is a close match to the derived slug for the new
idea (e.g., `docs/rfcs/2026-001-plugin-system/` already exists when the user
asks to "build a plugin system"), **stop intake** and hand control to
**Phase 0** with the matched `.rfc.md`. Do **not** ask the user "review or
create new" inline here — that decision is delegated to Phase 0's
state-detection step, which is now the single place that handles review,
resume, and new-RFC branching. The option to **create a new RFC instead** of
touching the existing file remains available to the user from inside Phase 0's
`partial` and `complete` branches, so nothing is lost by deferring the
decision.

---

## Phase 0: State Detection and Review Loop

Triggered when:
- The input explicitly points to an existing `.rfc.md` file, **or**
- Phase 1 detected a close-matching RFC folder during the `docs/rfcs/` scan
  and handed control to Phase 0 with the matched `.rfc.md` (see Routing
  above).

### Phase 0.0: State Detection

Before running the review loop, classify the existing RFC file to decide
whether this is a full review, a resume from partial state, or a fresh-start
header-only file.

1. Read the RFC file from disk and enumerate its `##` headings.
2. Classify the file as exactly one of three states using the
   section-to-sub-phase map below:
   - **`fresh`** — only the RFC header is present; none of the mandatory
     template `##` sections have been written yet.
   - **`partial`** — at least one but not all of the mandatory template
     sections are present.
   - **`complete`** — every mandatory template section is present.
3. Report to the user which sections are present, which are missing, and
   which state was detected.

The section-to-sub-phase map below pairs the RFC template's mandatory `##`
section headings with the sub-phase that produces each section. Use the exact
same section titles as the RFC template code fence later in this prompt.

| RFC section(s)                                    | Sub-phase |
|---------------------------------------------------|-----------|
| `## Summary`, `## Motivation / Problem Statement` | 3a        |
| `## Personas`                                     | 3b        |
| `## Goals`, `## Out of Scope`                     | 3c        |
| `## Proposal`, `## Design Considerations`         | 3d        |
| `## Decisions`, `## Specification Debt`           | 3e        |
| `## Milestones`, `## Dependency Order`            | 3f        |

### Phase 0.1: Branch on Detected State

Route the pipeline based on the classification from Phase 0.0. Each state
routes to a distinct next step:

- **`complete`** → continue into `Phase 0a–0b: Audit & Refinement Questions`
  below, exactly as before. The existing review-loop behavior for genuinely
  complete RFCs is unchanged by this branching step.
- **`partial`** → compute the **first missing sub-phase** as the lowest
  sub-phase ID (3a → 3b → 3c → 3d → 3e → 3f) whose section(s) from the map
  above are not yet present in the file. Tell the user which sections are
  present, which sections are missing, and which sub-phase the pipeline will
  resume from, then **ask the user to confirm** the resume. If the user
  confirms, hand off to **Phase 3** beginning at that first missing
  sub-phase (see the Phase 3 resume note for how the hand-off is honored).
  Do **not** re-run any earlier sub-phase — the sections already on disk are
  authoritative and must be preserved in place.
- **`fresh`** → skip the review loop entirely. Leave the existing header-only
  file on disk **untouched** (do not recreate it) and hand off to **Phase 3**
  starting at sub-phase **3a**.

From the `partial` or `complete` branch, the user may always choose to
**create a new RFC instead** rather than touching the existing file; in that
case, continue Phase 1 with the next available `NNN` so the existing file is
preserved and a fresh RFC is drafted alongside it.

**Partial RFC from a different idea.** Before resuming a `partial` file,
verify that the existing `## Summary` and `## Motivation / Problem Statement`
are contextually related to the current idea. If they are not a plausible
match for the idea the user is now igniting, warn the user explicitly and
offer exactly three options: **overwrite** the existing file (discard it and
start a fresh draft in place), **create a new RFC** in a different folder
with the next available `NNN`, or **proceed anyway** (treating the mismatch
as intentional and resuming into the existing file as-is).

**Session crash during harmonization (3g).** If the detection step classifies
a file as `complete` but its enumerated headings are inconsistent, duplicated,
or out of canonical template order — the symptom of a harmonization pass
that crashed mid-rewrite — enter the `Phase 0a–0b` review loop below so that
`smithy-refine` can identify and repair the inconsistencies.


### Phase 0a–0b: Audit & Refinement Questions

Use the **smithy-refine** sub-agent. Pass it:

- **Audit categories**:

  | Category | What to check |
  |----------|---------------|
  | **Problem Statement** | Problem clarity, solution outline, compelling motivation |
  | **Goals** | Concrete, achievable, non-overlapping. Goals describe outcomes; they MUST NOT name milestones (`M1`, `M-A`, "delivered by M-C") or use the word "milestone". Milestones realize goals, not the reverse — flag any goal that can only be stated by pointing at the milestone that delivers it. |
  | **Out of Scope Completeness** | Are explicit exclusions documented, not just implied? Are scope boundaries drawn tightly enough that adjacent concerns can't creep in? Items phrased as "deferred to M-N" or "covered by a later milestone" are in scope for this RFC and MUST NOT appear here — flag them as findings to move into the relevant milestone description. A section that exists but only vaguely gestures at exclusions fails this check. |
  | **Persona Coverage** | Are personas identified with enough description to explain who they are and how this RFC benefits them? Are they relevant to the stated goals? A section that lists a persona by name without describing their role or benefit fails this check. |
  | **No Open Questions section** | The RFC must not contain a `## Open Questions` heading. Unresolved uncertainty belongs in the `## Specification Debt` table as `SD-NNN` rows. Flag any `## Open Questions` heading as a finding to remove (translating any remaining open questions into Specification Debt rows first). |
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
2. Route the Medium/Low-confidence findings returned in `debt_items` into
   the RFC's `## Specification Debt` section. Never reword a description into a
   directive, never append rows that did not come from `debt_items`, and do
   **not** populate the section from the `## Dependency Order` table, from
   milestone deferrals, or from post-hoc resolution
   records — those have proper homes elsewhere in the RFC and the kind gate
   in `smithy-clarify` Step 3 has already filtered them out. At the RFC
   layer in particular, an empty `## Specification Debt` section is the
   common, expected outcome — write `_None — no specification debt was
   recorded._` rather than back-filling the table from coordination notes
   or future-work to make it look non-empty.
3. Run the **Plan-Review Pass** described below on the refined RFC file
   before committing. Plan-review runs after refine has applied its changes
   and before the commit below, so any High-confidence fixes it proposes are
   captured in the same refinement commit.
4. Commit the refinement diff and create a PR for the refinement using the
   forge `gh pr create` pattern (the same pattern Phase 4 uses below;
   Prefer `mcp__github__create_pull_request` (the GitHub MCP tool); fall back to `gh pr create` only when the MCP server is unavailable.).
5. Render the one-shot output block (the `## One-Shot Output` format
   defined at the end of Phase 4 below) as the
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

For the triage below, **the target artifact** is the refined RFC file — its
`SD-NNN` numbering continues from whatever refine or prior clarify passes
already wrote. **The review note surface** is the refinement PR body; a
Low-confidence `implementation` finding goes there under an **Implementation
questions** heading, since an RFC carries no `## Open Implementation
Questions` section and `smithy.cut` re-derives the unknown from its own
plan-review pass when the tasks file is authored.

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

The Phase 0c commit below captures both the refine diff and the plan-review
fixes in the same commit.

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

### Engraved-Knowledge Consultation

Consult engraved durable knowledge before shaping the RFC approach.

Dispatch the **smithy-recall** sub-agent with:

- **Planning context**: RFC artifact
- **Feature/problem description**: the user's idea description or the PRD content read during intake
- **Codebase file paths**: any existing RFC files found during the `docs/rfcs/` scan
- **Domain hint**: infer `system`, `design`, or `both` from the idea, PRD, or referenced files
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

Dispatch 4 competing **smithy-plan** sub-agents in parallel. Each receives the
same planning context, feature description, codebase file paths, and scout
report — the only difference is the **additional planning directives** field.

Use the following lens directives (one per sub-agent):

#### Scope Minimalism

> **Directive:** Challenge scope creep. Propose tighter boundaries, question
> optional requirements, and look for elements that can be deferred without
> blocking the core artifact. Favor fewer entities, narrower stories, and
> smaller milestones. In the Tradeoffs section, surface at least one narrower
> alternative even if you ultimately recommend against it. This directive biases
> your attention, not your coverage — still flag completeness gaps or coherence
> issues if you find them.

#### Completeness

> **Directive:** Look for gaps in coverage: missing user stories, unstated
> assumptions, edge cases in contracts, entities without clear ownership, and
> milestones that skip necessary groundwork. Verify that every requirement
> traces to a concrete artifact element. In the Tradeoffs section, surface at
> least one more thorough alternative even if you ultimately recommend against
> it. This directive biases your attention, not your coverage — still flag
> scope bloat or coherence issues if you find them.

#### Coherence

> **Directive:** Look for inconsistencies between elements: stories that don't
> trace to contracts, data model entities that overlap or have ambiguous
> ownership, feature boundaries that create awkward cross-cutting dependencies,
> and milestones whose ordering doesn't match their actual dependencies.
> Propose cleaner groupings and sharper boundaries. In the Tradeoffs section,
> surface at least one better-structured alternative even if you ultimately
> recommend against it. This directive biases your attention, not your
> coverage — still flag scope bloat or completeness gaps if you find them.

#### Parallelism

> **Directive:** Look for splits that let independent workstreams begin
> concurrently. Prefer **vertical slices** that span data, logic, and interface
> over **horizontal phases** that batch all of one layer before any of the
> next. For each milestone, feature, or user story, ask whether its children
> could realistically start in parallel without a missing prerequisite — and
> whether a sequential ordering is truly required by data flow, or merely
> conventional. In the Tradeoffs section, surface at least one alternative
> with greater concurrent-execution potential even if you ultimately recommend
> against it. This directive biases your attention, not your coverage — still
> flag scope bloat, completeness gaps, or coherence issues if you find them.

---

Pass the quoted directive text above as the **Additional planning directives**
field for the corresponding smithy-plan run.

After all 4 return, dispatch the **smithy-reconcile** sub-agent. Pass it:

- All 4 plan outputs, each labeled with its lens name (e.g.,
  "**[Scope Minimalism]** …", "**[Completeness]** …",
  "**[Coherence]** …", "**[Parallelism]** …")
- The same context file paths
- The planning context and feature description

Use the reconciled plan as the basis for presenting the approach to the user.
Pass each smithy-plan sub-agent:

- **Planning context**: RFC artifact
- **Feature/problem description**: the user's idea description or the PRD content read during intake
- **Codebase file paths**: any existing RFC files found during the `docs/rfcs/` scan (for context on existing patterns)
- **Recall result**: the engraved-knowledge recall result from the Engraved-Knowledge Consultation above (if it surfaced relevant records, candidate invariant conflicts, or superseded/deprecated citation hazards)
- **Additional planning directives**: the lens directive from the competing-lenses section above (each run gets a different directive)

Present the reconciled plan to the user as:

1. **Summary** — What you understand the idea to be and the proposed RFC structure.
2. **Approach** — The reconciled approach for milestone decomposition and scope. Note any
   items annotated with `[via <lens>]`.
3. **Risks** — The reconciled risk assessment.
4. **Conflicts** — If the reconciled plan contains unresolved conflicts between
   approaches, present them with both options and the reconciler's
   recommendation. Let the user decide.


---

## Phase 2: Clarify

### Read Prior Clarify Log

Before dispatching smithy-clarify, check whether a clarify log already exists
for this RFC at `.smithy/clarify-logs/<YYYY>-<NNN>-<slug>.clarify-log.md` —
using the same slug ignite computed during Phase 1 intake. The log lives in
the Smithy-owned `.smithy/clarify-logs/` directory (which is gitignored — see
the append step below), not under the RFC folder, so it never leaks into the
RFC's commit even if the operator runs `git add .`.

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
Phase 3 begins, persist the results to the per-RFC clarify log so future
sessions on this RFC can deduplicate against them:

1. **Ensure `.smithy/clarify-logs/` is gitignored.** Before writing the log,
   read the repo's root `.gitignore`. If it does not contain an entry that
   matches `.smithy/clarify-logs/` (either `.smithy/clarify-logs/` or a
   broader pattern that covers it), append the following two lines to the end
   of `.gitignore`:

   ```
   # Smithy: clarify-log scratch files (per-RFC append-only working memory)
   .smithy/clarify-logs/
   ```

   Skip this step silently if the entry already exists. Do **not** touch any
   other line in `.gitignore`; in particular, do not move, rewrite, or
   reformat existing entries. The `.smithy/smithy-manifest.json` file lives
   at `.smithy/` root and is unaffected by this rule — only the
   `clarify-logs/` subdirectory is ignored.
2. Ensure the directory `.smithy/clarify-logs/` exists. Create it if
   missing. The `.smithy/` directory itself is created by `smithy init`, but
   the `clarify-logs/` subdirectory may not exist yet on the first session.
3. Format the returned assumptions and Q&A as a new
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
4. **Append** the new session entry to
   `.smithy/clarify-logs/<YYYY>-<NNN>-<slug>.clarify-log.md`. The log is
   append-only — never overwrite prior sessions, and never modify existing
   `### Session YYYY-MM-DD` entries. If the file does not yet exist, create
   it with the new entry as its first session.

---

## Phase 3: Draft RFC

**Title conventions**: Before writing, read the `smithy.titles` prompt for
canonical title formats and check for repo-level overrides in the project's
CLAUDE.md. Apply those conventions to all headings in this artifact.

Before drafting orchestrator-inline RFC prose in this phase, load
`Skill("smithy.helper-voice")` in draft mode. Use it as the shared voice
source for directly authored RFC sections such as Decisions and coherence
repairs. Keep Summary, Motivation / Problem Statement, and Personas delegated
to `smithy-prose` where those sub-phases already own the narrative drafting,
and do not inline the helper's taxonomy here. Sub-phase 3b is the sole
Personas exception to this delegation rule: covered personas are projected
inline by the orchestrator from their `.persona.md` files, and only the
uncovered-persona gaps are delegated to `smithy-prose` — so when every needed
persona is covered, no `smithy-prose` Personas dispatch occurs at all. See
Sub-phase 3b for the full projection-and-gap procedure.

### RFC File Creation

Before any sub-phase begins, create the RFC folder and file:

1. Create the folder `docs/rfcs/<YYYY>-<NNN>-<slug>/` if it doesn't exist.
2. Create `docs/rfcs/<YYYY>-<NNN>-<slug>/<slug>.rfc.md` with only the RFC header — nothing else:

```markdown
# RFC: <Title>

**Created**: YYYY-MM-DD  |  **Status**: Draft
```

Do not add a template skeleton or empty section placeholders. Each sub-phase
will append its own section headings and content. The RFC template code fence
below is a reference for section ordering and format — do not copy it into the
file.

### Append-and-Continue Protocol

After each sub-phase's sub-agent returns, the orchestrator appends the returned
content to `<slug>.rfc.md` before dispatching the next sub-phase. This is the
append-and-continue protocol for sub-phases 3a–3f. For inline sub-phase 3e, the
orchestrator appends directly. Sub-phase 3g is an exception: it rewrites the
entire file in place (harmonize pass) rather than appending.

### Resume Hand-off from Phase 0

If Phase 0's state-detection step (Phase 0.1) handed off to Phase 3 with a
specific starting sub-phase (either a `partial` RFC resumed at its first
missing sub-phase, or a `fresh` header-only RFC resumed at 3a), honor the
hand-off with the following rules:

1. **Skip** every sub-phase earlier than the designated starting sub-phase.
   Those sections are already present on disk and MUST NOT be re-run — their
   prior-session output is authoritative.
2. **Leave the accumulating `<slug>.rfc.md` on disk untouched on entry.** The
   `RFC File Creation` step above only runs in the fresh-pipeline case where
   no file exists yet; on resume, the file Phase 0 classified is already on
   disk (either a header-only `fresh` file or a `partial` file with some
   sections already written) and is preserved as-is.
3. **Reconstruct the missing intake and clarify context** before dispatching
   the resumed sub-phase. The sub-agents below all expect
   `idea_description` (normally produced by Phase 1 intake) and
   `clarify_output` (normally produced by Phase 2 clarification), and the
   inline sub-phase 3e synthesizes Decisions directly from the
   clarification record. When Phase 0 hands off into a resume, those
   in-session artifacts may not exist, so the orchestrator MUST rebuild
   them before continuing:
   - **`idea_description`**: re-derive from the existing `## Summary` and
     `## Motivation / Problem Statement` sections of the on-disk RFC. If
     those sections do not yet exist (e.g., 3a is the first missing
     sub-phase), fall back to the user's current invocation arguments or
     ask the user to restate the idea in one or two sentences.
   - **`clarify_output`**: prefer loading the per-RFC clarify log at
     `.smithy/clarify-logs/<YYYY>-<NNN>-<slug>.clarify-log.md` if it
     exists. (This path replaces the legacy in-RFC-folder
     `.clarify-log.md`; the slug here is the same one ignite uses for the
     RFC folder.) If no log is present, run **Phase 2 (Clarify)** before
     dispatching the first resumed sub-phase so the downstream sub-agents
     receive grounded clarification context rather than fabricated answers.
     Do not silently dispatch with empty clarification.
4. **Begin dispatch** from the designated starting sub-phase and continue
   through sub-phase 3g normally, using the append-and-continue protocol
   above for each remaining sub-phase.

For the disk-read context bridging itself, sub-phases **3b–3g** already pass
`rfc_file_path` — the path to the accumulating `<slug>.rfc.md` — to their
dispatched sub-agent, so every section written by an earlier sub-phase
(whether in this session or in an interrupted prior session) flows into the
current sub-agent via the existing disk-read contract. **Exception:**
sub-phase 3a normally does **not** pass `rfc_file_path` because in the
fresh pipeline the file contains only the header at that point. If Phase 0
hands off into 3a (either a `fresh` header-only file or a `partial` file
where 3a is somehow the first missing sub-phase), the orchestrator MUST
pass `rfc_file_path` to smithy-prose for the resumed 3a dispatch so the
sub-agent can see whatever is already on disk before writing the Summary
and Motivation sections.

### Sub-phase 3a: Summary + Motivation

Dispatch **smithy-prose** with:

- **section_assignment**: "Summary and Motivation / Problem Statement"
- **idea_description**: the user's idea description or PRD content from intake
- **clarify_output**: the Q&A and assumptions from Phase 2 clarification
- **rfc_file_path**: do not pass (this is the first sub-phase; the RFC file contains only the header)

After smithy-prose returns, append the returned content to `<slug>.rfc.md`.

### Sub-phase 3b: Personas

Before drafting Personas cold, discover reusable durable personas:

1. Read the **Persona Artifact Convention** above as the canonical storage,
   filename-slug identity, and matching contract. Do not introduce a separate
   schema, registry, index, or identity field for this sub-phase.
2. Resolve the active persona directory from the same `` used
   for this ignite run and list existing `.persona.md` files there. Keep this
   discovery scoped to that active artifacts root so in-repo and
   external-artifacts modes never cross-contaminate persona stores.
3. From personas named or clearly described during Phase 2 clarification,
   derive deterministic kebab-case slugs from each persona name or role.
4. Compare those needed slugs to discovered persona filenames using exact
   filename-slug identity: `<slug>.persona.md` covers the matching needed
   persona. A needed slug with no matching file remains uncovered. Avoid fuzzy
   matching, semantic similarity, interactive selection, or any new registry.

For each covered persona, read the matching `.persona.md` file before drafting
the RFC section. Treat that durable file as source context: preserve the
persona's role, context, and friction, but project it into the RFC-specific
`## Personas` section by explaining how this RFC benefits that persona. The RFC
projection is not a byte-for-byte copy of the durable file; it is a tailored
benefit framing grounded in the durable file's narrative.

For each uncovered needed persona, keep it in an uncovered-persona gaps list.
If no `.persona.md` files exist, every needed persona is uncovered and there is
simply nothing to reuse. If the uncovered-persona gaps list is non-empty,
dispatch **smithy-prose** for only those gaps with:

- **section_assignment**: "Personas"
- **idea_description**: the user's idea description or PRD content from intake
- **clarify_output**: the Q&A and assumptions from Phase 2 clarification, narrowed to the uncovered persona names or roles so covered personas are not regenerated cold (include only the clarification context for the uncovered personas; exclude the names, roles, and context of any persona already covered by a matching `.persona.md` file)
- **rfc_file_path**: the path to the accumulating `<slug>.rfc.md` (which at this point contains the header plus Summary and Motivation)
- **tone_directives**: "Draft only the uncovered personas listed in clarify_output. Do not regenerate personas covered by existing `.persona.md` files. Every uncovered persona is mandatory and MUST appear with a role and a description of how this RFC benefits them. Do not return placeholder or empty content."

If every needed persona is covered by matching `.persona.md` files, do not
dispatch smithy-prose for Personas. Build the `## Personas` section entirely
from the file-sourced projections.

Combine the file-sourced projections and any cold-drafted uncovered gap content
into exactly one `## Personas` section. If both sources are present, include
both in that single section; do not append a second `## Personas` heading.
Verify that the combined content contains a non-empty `## Personas` section with
at least one named persona. If the combined result is empty, placeholder content
(e.g., the template's `<Persona 1 ...>` literal), or missing the `## Personas`
heading, **halt the pipeline** with a diagnostic that points at the Phase 2
clarification record and the reusable persona coverage record so the user can
confirm which personas were identified before retrying. Otherwise, append the
combined `## Personas` section to the RFC file.

### Sub-phase 3c: Goals + Out of Scope

Dispatch **smithy-plan** with:

- **Planning context**: "Draft the Goals and Out of Scope sections for this RFC"
- **Feature/problem description**: the user's idea description plus the full clarification output from Phase 2
- **Codebase file paths**: the path to the accumulating `<slug>.rfc.md` (which by this point contains Summary, Motivation, and Personas from earlier sub-phases)
- **Additional planning directives**: constrain smithy-plan to produce only the Goals and Out of Scope sections in the RFC template format — not a full planning document. Apply the following section-role rules.

  **Goals.** Each bullet describes an outcome this RFC commits to delivering, phrased in terms a stakeholder can evaluate without reading the Milestones section. Goals MUST NOT name milestones (e.g., `M-A`, `M1`, "delivered by M-C"), reference milestone IDs by any notation, describe milestone sequencing, or use the word "milestone". The milestone decomposition is downstream of the goals — **milestones reference goals; goals do not reference milestones.** If a candidate goal can only be stated by pointing at the milestone that delivers it, rewrite it as the outcome the milestone produces, or drop it.

  **Out of Scope.** Each bullet is a capability this RFC explicitly will NOT deliver — items that no milestone in this RFC covers and that a future RFC (or a separate effort) would be needed to address. An item that is "deferred to M-N", "covered by a later milestone", or "in scope but not yet specified at this layer" is **in scope for this RFC** and MUST NOT appear here — surface those inside the relevant milestone's description in sub-phase 3f instead. Source out-of-scope entries only from clarification answers that named a capability as excluded from the work entirely (clarify Scope category, "explicitly out of scope" answers). The returned content **must** include a `## Out of Scope` section; it is a required section, never omitted. If no exclusions were identified during clarification, smithy-plan must still emit the `## Out of Scope` section with the single placeholder entry `None identified at this time` so the section is never left empty.

Append the returned content to the RFC file.

### Sub-phase 3d: Proposal + Design Considerations

Dispatch **smithy-plan** with:

- **Planning context**: "Draft the Proposal and Design Considerations sections for this RFC"
- **Feature/problem description**: the user's idea description plus the clarification output and the reconciled approach from Phase 1.5
- **Codebase file paths**: the path to the accumulating `<slug>.rfc.md` (which by this point contains Summary through Out of Scope)
- **Additional planning directives**: constrain smithy-plan to produce only the Proposal and Design Considerations sections — not a full planning document

Append the returned content to the RFC file.

### Sub-phase 3e: Decisions + Specification Debt

This sub-phase is orchestrator-inline — no sub-agent dispatch. It writes
**both** sections the state-detection map credits it with, in template order:
`## Decisions` first, then `## Specification Debt`.

Synthesize the **Decisions** section directly from the clarification record
(Phase 2 output) and the reconciled approach (Phase 1.5):

- **Decisions**: Items that were discussed and resolved during clarification
  or reconciliation. Each entry states what was decided and why.

Then write the **Specification Debt** section from clarify's returned
`debt_items`, using the shape in the RFC template's `## Specification Debt`
block below:

Assign sequential `SD-NNN` identifiers, continuing from the highest number the
section already carries rather than resetting — `SD-001` only when the section
holds no rows at all. An identifier is never reused, including one whose row
has since moved under `### Resolved`. Carry the title, source_category,
impact, confidence, and origin fields into the index table and the
description into the item's `### SD-NNN — <Title>` detail section, directly
from clarify's return — never reword a description into a directive, and
never add an item that did not come from `debt_items`. Everything clarify
returns is `Origin: local`, so every item clarify returned gets a detail
section. The kind gate is enforced by `smithy-clarify` Step 3; do not bypass
it here by manually appending requirement, acceptance-test,
dependency-coordination, deferral, or post-hoc resolution items. If clarify
returned no debt items, write the section's empty-state line rather than
back-filling the table from coordination notes or future work. Omit
`### Resolved` on a first pass — nothing has been resolved yet.

The RFC has **no `## Open Questions` section**. Genuinely unresolved
uncertainty is already captured as `SD-NNN` rows in `## Specification Debt`
by this sub-phase (and amended by later refine / plan-review passes);
duplicating it as prose under a separate heading would split the same
uncertainty across two formats. Refer to the "Decisions vs Specification
Debt" guidance below the template code fence.

Append the formatted `## Decisions` and `## Specification Debt` sections to
the RFC file. Both are on disk before Phase 4 commits — no phase after the
commit writes debt into the artifact.

### Sub-phase 3f: Milestones

Dispatch **smithy-plan** with:

- **Planning context**: "Draft the Milestones section and Dependency Order table for this RFC"
- **Feature/problem description**: the user's idea description plus the clarification output
- **Codebase file paths**: the path to the accumulating `<slug>.rfc.md` (containing all prior sections)
- **Additional planning directives**: produce the milestone decomposition followed immediately by a `## Dependency Order` 4-column table with `M<N>` IDs. Each milestone must be formatted as `### Milestone N: <Title>` followed by `**Description**` and `**Success Criteria**` bullets. The Dependency Order table uses columns `ID | Title | Depends On | Artifact`. In `Depends On`, each cell must be exactly `—` or a comma-separated list of `M<N>` IDs from the same table (e.g., `M1` or `M1, M2`); do not use prose or any other format. In `Artifact`, each cell starts as `—`; do not use checkboxes.

Append the returned content to the RFC file.

### Sub-phase 3g: Harmonize

This sub-phase is primarily orchestrator-inline. The only exception is the
Personas repair branch in step 3 below, which may conditionally re-dispatch
**smithy-prose** when the coherence pass detects that the `## Personas`
section is missing, empty, or placeholder-only. No other sub-agents are
dispatched in 3g.

1. Read the complete `<slug>.rfc.md` from disk.
2. Perform a coherence pass:
   - Smooth tone across sections written by different sub-agents.
   - Fix cross-references between sections (e.g., a Milestone referencing a Goal
     by name, a Proposal referencing a Persona).
   - **Reorder sections to match the RFC template structure** (Summary →
     Motivation / Problem Statement → Goals → Out of Scope → Personas →
     Proposal → Design Considerations → Decisions → Specification Debt →
     Milestones → Dependency Order). This reordering is required because
     sub-phase 3b appends Personas before sub-phase 3c appends Out of Scope,
     so a correctly drafted Personas section will be misplaced in the
     accumulating file and MUST be moved into canonical position here.
   - Verify that every expected RFC template section is present and non-empty.
   - **Out of Scope safety net**: explicitly verify that the `## Out of Scope` section exists and contains substantive content. If the section is missing entirely, insert it in the correct template position (immediately after `## Goals`) with the single placeholder entry `None identified at this time`. If the section is present but empty or contains no substantive content, fill it in place with the same placeholder phrasing `None identified at this time`. This safety net mirrors the sub-phase 3c directive so both enforcement layers use identical placeholder text.
   - **Goals scope-scrub**: scan every bullet in `## Goals` for milestone references — any token matching `M[0-9]+`, `M-[A-Z]`, or the literal word "milestone" (case-insensitive). If a goal can only be expressed by naming the milestone that delivers it, rewrite it as the outcome the milestone produces (drop the milestone reference). If the milestone reference cannot be separated from the bullet without losing the goal, drop the bullet — milestones realize goals, not the other way around. This safety net mirrors the sub-phase 3c directive.
   - **No `## Open Questions` section.** If a `## Open Questions` heading was generated by an earlier sub-phase or carried over from a prior draft of this RFC, **remove it**. Genuinely unresolved uncertainty belongs in `## Specification Debt` as an `SD-NNN` row with `clarify:Risks` or the appropriate clarify category — not as a separate narrative section. If removing the section would lose information that is not already represented in Specification Debt, translate each remaining open question into a new `SD-NNN` row (continue numbering from existing rows) before deleting the heading.
   - **`## Specification Debt` safety net**: explicitly verify that the `## Specification Debt` section exists at the canonical position (after `## Decisions` and before `## Milestones`). If the section is missing entirely, insert it at that position with the placeholder body `_None — no specification debt was recorded._`. Do **not** back-fill the table from coordination notes, future-work bullets, or milestone deferrals — an empty placeholder is the correct outcome when no debt was recorded by clarify, refine, or plan-review. This safety net mirrors the Phase 0 state-detection contract so a legacy RFC missing the debt table is healed in place on resume.
   - **Personas repair provenance pre-check**: before deciding whether the
     Personas repair branch requires any cold repair dispatch, re-run the same
     durable persona discovery and slug coverage procedure used by sub-phase
     3b. Read the **Persona Artifact Convention** above as the canonical
     storage, filename-slug identity, and matching contract; resolve the
     persona directory from the active `` for this ignite run;
     list existing `.persona.md` files in that resolved persona directory,
     keeping discovery scoped to the active artifacts root exactly as
     sub-phase 3b does so in-repo and external-artifacts modes never
     cross-contaminate persona stores; and derive
     deterministic kebab-case slugs from persona names or roles surfaced in
     Phase 2 clarification and from the current on-disk `## Personas` section.
     Compare those derived slugs to discovered filenames using exact
     filename-slug identity (`<slug>.persona.md`). Record matching personas as
     file-sourced for harmonize/repair purposes and treat the matching durable
     files as their source of truth. Personas with no matching durable file
     remain eligible for the existing cold repair path. This provenance record
     MUST be reconstructed from disk and the canonical convention on every
     harmonize run, including resumes from an on-disk RFC; do not rely on
     in-memory sub-phase 3b state, inline markers, sidecar files, interactive
     selection, fuzzy matching, or a registry.
   - **`## Personas` is a mandatory verified section.** Explicitly check that
     the harmonized RFC contains a non-empty `## Personas` section positioned
     after `## Out of Scope` and before `## Proposal`, and that it lists at
     least one named persona with a description (not placeholder text such as
     the template's `<Persona 1 ...>` literal). Treat any of the following as
     a failure that triggers the Personas repair branch in step 3: missing
     section, empty section, placeholder-only content, or a non-empty
     Personas section that remains outside the canonical position after the
     reorder step above. A well-formed Personas section whose personas match
     the file-sourced provenance record is not a repair failure solely because
     it was projected from durable `.persona.md` files.
3. **Personas repair.** If the Personas verification above fails for any
   reason (missing, empty, placeholder-only, or still misplaced after
   reorder), re-dispatch **smithy-prose** with:
   - `section_assignment` = "Personas"
   - `idea_description` = the user's original idea description or PRD content
     from intake (same value passed to sub-phase 3b; required by the
     smithy-prose contract)
   - `clarify_output` = the Phase 2 clarification Q&A and assumptions
   - `rfc_file_path` = the path to the accumulating `<slug>.rfc.md`
   - `tone_directives` = "Personas named or described during Phase 2
     clarification are mandatory. Do not return placeholder or empty content."

   When smithy-prose returns, **replace** any existing `## Personas` section
   in the RFC file with the returned content in place — do not append a
   second Personas section. If no `## Personas` heading exists, splice the
   returned section in at the canonical position (after `## Out of Scope`
   and before `## Proposal`). Re-run the mandatory-section verification from
   step 2 after repair; if Personas is still missing, empty, or misplaced,
   halt the pipeline with a diagnostic pointing at the Phase 2 clarification
   record.
4. Rewrite the file in place with the harmonized content.

Confirm the harmonize step completed before proceeding to Phase 4.


**Important — Decisions vs Specification Debt**: Items discussed during
clarification that have been resolved belong in **Decisions** (document what
was decided and why). Genuinely unresolved unknowns that need further
investigation or stakeholder input belong in the **Specification Debt** table
as `SD-NNN` rows — not as a separate narrative section. The RFC has no
`## Open Questions` section; treating unresolved items as informal prose
duplicates the debt table in a less structured format.

```markdown
# RFC: <Title>

**Created**: YYYY-MM-DD  |  **Status**: Draft

## Summary
<!-- audience: stakeholder; mode: explanation; length: 2-3 sentences; diagram: optional; examples: discouraged -->

<High-level pitch — what this is and why it matters, in 2-3 sentences.>

## Motivation / Problem Statement
<!-- audience: stakeholder; mode: explanation; length: 2-3 paragraphs; diagram: optional; examples: discouraged -->

<What problem does this solve? Why does it need solving now? What is the impact
of not solving it?>

## Goals
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- <Outcome 1 — what this RFC commits to delivering, stated as a result a stakeholder can evaluate. Do NOT reference milestone IDs (M1, M-A, etc.) or the word "milestone"; milestones realize goals, not the reverse.>
- <Outcome 2>
- <Outcome 3>

## Out of Scope
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- <Capability 1 this RFC will NOT deliver — must be a true exclusion, not deferred work. Bad: "Eval rubrics — deferred to M-F or later". Good: "Production observability — lives in operations-doc territory, not in this RFC.">
- <Capability 2>

## Personas
<!-- audience: stakeholder; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- <Persona 1 — role and how they benefit from this RFC>
- <Persona 2 — role and how they benefit>

## Proposal
<!-- audience: reviewer; mode: explanation; length: 3-6 paragraphs; diagram: recommended; examples: recommended -->

<The "WHAT" — describe what will be built at a high level. Focus on outcomes
and capabilities, not implementation details. A block or sequence diagram of
the proposed architecture beats wall-of-text whenever three or more named
components or steps are involved.>

## Design Considerations
<!-- audience: reviewer; mode: explanation; length: 3-6 paragraphs; diagram: optional; examples: discouraged -->

<High-level architectural thoughts, tradeoffs, and constraints that will
influence downstream design decisions. Keep this at "WHAT not HOW" level.>

## Decisions
<!-- audience: reviewer; mode: explanation; length: 1-3 paragraphs; diagram: optional; examples: discouraged -->

- <Decision 1 — what was decided and the rationale>
- <Decision 2>

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
## Milestones
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

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
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| M1 | <Title> | — | — |
| M2 | <Title> | — | — |
```

Populate the `## Specification Debt` section from clarify's returned
`debt_items` at draft time.
Follow the numbering and row-shape rules stated in sub-phase 3e above.

At the RFC layer in particular, an empty `## Specification Debt` section is
the common, expected outcome.

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

For the triage below, **the target artifact** is the RFC file just written —
its `SD-NNN` numbering continues from whatever clarify / Phase 3 already
wrote. **The review note surface** is the PR body; a Low-confidence
`implementation` finding goes there under an **Implementation questions**
heading, since an RFC carries no `## Open Implementation Questions` section
and `smithy.cut` re-derives the unknown from its own plan-review pass when
the tasks file is authored.

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

The commit below captures the RFC and the applied fixes in the same diff.

Phase 3 already created the RFC folder, wrote the file piecewise through
sub-phases 3a–3f, and harmonized it in sub-phase 3g. Skip folder creation
and file write — proceed directly through plan-review, commit, and PR:

1. Run the Plan-Review Pass described above on the harmonized RFC file.
2. Verify the RFC's `## Specification Debt` section is already populated
   (sub-phase 3e wrote it from clarify's `debt_items`, and the plan-review
   pass above appended any `steering` findings). The artifact must be
   complete before the commit — nothing after this step writes debt into
   the file.
3. Commit the RFC file on the current feature branch (capturing both the
   harmonized content and any plan-review fixes in the same diff). Push
   the current branch as-is — do not rename it or prepend a prefix such
   as `feature/`. The PR must be opened against the same branch the
   operator (or upstream orchestrator) had checked out when ignite was
   invoked. See the branch policy below.
4. Compose the one-shot output snippet content (the format defined below).
   For an RFC-only run, use the RFC folder as the spec folder and
   substitute milestone counts where the snippet asks for user stories /
   functional requirements. Copy the clarify return's `assumptions` into
   the snippet's `## Assumptions` section (the snippet / PR body is the
   only Assumptions surface — the RFC artifact itself has no
   `## Assumptions` section), and source the `## Specification Debt`
   summary from the committed RFC per the snippet's placeholder guidance,
   so the PR body and the artifact stay in sync. Leave the `## PR` section
   unfilled for now.
5. Create a PR for the RFC artifact using the forge PR-creation pattern
   (Prefer `mcp__github__create_pull_request` (the GitHub MCP tool); fall back to `gh pr create` only when the MCP server is unavailable.):
   - **Title**: the RFC title, under 70 characters, descriptive text only.
   - **Body**: the snippet content composed in the previous step (minus its
     `## PR` section) plus a relative link to the RFC file.
6. Fill the snippet's `## PR` section with the URL the previous step
   returned and render the completed snippet as the terminal contract.


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