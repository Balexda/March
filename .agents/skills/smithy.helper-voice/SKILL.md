---
name: smithy.helper-voice
description: "Section-level voice and audience guidance built on a Role × Diátaxis-mode taxonomy. Use when drafting or reviewing prose for any artifact: RFC/spec/PRD narrative, migration plans, ADRs, runbooks, READMEs, design docs, change notes, inline documentation. Not a direct user entry point — artifact-level shape questions go to smithy.helper-documentation, which calls this skill."
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

Review mode works through a checklist of eleven anti-patterns plus two
self-checks on the pass itself. It lives in
[`references/review-checklist.md`](references/review-checklist.md) — read
that file whenever you are in review / cleanup mode, and run every check
in it. Draft mode does not need it.

> **Escalation — artifact-level commingling.** The commingled-audiences
> check is a *section*-level fix: retag, split a section, add a routing
> signal. When
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
clean prose, and `smithy.audit` enforces the specs per section via its
voice-tag lint (`snippets/audit-checklist-voice.md`).

**For non-Smithy prose** (READMEs, ADRs, migration plans, runbooks,
inline documentation), there is no template to inherit from. Use the
taxonomy as authoring discipline — pick Role × Mode before drafting
and stay in it — but do not litter the file with HTML-comment
metadata.

The tag syntax itself — every key, its allowed values, and a worked
example — lives in
[`references/audience-tags.md`](references/audience-tags.md). Read it
when you are writing or checking a tag; the policy above is all you need
when you are only deciding whether a tag belongs at all.

---

## 9. Reference files — load on demand

Four bundled files carry material you need only sometimes. Read the ones
your task calls for; reading all four defeats the point.

| File | Read it when |
|------|--------------|
| [`references/review-checklist.md`](references/review-checklist.md) | You are in review / cleanup mode. Mandatory there, unused in draft mode. |
| [`references/audience-tags.md`](references/audience-tags.md) | You are writing, editing, or linting an `<!-- audience: ... -->` tag. |
| [`references/worked-examples.md`](references/worked-examples.md) | You want a before/after pattern to match a finding against, or a finding needs a concrete "here is the fix" companion. |
| [`references/genre-presets.md`](references/genre-presets.md) | The deliverable is a migration plan, ADR, runbook, README landing page, or inline code documentation, and you would otherwise derive the cell from scratch. |

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
