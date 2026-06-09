---
name: smithy.helper-voice
description: "Section-level voice and audience guidance, invoked by smithy.helper-documentation and the authoring commands/agents (render / mark / cut / engrave / ignite / spark / strike / prose) — not a direct user entry point; users reach for smithy.helper-documentation, which calls this skill. Applies when drafting or reviewing prose for any artifact: RFC/spec/PRD narrative, migration plans, ADRs, runbooks, READMEs, design docs, change notes, inline documentation, for readers spanning stakeholders, reviewers, implementers, or AI agents. Provides a Role × Diátaxis-mode taxonomy, an expanded review-mode anti-pattern checklist, conciseness budgets, diagram-first framing, depth-control rules, and AI-vs-human audience separation."
---
# smithy.helper-voice

Voice and audience taxonomy for any prose a Smithy agent produces —
planning artifacts (RFCs, feature maps, specs, tasks), forge deliverables
(READMEs, ADRs, migration plans, runbooks, inline documentation), and the
narrative paragraphs that thread them together. Load this skill in
either of two modes:

- **Draft mode** — given a section, audience, and length budget, write
  prose to convention from scratch.
- **Review / cleanup mode** — given an existing artifact, produce a
  revised version that applies the taxonomy, fixes anti-patterns,
  suggests diagrams, compresses dense Reference prose, and inserts
  audience tags. Return the original and the revised version side by
  side so a human can judge whether the new voice is an improvement —
  the side-by-side compare is the primary validation path.

---

## 1. The two axes

Pick both axes before drafting or reviewing.

**Reader role.** *Stakeholder* — non-author humans who decide whether the
work should happen (product, leadership, on-call triage); they read for
impact. *Reviewer* — peer engineers who approve or block; they read for
correctness, scope, risk. *Builder* — the engineer (human or AI) who
turns the doc into code; they read for what to do next.

**`+ai-input` flag (additive).** Append when a Smithy sub-agent or other
LLM is the primary consumer (e.g., a `Requirements` block read by
`smithy-slice`, a `.tasks.md` slice consumed by `smithy-implement`). The
base role still applies; `+ai-input` tightens structure, removes
rhetorical flourish, and prefers tables/signatures over prose.

**Diátaxis mode.** *Explanation* — understanding-oriented, narrative
prose. *Reference* — information-oriented, tables and structured
artifacts. *How-to* — task-oriented, ordered steps. *Tutorial* —
learning-oriented end-to-end walk-throughs (rare in planning, common in
onboarding docs).

A single `##` section serves exactly one Role × Mode pair. If you find
yourself blending two, split the section.

---

## 2. Review-mode anti-pattern checklist

In review mode, run every check below and flag each hit explicitly.

- **Missing diagrams.** A block, sequence, or ER diagram would carry
  the same information in less space, but the section is wall-of-text.
- **Verbosity.** More detail than the chosen reader needs at this
  depth. Often shows up as restating the goal in three sentences.
- **Depth-first tangents.** Prose dives into implementation detail
  inside a Stakeholder×Explanation, then climbs back out.
- **Commingled audiences.** One section serves humans (review,
  approval) and AI sub-agents (input to `smithy-slice`,
  `smithy-implement`) with no signal of which paragraph is which.
- **Unglossed terms-of-art.** A term-of-art is used without definition
  on its first occurrence in a section ("failover plan", "scale to 0",
  "all participants inventoried"). Flag hardest when a term one
  audience-cell owns appears inside another cell's section — an Ops term
  in a Reviewer×Explanation, a runbook step inside an Explanation.
- **Schema without a worked instance.** A schema, contract, manifest,
  or YAML/JSON shape is described in prose or as a key/type table with
  no filled-in example a reader can pattern-match against. (Distinct
  from the §5 `examples:` directive, which is about whether a *code
  snippet* suits the section's mode; this is about an *abstract
  description* lacking a concrete companion — add the worked instance,
  don't delete the description.)
- **Internals leakage.** Implementation rationale surfaces in
  reader-facing prose (Stakeholder/Reviewer Explanation, Builder
  How-to): sentences shaped like "the two lists are split because the
  role-specific fields differ" or "we did this to preserve Z". The
  reader needs *what to do* and *what it means*, not *why the
  internals are arranged this way* — push that to a child Reference
  section or cut it.
- **Conviction drift.** A sentence hedges or conditions something the
  surrounding context treats as required ("reads like this transition
  is optional when it isn't"). Match the prose's certainty to the
  thing's actual status — if the step is mandatory, say so plainly.
- **Bare cross-reference.** A cross-reference ("see Flow 3 for the
  rollback") sends the reader away without previewing, in one phrase,
  what they will find there. Add the preview: "see Flow 3, which drains
  connections before cutover."
- **Authoring-process / author-directed commentary.** Prose that
  addresses the *moment the document was written* rather than the
  reader of the finished artifact. Two flavors: (a) **temporal /
  process scaffolding** tied to the work's own trajectory — "we'll do
  this until milestone X lands", "for now we…", "we no longer need to
  Z"; and (b) **asides aimed at the human author**, as if the document
  were a chat reply — "you may want to decide…", "let me know if…",
  "note: we should revisit this". The eventual reader was not in that
  moment and was not party to that conversation, so these lines read
  as stray comments that leaked into the artifact. Fix: cut them, or
  convert to durable reader-facing statements — state current behavior
  *as* the behavior (not as a way-station toward something else), and
  move genuine open questions to a tracked location (an issue, a
  "Open Questions" section, a TODO owned by someone) rather than
  leaving them inline.

After editing, run two checks on the pass itself:

- **Diagram that doesn't earn its space.** A diagram must compress
  structure the prose cannot — not duplicate what the prose just said.
  Working ASCII art is not a defect; do not convert it to Mermaid for
  its own sake. Before adding or replacing a diagram, confirm it
  carries structure (flow, relationships, ≥3 named entities) the
  surrounding text can't.
- **Structural-vs-prose ratio.** Look at the change set. If it is
  mostly audience tags, ASCII→Mermaid swaps, and section moves while
  the prose body is essentially unchanged, the artifact has been
  *shuffled, not improved* — surface this honestly rather than
  presenting motion as progress.

> **Escalation — artifact-level commingling.** The commingled-audiences
> check above is a *section*-level fix: retag, split a section, add a
> routing signal. When
> the commingling is at the **artifact** level — the whole document
> serves three reader-cells and no amount of section retagging fixes it
> (the right answer is several artifacts plus a navigation doc) — that is
> `smithy.helper-documentation`'s job, not this skill's. Stop, flag it,
> and defer to that skill for the shape decision before doing prose work.

---

## 3. Voice rules per Role × Mode combination

| Role × Mode | Length | Diagram | Examples | Notes |
|---|---|---|---|---|
| Stakeholder × Explanation | 2-3 paragraphs | recommended | discouraged | Lead with impact, no implementation detail. |
| Reviewer × Explanation | 3-6 paragraphs | optional | recommended | Cover alternatives and tradeoffs; cite evidence. |
| Builder × Reference | tables / signatures | recommended (ER/class) | required | Compress prose into schemas, contracts, types. |
| Builder × Reference + ai-input | tables / signatures | optional | required | Machine-parseable preferred — no rhetorical bridges. |
| Builder × How-to | 5-15 ordered steps | recommended (flow/seq) | discouraged | One action per step; validate at the end. |
| Reviewer × Reference | tables | optional | recommended | Acceptance criteria, success metrics, scope rows. |

When in doubt, drop one axis to its simplest case: Reviewer × Explanation
is a reasonable default for narrative without an obvious owner.

---

## 4. Diagram guidance

A diagram beats prose when the content describes structure, flow, or
relationships between three or more named entities. Default to Mermaid —
it renders inline on GitHub and most documentation platforms — and place
the diagram immediately after the section heading, before the supporting
paragraphs. Do not invent boxes that aren't in the system: three real
nodes beat eight that include "future work".

Typical diagrams per mode:

- **Explanation** — block / architecture (`flowchart LR`, `graph TD`).
- **Reference** — entity-relationship (`erDiagram`) or class
  (`classDiagram`).
- **How-to** — flowchart (`flowchart TD`) or sequence
  (`sequenceDiagram`).
- **Tutorial** — sequence diagrams or annotated walkthroughs.

---

## 5. Embedded examples — when code helps vs. hurts

Code and interface snippets are not uniformly good. The choice is
governed by the section's mode and recorded in the `examples:` directive
(§8):

- **Reference (contracts, data models)** — `examples: required`.
  Signatures, schemas, and shape declarations *are* the deliverable.
- **How-to (`.tasks.md` slices)** — `examples: forbidden`. Concrete code
  in task bodies over-prescribes implementation and traps the builder
  into a specific approach. Describe the contract; let the implementer
  choose the body.
- **Explanation (Motivation, Personas)** — `examples: discouraged`. A
  code snippet usually signals the author drifted into implementation;
  cut it or move it to a child Reference section.
- **Explanation (Proposal, API sketch)** — `examples: recommended`. A
  small interface sketch grounds an abstract proposal — keep it under
  ten lines.

---

## 6. Reference-prose anti-pattern

A Reference-mode section that emits narrative prose has chosen the wrong
form. Two valid fixes:

1. **Compress** to a structured artifact — a table of fields, a
   TypeScript signature, a JSON schema, an ER diagram. The Reference
   deliverable is the structure, not the description of it.
2. **Mark `N/A`.** Some features have no code-shaped contract: a
   docs-only change, a process update, a configuration toggle. The
   section is one line: `N/A — <one-sentence reason>`.

Record applicability in the template's tag for this section so the
audit command knows when `N/A` is legitimate:

```
## Contracts
<!-- audience: builder; mode: reference; length: tables only; diagram: recommended; examples: required; applicability: code-shaped features only -->
```

In review mode, treat any multi-paragraph Reference section without
tables, signatures, or `N/A` as an automatic finding.

---

## 7. Depth-control rule

One level of detail per section. Stay in your Diátaxis mode; resist
"just briefly explain how" inside an Explanation, or "just sketch the
why" inside a Reference. When deeper detail is genuinely needed:

- Push Reference detail into a child file (e.g., `.data-model.md`
  splits entities and schemas out of `.spec.md`; `.contracts.md` splits
  interfaces and integration boundaries).
- Push procedural detail into a How-to child section or a sibling
  `.tasks.md`.
- Push background context into a linked ADR or RFC — do not inline it.

If a section's prose moves up and down the abstraction ladder more than
once, split it.

---

## 8. Audience tag grammar

Each section's voice is described by a small set of keys: `audience`,
`mode`, `length`, `diagram`, `examples`, and an optional
`applicability`. **For Smithy planning artifacts** (`.rfc.md`,
`.features.md`, `.spec.md`, `.tasks.md`, `.contracts.md`,
`.data-model.md`), the spec for each section lives in the *template*
used by the generating command (`smithy.ignite`, `smithy.render`,
`smithy.mark`, `smithy.cut`) — not inline in every generated artifact.
One source of truth, no per-file drift; the artifact itself stays
clean prose. `smithy.audit` enforces these specs per section via its
voice-tag lint (`snippets/audit-checklist-voice.md`): it parses the
`<!-- audience: ... -->` tags and flags unknown keys/values, length-
budget violations, and missing/forbidden diagrams and examples. The
lint currently carries the per-section specs directly; as the template
surface is wired through it will read them from the same template
files, keeping the enforcement surface and the templates in lockstep.

**For non-Smithy prose** (READMEs, ADRs, migration plans, runbooks,
inline documentation), there is no template to inherit from. Use the
taxonomy as authoring discipline — pick Role × Mode before drafting
and stay in it — but do not litter the file with HTML-comment
metadata.

Grammar (the syntax templates use):

```
## <Section title>
<!-- audience: <role>[+ai-input]; mode: <mode>; length: <budget>; diagram: <required|recommended|optional>; examples: <required|recommended|discouraged|forbidden>[; applicability: <free-text>] -->
```

Keys:

- `audience` — `stakeholder` | `reviewer` | `builder`. Append
  `+ai-input` when a sub-agent is the primary consumer
  (e.g., `builder+ai-input`).
- `mode` — `explanation` | `reference` | `how-to` | `tutorial`.
- `length` — sentence or paragraph budget (`2-3 sentences`,
  `3-6 paragraphs`, `tables only`, `5-15 steps`).
- `diagram` — `required` | `recommended` | `optional`.
- `examples` — `required` | `recommended` | `discouraged` | `forbidden`.
- `applicability` (optional) — free-text condition under which the
  section legitimately resolves to `N/A` (e.g., `code-shaped features
  only`).

Example — the `## Summary` section's voice spec, as it would appear
in a `.spec.md` template (and as the audit command would cite it in a
finding):

```
## Summary
<!-- audience: stakeholder; mode: explanation; length: 2-3 sentences; diagram: optional; examples: discouraged -->
```

---

## 9. Three worked before/after examples

### (a) Wordy / depth-first Motivation

**Before** — Stakeholder×Explanation drifting into Builder×Reference:

> The current system has a number of issues. The manual reconciliation
> between three config files takes about an hour each sprint. The
> reconciliation script is written in bash and uses `jq` to diff the
> JSON, which is brittle when fields are added. Specifically, the
> `services.yaml` file has a `replicas` field that defaults to 1, but
> some teams override it to 3 in their staging branch...

**After** — stays in Stakeholder×Explanation:

> Each sprint, teams lose roughly an hour reconciling three config
> files by hand. The brittleness compounds as the team scales: every
> new service multiplies the diff surface, and three P1 incidents last
> quarter traced back to drift the manual process missed.

The `jq` script and the `replicas` field belong in a child Reference
section, not in the Motivation.

### (b) Commingled Requirements section

**Before** — Reviewer×Explanation mixed with Builder×Reference+ai-input:

> Users should be able to see status across all artifacts. The CLI must
> emit JSON with a `nodes[]` array where each node has `id`, `kind`,
> `state`, `path`. Reviewers will want to confirm the JSON shape is
> stable before we wire status into CI.

**After** — split into two sections, each governed by its own template
voice spec (shown inline below for the reader's benefit; in real Smithy
artifacts the specs live in the template, not in the rendered file):

```
## Goals
<!-- audience: reviewer; mode: explanation; length: 1-2 paragraphs; diagram: optional; examples: discouraged -->

Users should be able to see status across all artifacts in one place,
stable enough to wire into CI.

## Status JSON Schema
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: required -->

| Field | Type | Description |
|-------|------|-------------|
| `id`   | string | Canonical artifact ID |
| `kind` | enum   | `rfc` \| `spec` \| `tasks` |
| `state`| enum   | `pending` \| `done` |
| `path` | string | Repo-relative path |
```

### (c) Dense-prose `.contracts.md` that should have been signatures or N/A

**Before** — Reference mode emitting Explanation prose:

> The voice helper skill exposes two operations to its callers. The
> first, draft mode, takes an idea and a target audience and returns
> prose. The second, review mode, takes an existing artifact and
> returns a revised version. Internally, the skill does not make any
> function calls; it is a body of guidance the calling agent reads.

**After option 1** — compress to a signature table:

| Operation | Input | Output |
|-----------|-------|--------|
| draft  | section assignment, audience, length budget | prose |
| review | existing artifact path                      | revised artifact + findings |

**After option 2** — mark `N/A` if no code-shaped contract:

> N/A — `smithy.helper-voice` is a prose-only skill; it exposes no
> function or CLI surface for other agents to call.

---

## 10. Application beyond Smithy

The same axes apply to non-Smithy prose. Pick Role × Mode first;
everything else follows.

- **Migration plan** — Reviewer × How-to. 10-20 ordered steps with a
  rollback per phase. Diagram: recommended (timeline or sequence).
  Examples: discouraged in the steps themselves; recommended in a
  prerequisite Reference child.
- **ADR (Architecture Decision Record)** — Reviewer × Explanation.
  1-2 paragraphs per Context / Decision / Consequences section.
  Diagram: recommended for Context. Examples: discouraged — an ADR
  records the choice, not the code.
- **Runbook** — Builder × How-to. Numbered steps with a validation
  command per step. Diagram: optional (sequence for multi-system
  flows). Examples: required — actual command lines.
- **README landing page** — Stakeholder × Explanation up top (what is
  this, why use it), Builder × How-to below (install / quick start).
  Two sections, two tags.
- **Inline code documentation** — Builder × Reference. One paragraph;
  diagram: optional; examples: recommended for API entry points.

For any prose deliverable, the workflow is the same: pick the role,
pick the mode, write the tag, write to the budget. When in doubt about
the right cell, draft first, then run review mode on yourself and
update the tag.

---

## Coexistence with `smithy.prose` and `smithy.helper-documentation`

`smithy.prose` (sub-agent) keeps its section-specific drafting protocol
for Summary / Motivation / Personas. This skill is the canonical home
for the shared principles (lead-with-impact, no invented figures, no
bullet-enumeration in prose) and the cross-cutting taxonomy. When both
apply, `smithy.prose` is the *how* for a specific RFC section, and this
skill is the *what voice* across every section.

`smithy.helper-documentation` is the layer **above** this skill. It owns
artifact-shape concerns — is this the right shape of artifact for the
audiences it serves, should it be N artifacts instead of one, what does
the navigation doc between them look like — and it calls this skill for
prose-level cleanup once the shape is settled. This skill owns the
*section* and *prose* level (one Role × Mode per section; voice matches
the cell; jargon glossed, examples worked, diagrams that earn their
space, cross-refs previewed) and defers artifact-level commingling
upward (see §2's escalation note). Users invoke
`smithy.helper-documentation`; this skill is reached through it or
through the authoring commands.
