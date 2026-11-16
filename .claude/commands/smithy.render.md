---
description: "Break an RFC milestone into a feature map one-shot. Runs clarify, drafts the map, creates a PR, and renders a standardized terminal summary without intermediate approval gates."
argument-hint: "<rfc-path|features-path> [<milestone-number>] [--bundle <path>]"
disable-model-invocation: true
---
# smithy.render

You are the **smithy.render agent** for this repository.
Your job is to take an **RFC milestone** and interactively break it into a
**feature map** — a structured list of discrete, user-facing features that
together deliver the milestone's goals.

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

The user's RFC path, optional milestone number, and optional `--bundle <path>`:
$ARGUMENTS

This may be:
- An **RFC file path** (`.rfc.md`) — auto-selects the next unprocessed milestone.
- An **RFC file path + milestone number** — targets that specific milestone.
- **Either of the above plus `--bundle <path>`** — treats the named bundle as
  prototype-first UI context for any `design: import` features the map emits.
  `--bundle` is a named argument, so it never competes with the optional
  milestone number: `<rfc> --bundle <path>` keeps auto-selection, while
  `<rfc> 3 --bundle <path>` targets milestone 3. A bare path that is not
  preceded by `--bundle` is never treated as a bundle.
- An **existing `.features.md` path** — enters the review loop (Phase 0).
- Empty — ask the user for a path.

If no input is clear from the above, ask the user for the path to an RFC.

---

## Routing

Before starting, determine the mode:

1. **If the input is a `.features.md` file path**, go to **Phase 0: Review Loop**.
2. **If the input is a `.rfc.md` file path** (with or without a milestone number):
   a. Read the RFC and identify its milestones.
   b. Scan the RFC folder for existing `<NN>-*.features.md` files.
   c. **RFC path + milestone number**: If a `.features.md` already exists for that
      milestone, go to **Phase 0: Review Loop**. Otherwise, go to **Phase 1: Intake**.
   d. **RFC path only**: Auto-select the first milestone that doesn't have a
      `.features.md` yet. If **all** milestones already have maps, present a table
      of milestones with their `.features.md` paths and ask the user which
      milestone to audit. Once selected, go to **Phase 0: Review Loop** with
      that milestone's `.features.md`.
3. **If the input is not a file path** (no `/` or `.` indicating a path, and does
   not end in `.rfc.md` or `.features.md`), abort with:
   > "Render works from an existing RFC. Run `smithy.ignite` first to workshop
   > your idea into an RFC."
4. **If the input is empty**, ask the user for the path to an RFC.

---

## Phase 0: Review Loop

Triggered when the target milestone already has a `.features.md` file in the RFC
folder (either via direct `.features.md` path input, RFC path + milestone number
targeting an existing map, or when all milestones have maps and the user selects
one to audit).

### Phase 0 — Resolve Source Context

Before auditing, locate the source RFC and the specific milestone the map covers:

1. **Read the `.features.md` header.** Extract the **Source RFC** path and the
   **Milestone** number and title from the file's metadata block.
2. **If the header fields are missing or unreadable**, fall back: look for a
   co-located `.rfc.md` file in the same folder. If found, parse its milestones
   and match by the milestone number in the `.features.md` filename prefix
   (`<NN>-*.features.md` → milestone `<NN>`).
3. **Read the matched RFC milestone section** so it is available as the baseline
   for the audit scan.
4. If neither the header nor the fallback resolves a valid RFC and milestone,
   abort with an error message instructing the user to re-invoke render with
   an explicit RFC path and milestone number.

### Phase 0a–0b: Audit & Refinement Questions

Use the **smithy-refine** sub-agent. Pass it:

- **Audit categories**:

  | Category | What to check |
  |----------|---------------|
  | **Feature Coverage** | Are all aspects of the milestone represented by at least one feature? |
  | **Gaps** | Are there milestone goals or success criteria that no feature addresses? |
  | **Overlap** | Are there features with unclear or overlapping boundaries? |
  | **Dependency Clarity** | Are inter-feature dependencies within the milestone evident, or are they hidden? |
  | **Feature Independence** | Are features that touch disjoint code areas or address functionally independent milestone goals marked as such, so they can be specced and cut in parallel? Is the implied ordering real (data flow / contract dependency), or merely conventional? Flag features whose `Depends On` overstates the actual prerequisite. |
  | **RFC Alignment** | Does the feature map align with the RFC's stated goals and success criteria for this milestone? |

- **Target files**: the `.features.md` file and the source `.rfc.md` file
  (resolved in Phase 0 — Resolve Source Context above).
- **Context**: this is a feature map review; include the `.features.md` path,
  the source `.rfc.md` path, and the resolved RFC milestone number and title.
- **Special instructions**: if all categories are **Sound**, ask at least one
  question about whether any feature should be split, merged, or re-scoped based
  on lessons learned since the map was created.

### Phase 0c: Apply Refinements

After the sub-agent returns its summary:

1. Apply the refinements from smithy-refine directly to the `.features.md`
   file in place — refine is non-interactive and returns high-confidence
   refinements ready to apply. Do not pause for user approval before
   writing.
2. Route any low-confidence findings returned in `debt_items` into the
   feature map's `## Specification Debt` section.
3. Run the **Plan-Review Pass** described below on the refined
   `.features.md` file before committing. Plan-review runs after refine has
   applied its changes and before the commit below, so any High-confidence
   fixes it proposes are captured in the same refinement commit.
4. Commit the refinement diff and create a PR for the refinement using the
   forge `gh pr create` pattern (the same pattern Phase 4 uses below;
   Prefer `mcp__github__create_pull_request` (the GitHub MCP tool); fall back to `gh pr create` only when the MCP server is unavailable.).
5. Render the one-shot output block (the format defined in the
   `one-shot-output` shared snippet, inlined into Phase 4 below) as the
   terminal contract for the refinement pass, using the feature map as the
   artifact produced. Do **not** pause for user approval of the refinement
   diff before creating the PR — Phase 0 is non-interactive like the
   first-pass flow.

#### Plan-Review Pass (Phase 0c)

After refine applies its changes to the feature map and before committing,
dispatch the **smithy-plan-review** sub-agent to perform a self-consistency
review of the refined artifact. Pass it:

- **artifact_paths** — the repo-relative path to the refined feature map
  file (`docs/rfcs/<YYYY>-<NNN>-<slug>/<NN>-<milestone-slug>.features.md`).
- **artifact_type** — `feature-map`.

For the triage below, **the target artifact** is the refined feature map —
its `SD-NNN` numbering continues from whatever refine or prior clarify passes
already wrote. **The review note surface** is the refinement PR body; a
Low-confidence `implementation` finding goes there under an **Implementation
questions** heading, since a feature map carries no `## Open Implementation
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

Parse the input and prepare the target:

1. **Read the RFC file.** Parse the Milestones section to extract all milestones
   (each `### Milestone N: <Title>` heading).
2. **Validate the target milestone.** If a milestone number was specified,
   verify it exists in the RFC and abort with a clear error if it does not.
   If auto-selected, proceed with that choice without asking — render is
   one-shot and Step 5 only reports the target, it does not re-confirm it.
3. **Derive the slug.** Create a kebab-case slug from the milestone title
   (e.g., "Core Pipeline Commands" → `core-pipeline-commands`).
4. **Derive the filename.** `<NN>-<milestone-slug>.features.md` where `<NN>` is the
   two-digit zero-padded milestone number (e.g., `01-`, `02-`, ... `09-`, `10-`).
5. **Report the target** to the terminal so the developer can see what
   render picked (do not block on confirmation — render is one-shot):
   - RFC path
   - Milestone number and title
   - Derived filename
   - Import bundle path, if supplied

### Import Bundle Intake

If the input includes a `--bundle <path>` argument, treat that path as a
boundary object available while drafting the feature map. Read the bundle path
from `--bundle` only — never from a bare positional argument, so auto-selected
and explicitly numbered milestone runs accept a bundle identically:

- Record the exact repo-relative bundle path in every relevant `kind: ui`,
  `design: import` feature's metadata.
- Keep `design_system` as the committed implementation dialect source even
  when a bundle is present. A bundle supplements visual/structural context; it
  does not replace the design skill.
- Use the supplied prototype/bundle to derive candidate `ScreenId` and `FlowId`
  values for the feature metadata (`screens:` and `flows:`). These IDs are a
  human-confirmable starting point that `smithy.mark` later turns into the typed
  ledger and durable artifacts.
- Surface unclear prototype structure as specification debt instead of hiding
  it. Examples: multiple plausible screen boundaries, unnamed alternate paths,
  or flows whose entry/exit/guard cannot be inferred confidently.
- Do not call a visual design/prototyping tool inline. Render only ingests the
  supplied bundle reference and records/derives feature-map structure from it.
- Do not author `.design.md`, `.flow.md`, or executable test-body files during
  render. Those durable artifacts remain owned by downstream `smithy.mark`.

If no `--bundle` argument is supplied, keep the existing no-bundle path: omit
`bundle`, choose `design` from the milestone/RFC context, and derive only the
screen/flow identifiers supported by the written milestone intent.

---

## Phase 1.5: Consistency Scan

Use the **smithy-scout** sub-agent. Pass it:

- **Scope**: the codebase files you read during Phase 1 exploration (if any),
  plus the RFC file itself
- **Depth**: shallow
- **Context**: feature map planning for milestone `<N>` of the RFC

Handle the scout report as follows:

- **Conflicts**: Fold into the clarification criteria for Phase 2 — the user
  should be aware of codebase inconsistencies before defining feature boundaries.
- **Warnings**: Proceed to Phase 2 but carry warnings as non-blocking context
  for clarification. Mention them if they become relevant to a clarification
  question, but do not force separate discussion of each warning.
- **Clean**: Proceed directly to Phase 1.8 (or Phase 2 if not in agent mode) with no additional context.

### Engraved-Knowledge Consultation

Consult engraved durable knowledge during this scan before defining feature
boundaries.

Dispatch the **smithy-recall** sub-agent with:

- **Planning context**: feature map artifact
- **Feature/problem description**: the RFC path and the target milestone number, title, description, and success criteria
- **Codebase file paths**: the RFC file path plus any codebase files read during Phase 1
- **Domain hint**: infer `system`, `design`, or `both` from the milestone and referenced files
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
---

## Phase 1.8: Approach Planning

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

- **Planning context**: feature map artifact
- **Feature/problem description**: the RFC path and the target milestone number, title, description, and success criteria
- **Codebase file paths**: the RFC file path plus any codebase files read during Phase 1
- **Scout report**: the scout report from Phase 1.5 (if it contained conflicts or warnings)
- **Recall result**: the engraved-knowledge recall result from the Engraved-Knowledge Consultation above (if it surfaced relevant records, candidate invariant conflicts, or superseded/deprecated citation hazards)
- **Additional planning directives**: the lens directive from the competing-lenses section above (each run gets a different directive)

Present the reconciled plan to the user as:

1. **Summary** — What you understand the milestone to deliver and the proposed feature decomposition.
2. **Approach** — The reconciled approach for feature boundaries and grouping. Note any
   items annotated with `[via <lens>]`.
3. **Risks** — The reconciled risk assessment.
4. **Conflicts** — If the reconciled plan contains unresolved conflicts between
   approaches, present them with both options and the reconciler's
   recommendation. Let the user decide.


---

## Phase 2: Clarify

Use the **smithy-clarify** sub-agent. Pass it:

- **Criteria** (using the milestone's description and success criteria as input):
  - **Feature Boundaries** — Where does one feature end and another begin?
  - **Overlap Between Features** — Are there concerns that could belong to multiple features?
  - **Dependency Relationships** — Do any features depend on others within this milestone?
  - **Scope Within the Milestone** — Is anything in the milestone too large for a single feature, or too small to be its own feature?
  - **Integration Points** — Does the milestone touch external systems, APIs, or other milestones?
  - **Cross-Milestone Boundaries** — Does this milestone depend on or overlap with
    other milestones in the RFC? Boundaries between milestones are resolved at the
    RFC level — note them but do not ask about them.
- **Context**: this is a feature map; include the RFC path and the target milestone
  number and title from Phase 1, and the reconciled plan from Phase 1.8 if generated.
- **Special instructions**: Cross-Milestone Boundaries should almost always be
  clear — the RFC defines milestone scope. Only flag as ambiguous if the RFC
  itself is unclear about which milestone owns a piece of functionality. If the
  milestone is well-defined, expect more assumptions and fewer questions. Never
  skip clarification entirely.

---

## Phase 3: Draft Feature Map

**Title conventions**: Before writing, read the `smithy.titles` prompt for
canonical title formats and check for repo-level overrides in the project's
CLAUDE.md. Apply those conventions to all headings in this artifact.

Before drafting prose-bearing feature-map sections, load
`Skill("smithy.helper-voice")` in draft mode. Use it as the shared voice
source for the narrative fields a feature carries — descriptions, rationale,
and the seam explanation between a build/wire pair — while leaving the
`## Dependency Order` table and the typed field blocks as structured Reference
content. It is also the source of the `<!-- audience: ... -->` tags this
artifact carries and `smithy.audit` lints. Do not inline the helper's taxonomy
in this prompt.

Using the workshopped answers from Phase 2, draft a structured `.features.md`. Every
feature is typed per the shared schema below:

## Feature Kinds

Every feature in a `.features.md` map is **typed**. Each `### Feature N:` carries a
fenced `yaml` metadata block — placed right after the heading, before the prose —
declaring its kind and, for UI work, its design mode and phase fields. The kind
selects the `smithy.mark` authoring path: `backend` keeps the existing
spec-triad flow, while `ui` enters the UI authoring path for the typed ledger and
durable design truth.

- **`backend`** — server/library functionality; the prose body is a behavioral delta.
- **`ui`** — screen/flow work; `mark` authors the UI spec ledger and durable
  screen/flow design artifacts plus placeholder flow test bodies, then
  downstream build steps render a framework-appropriate screen component from a
  committed design skill and, in the `wire` phase, fill/update the executable
  flow body for any flow the screen joins.

| Key | Kind | Required | Notes |
|-----|------|----------|-------|
| `kind` | both | Yes (new) | `backend` or `ui`. Missing on legacy maps → `backend`. |
| `phase` | ui | Yes | `build` or `wire` (feature-level). |
| `design_system` | ui | Yes | Committed design-skill ref (for example `story-spider-design`); source of truth even when a bundle is present. A screen with a `bundle` still requires `design_system`. |
| `design` | ui | Yes | Screen-node design mode: `none`, `import`, or `brief`, shared by every `ScreenId` the feature lists. Render must set this explicitly; downstream `mark` copies it into the `Design` cell of each of the feature's `SC<N>` ledger rows instead of inferring from the title. Screens needing distinct modes go in separate features. |
| `bundle` | ui | No | Repo-relative path to a visual prototype boundary object supplied to render or attached later (for example a Figma export, Claude Design export, or equivalent visual-tool bundle) — a visual/structural reference, not a drop-in. Bundle wins on layout/visual intent; the skill wins on implementation dialect. |
| `flag` | ui | Yes (flag-gated) | Feature-flag name; the shared contract joining a `build` feature to its `wire` feature. |
| `screens` | ui | Yes | List of `ScreenId`, e.g. `[AddTitle]`. |
| `flows` | ui | No (build) / Yes (wire) | List of `FlowId` the screen participates in. Build features may list mock-satisfiable candidate flows; wire features must list the flows they connect to real data. |

```yaml
# backend feature
kind: backend
```

```yaml
# ui feature (build phase)
kind: ui
phase: build
design_system: story-spider-design
design: import
bundle: design/bundles/add-title.zip   # optional
flag: add_title_v1
screens: [AddTitle]
flows: [AddTitle]
```

**Design mode semantics.** The mode is carried in metadata so readers and
downstream commands do not infer it from feature titles. It is
**feature-level**: every `ScreenId` in the feature's `screens` list shares the
one `design` value, so a feature that would need two different modes for two
screens must be split into separate features (one per mode) — which the
one-screen-per-build model already favors. `mark` copies the value into the
`Design` cell of each `SC<N>` ledger row; flow and story rows use `—`.

| Mode | Meaning | Bundle behavior |
|------|---------|-----------------|
| `none` | No visual loop. Build from the committed design skill with no bundle ceremony. | Omit `bundle`. |
| `import` | Prototype-first: a visual prototype already exists. `render` carries the supplied bundle forward and may derive candidate screen/flow structure from it. | Bundle enters at `render`, is recorded in UI feature metadata, and rides to `forge` as visual source context; derived `screens`/`flows` are confirmable candidates for `mark`, not durable design truth. |
| `brief` | Mark-authored intent for a visual tool: the `.design.md`/`.flow.md` artifacts are the brief. | Bundle may be attached later; if present, downstream build honors it under the conflict rule. |

**Import-mode derivation.** When render receives an import bundle, it treats the
bundle as feature-map context: record the exact bundle reference on relevant
`design: import` UI features, keep `design_system` as the committed
implementation dialect, and use the prototype to propose candidate `ScreenId`
and `FlowId` values in `screens:` and `flows:`. Those identifiers are a
human-confirmable starting point that downstream `mark` turns into the typed
ledger plus durable `.design.md`/`.flow.md` artifacts. Render does not call a
visual tool inline, author durable screen/flow files, or hide ambiguous
prototype interpretation; unresolved ambiguity belongs in specification debt.

**Phase semantics.** `build` implements the screen component against a mock
behind `flag` (rendering every brief state with design-system tokens only);
`wire` connects real data, flips the flag, and fills/updates the mark-created
executable test-body stub for every flow in `flows` using the project's UI
driver; the `.flow.md` design truth is authored by `mark`. Compose, Maestro,
and `story-spider-design` are examples, not required stacks.

**The build/wire seam.** Flag-gated UI is two features sharing one `flag`: a `build`
feature and a `wire` feature that lists the build feature in its `Depends On` cell.
Build-ahead-of-backend is legal — only the `wire` feature depends on the backend
feature. The shared `flag`, the `phase` metadata, and the dependency row are the
contract of record; naming conventions are only descriptive.
Assemble the feature map in this format (a backend feature and a build/wire UI pair
are shown to illustrate the seam):

````markdown
# Feature Map: <Milestone Title>

**Source RFC**: `<docs/rfcs/YYYY-NNN-slug/slug.rfc.md>`
**Milestone**: <N> — <Milestone Title>
**Created**: YYYY-MM-DD

## Features
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

### Feature 1: <Title>

```yaml
kind: backend
```

**Description**: <What this feature delivers — one to two sentences.>

**User-Facing Value**: <Why a user cares about this feature.>

**Scope Boundaries**:
- Includes: <what is in scope>
- Excludes: <what is explicitly out of scope>

### Feature 2: <Title>

```yaml
kind: ui
phase: build
design_system: <committed design skill, e.g. story-spider-design>
design: <none|import|brief>
bundle: <repo-relative path to a visual prototype boundary object — supplied via --bundle at render for `design: import`, or attached later for `design: brief`; omit the key when no bundle exists yet>
flag: <feature-flag name gating this screen>
screens: [<candidate ScreenId derived from milestone or import bundle>]
flows: [<candidate FlowId derived from milestone or import bundle>]
```

**Description**: <What this screen delivers, built against a mock behind the flag. If
`design: import`, name the supplied bundle as context and state that the screen/flow
IDs are candidate structure for human confirmation.>

**User-Facing Value**: <Why a user cares about this feature.>

**Scope Boundaries**:
- Includes: <what is in scope>
- Excludes: <what is explicitly out of scope>

### Feature 3: <Title> (wire)

```yaml
kind: ui
phase: wire
design_system: <same skill as the build feature>
design: <same screen-node design mode as the build feature>
flag: <same flag as the build feature — the shared contract>
screens: [<ScreenId>]
flows: [<FlowId>]
```

**Description**: <Connect the screen to real data and flip the flag; done includes
emitting/updating the executable test body for each flow above.>

**User-Facing Value**: <Why a user cares about this feature.>

**Scope Boundaries**:
- Includes: <what is in scope>
- Excludes: <what is explicitly out of scope>

<!-- Repeat for each feature. backend features carry only `kind: backend`. -->

<!-- Specification Debt appears here for templates without ## Assumptions sections -->
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
## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

Recommended specification sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| F1 | <Title> | — | — |
| F2 | <Title> | — | — |
| F3 | <Title> | F1, F2 | — |

## Cross-Milestone Dependencies
<!-- audience: reviewer; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| Milestone <X>: <title> | depends on | <what this milestone needs from or provides to the other> |

_If no cross-milestone dependencies exist, state "None — this milestone is self-contained."_
````

Populate the drafted `## Specification Debt` section from clarify's returned
`debt_items`.

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

The debt section is complete before Phase 4 commits the file — no phase after
the commit writes debt into the artifact.

## Phase 4: Write & Create PR

Render runs one-shot: after the feature map is on disk, commit it, create a
PR for the feature map artifact, and render the one-shot output snippet as
the terminal contract. Do **not** pause for user approval before creating
the PR.

### Plan-Review Pass

After the feature map file is on disk and before the commit step, dispatch
the **smithy-plan-review** sub-agent to perform a self-consistency review.
Pass it:

- **artifact_paths** — the repo-relative path to the feature map file
  (`docs/rfcs/<YYYY>-<NNN>-<slug>/<NN>-<milestone-slug>.features.md`).
- **artifact_type** — `feature-map`.

For the triage below, **the target artifact** is the feature map just
written — its `SD-NNN` numbering continues from whatever clarify already
wrote in Phase 2. **The review note surface** is the PR body; a
Low-confidence `implementation` finding goes there under an **Implementation
questions** heading, since a feature map carries no `## Open Implementation
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

The commit below captures both the original feature map and the applied fixes
in the same diff.

### Commit and create the PR

1. Write the feature map to the RFC folder as `<NN>-<milestone-slug>.features.md`,
   co-located with the source RFC.
2. Run the Plan-Review Pass described above on the feature map file that was
   just written.
3. Verify the feature map's `## Specification Debt` section is already
   populated (Phase 3 wrote it from clarify's `debt_items`, and the
   plan-review pass above appended any `steering` findings). The artifact
   must be complete before the commit — nothing after this step writes
   debt into the file.
4. Commit the feature map file on the current feature branch (capturing
   both the original feature map and any plan-review fixes in the same
   diff). Push the current branch as-is — do not rename it or prepend a
   prefix such as `feature/`. The PR must be opened against the same
   branch the operator (or upstream orchestrator) had checked out when
   render was invoked. See the branch policy below.
5. Compose the one-shot output snippet content (the format defined below).
   For a feature-map run, use the RFC folder as the spec folder and
   substitute feature counts where the snippet asks for user stories /
   functional requirements. Copy the clarify return's `assumptions` into
   the snippet's `## Assumptions` section (the snippet / PR body is the
   only Assumptions surface — the feature map artifact has no
   `## Assumptions` section), and source the `## Specification Debt`
   summary from the committed feature map per the snippet's placeholder
   guidance, so the PR body and the artifact stay in sync. Leave the
   `## PR` section unfilled for now.
6. Create a PR for the feature map artifact using the forge `gh pr create`
   pattern (Prefer `mcp__github__create_pull_request` (the GitHub MCP tool); fall back to `gh pr create` only when the MCP server is unavailable.):
   - **Title**: `Feature Map: <Milestone Title>`, under 70 characters,
     descriptive text only.
   - **Body**: the snippet content composed in the previous step (minus its
     `## PR` section) plus a relative link to the feature map file.
7. Fill the snippet's `## PR` section with the URL the previous step
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

- **DO NOT** write code or implementation details. Feature maps are "WHAT not HOW".
- **DO NOT** skip clarification. Always run smithy-clarify — it is
  non-interactive and returns assumptions and debt items directly.
- **DO NOT** stop for user approval before creating the feature map PR.
  Render is one-shot: Phase 4 writes the map, creates the PR, and renders
  the one-shot output snippet without an intermediate approval gate.
- **DO** write the feature map file to disk before creating the PR — do not
  dump the full contents into the terminal.
- **DO NOT** treat render as an entry point — it requires an existing RFC from `smithy.ignite`. If the user provides a description instead of a file path, redirect them to ignite.
- **DO** ensure each feature is a discrete unit of user-facing functionality.
- **DO** surface overlapping concerns and ambiguous boundaries during clarification.
- **DO** keep feature descriptions concise — a feature map is a breakdown, not a design doc.
- **DO NOT** expand scope to include work belonging to other milestones in the
  same RFC. Your scope is the single assigned milestone — nothing more.
- **DO NOT** ask whether to include functionality that belongs to another
  milestone. If this milestone references capabilities from another milestone,
  assume that work will be mapped separately.
- **DO** assume other milestones in the same RFC may be getting rendered in
  parallel by other agents. Each agent owns exactly one milestone.
- **DO** note cross-milestone dependencies in the feature map (as
  "Cross-Milestone Dependencies") without pulling that work into your features.
- **DO** include a `## Dependency Order` section listing every feature as a
  4-column table with `F<N>` IDs (e.g., `F1`, `F2`). Order rows by dependency
  graph — features with no dependencies come first, dependent features come
  after their prerequisites. The `Depends On` column contains `—` or a
  comma-separated list of same-table IDs. The `Artifact` column starts as `—`
  and is populated by `smithy.mark` when it creates the spec folder. Do NOT
  use checkboxes in the `## Dependency Order` section.
- **DO** type every feature with a `yaml` metadata block per the `feature-kinds`
  schema in Phase 3 (every feature has a `kind`; flag-gated UI splits into a
  `build` + `wire` pair sharing one `flag`).
- **DO** make UI fan-out evident from metadata: `kind: ui` means mark will fan
  out to screens/flows, `phase` says whether this is build or wire work,
  `design` is the explicit screen-node mode (`none`, `import`, or `brief`), and
  `screens`/`flows` name the candidate identifiers that downstream `mark` will
  turn into the typed ledger and durable artifacts. Do not rely on feature
  titles to communicate any of those facts.
- **DO** accept a supplied import bundle as feature-map context when present:
  write its repo-relative path to `bundle` on relevant `kind: ui`,
  `design: import` features, keep `design_system` as the committed dialect
  source, and derive candidate `ScreenId`/`FlowId` metadata from the prototype
  for human confirmation. `bundle` itself is not import-only — a `design: brief`
  feature may gain one later, after the visual tool answers mark's brief — so
  omit the key at render rather than treating its absence as a mode signal.
- **DO** route ambiguous import derivation to specification debt. The feature
  map should say what is unclear rather than pretending the candidate screen or
  flow structure is authoritative.
- **DO NOT** call visual design tools inline or describe inline visual-tool calls
  as part of render. Render records a supplied bundle reference; it does not
  create, modify, or round-trip a prototype.
- **DO NOT** author `.design.md`, `.flow.md`, or executable test-body files from
  render. Candidate `screens`/`flows` metadata is the handoff to `smithy.mark`,
  which owns the durable files.
- **DO** keep backend features visibly backend: emit only `kind: backend` in the
  metadata block, and do not add `phase`, `design_system`, `design`, `bundle`,
  `flag`, `screens`, or `flows` to backend feature metadata. Missing `kind` on
  legacy feature maps is still interpreted as backend during review, but new
  render output should write `kind: backend` explicitly.
- **DO** express flag-gated UI as a build + wire pair sharing exactly one
  `flag` value. The build feature may be ordered before backend prerequisites;
  attach backend prerequisites only to the wire feature's `## Dependency Order`
  row, alongside the build feature dependency. The seam must be visible from
  `phase`, the shared `flag`, and `Depends On`, not from naming convention alone.

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