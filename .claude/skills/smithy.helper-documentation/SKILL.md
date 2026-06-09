---
name: smithy.helper-documentation
description: "Artifact-shape and quality review for any document — Smithy-authored or not. Use when shaping or reviewing a README, migration plan, runbook, design doc, ADR, or any document that feels long, hard to follow, incomplete, or like it serves several readers at once. Frames the document's template/genre latitude, runs an audience inventory and fit-for-purpose (split) check, reviews structure — section presence/completeness, ordering, value/non-redundancy, navigation — recommends a split / in-place restructure / leave-as-is, designs the navigation artifact when splitting, then hands each resulting artifact to the voice helper for prose-level cleanup with directed findings."
---
# smithy.helper-documentation

The artifact-shape and quality layer for documentation. It judges the document
as a whole — **is this the right *shape* of artifact for the audiences it
serves, are the right sections present in the right order, does each one earn
its place?** — and only then hands the prose work down to `smithy.helper-voice`.

Reach for it whenever a document feels long, sprawling, incomplete, or like it
is making three different readers wade through each other's material — a
500-line migration playbook, a README that is half pitch and half API
reference, a runbook missing its rollback, a design doc whose sections are in a
confusing order. It works on any document, whether or not Smithy authored it.

`smithy.helper-voice` is the layer *below* this one. It fixes prose **within**
an artifact — does each section serve one Role × Mode cleanly, is the voice
right for the cell, is jargon glossed, do diagrams earn their space. It cannot
see that an artifact is trying to be three artifacts at once, that a section a
reader needs is missing, or that two sections say the same thing — and it
should not try to. This skill makes those artifact-level diagnoses first,
reshapes if needed, and only then invokes the voice helper on the result,
**handing it the findings** so its cleanup has direction. Run this skill
**before** reaching for voice cleanup on any non-trivial document — a voice
pass on a mis-shaped or incomplete artifact produces a change set that looks
productive (audience tables, ASCII→Mermaid swaps, section moves) but leaves the
underlying problem untouched.

---

## The procedure

Run these steps in order. Step 1 sets how much structural freedom you have;
steps 2–4 are the review; step 5 is the verdict; steps 6–7 act on it.

### 1. Frame the document — governance and genre

Before judging structure, establish how much latitude you have to change it.
This is the constraint that decides whether "reorder these sections" is even a
move available to you:

- **Template-governed.** The section set, order, and per-section voice are
  fixed by a template. Smithy planning artifacts (`.rfc.md`, `.features.md`,
  `.spec.md`, `.tasks.md`, `.contracts.md`, `.data-model.md`) inherit theirs
  from the generating command (`smithy.ignite` / `render` / `mark` / `cut`),
  and `smithy.audit` enforces them; an external doc may follow a house
  template. Here you do **not** reorder, invent, or drop sections — that is the
  template's call. Confine yourself to flagging *deviations from the template*
  and *declared sections left unfilled*, and do quality work only within the
  freedom the template leaves. If the template itself looks wrong, raise that
  as a template-level finding — do not fix it per-instance.
- **Conventional genre.** README, ADR, runbook, migration plan, design doc — no
  hard template, but a well-understood expected shape (see `smithy.helper-voice`
  §10 for the per-genre voice specs). You have latitude to add missing expected
  sections, reorder for the reader, and merge redundant ones against the
  genre's conventions.
- **Free-form.** No template, no strong genre convention. Full latitude on
  structure; let audience and reading path drive the shape.

State which case applies and carry its latitude into every step below.

### 2. Audience inventory

Read the artifact (or a brief describing it). Enumerate the **reader-cells** it
tries to serve, using the voice helper's two axes — *Role* (Stakeholder,
Reviewer, Builder, optionally `+ai-input`) × *Diátaxis mode* (Explanation,
Reference, How-to, Tutorial). One cell is a Role × Mode pair, e.g.
*Reviewer × Explanation* (an internal team reading a rollout strategy) or
*Builder × How-to* (a customer team executing one service's migration).

List every cell you can find evidence for. A document that genuinely serves
one cell is the common, healthy case — say so and move fast.

### 3. Fit-for-purpose check

For each reader-cell from step 2, estimate two fractions:

- **Needs** — what fraction of the artifact does this reader actually need?
- **Skips** — what fraction do they read past to find their part?

Then apply the heuristic:

> **If no single reader-cell needs more than ~60% of the artifact, the artifact
> is mis-shaped.** It is multiplexing audiences, and every reader pays the tax
> of scrolling past the others' material.

The 60% line is a prompt, not a law — a 55/45 split between two tightly related
cells may be fine; a doc where three cells each need ~33% almost never is. Use
judgment, but make the call explicit.

### 4. Artifact-quality review

Within the latitude from step 1, examine the document **as a whole** — not its
prose (that is the voice helper's job in step 7), but its structure and
content. Record findings under each heading:

- **Presence / completeness.** Are the sections this kind of document needs
  actually here? A README without install / quick-start, an ADR without
  Consequences, a runbook without a rollback or per-step validation, a
  migration plan without prerequisites — each is a hole the reader falls into.
  List what's missing. (Template-governed: check declared sections are filled
  rather than skipped; do not invent new ones.)
- **Ordering / reading path.** Do sections appear in the order the primary
  reader needs them? Front-load what most readers want; "what / why" before
  "how"; prerequisites before steps; context before decision. A reader should
  be able to stop early once their question is answered. (Template-governed:
  order is fixed — skip this unless the template order itself is the finding.)
- **Section value / non-redundancy.** Does each section earn its place? Flag
  three things: (1) a **zero-value section** — one that adds nothing a reader
  of this document needs (a restatement of the obvious, boilerplate the genre
  doesn't require, a "Notes" dumping ground, a placeholder never filled in) —
  recommend cutting it outright; (2) a section that restates another; (3) two
  sections covering the same ground from slightly different angles — recommend
  merging. This is *artifact-level* value and redundancy, distinct from the
  voice helper's within-section verbosity check (which trims bloat *inside* a
  section that does earn its place). The test: if the section were deleted,
  would any reader-cell from step 2 lose something they need? If no, cut it.
- **Navigation / findability.** For anything long or multi-part, can a reader
  locate their section — a table of contents, a routing table, headings that
  mean something on their own? (When the verdict is a split, this becomes the
  navigation artifact in step 6.)

### 5. Recommendation

Produce exactly one verdict, naming the specific structural edits it implies:

| Verdict | When | What you output |
|---------|------|-----------------|
| **Well-shaped — voice-only pass** | One dominant cell (needs > ~60%); complete, sensibly ordered, no redundant sections. | A one-line confirmation, then go to step 7. |
| **In-place restructure** | Audiences and material belong in one artifact, but structure is off — missing sections, wrong order, redundant or low-value sections. | A concrete edit list — sections to add, reorder, merge, or cut — plus a proposed final outline. (Template-governed: instead give a list of template deviations and unfilled sections; do **not** propose reordering or new sections.) Then step 7. |
| **Multi-artifact split** | Several cells each need a large fraction and the material separates cleanly (the migration-docs case). | A proposed set of narrow artifacts — one per reader-cell or migration shape — plus a navigation artifact (step 6). Then step 7 on each. |

State *why* — cite the cells and fractions from step 3 and the specific
quality findings from step 4 that drove the verdict. The verdict is a
recommendation surfaced to the calling agent or user, not a unilateral rewrite:
surface the proposed shape before moving or cutting large amounts of content.

### 6. Navigation/index design (when splitting)

A multi-artifact split is only an improvement if a reader can find their
artifact. When you recommend a split, also propose the **navigation artifact**:

- A short overview/index doc (Stakeholder × Explanation up top, then a routing
  table).
- A routing table mapping reader-cell → artifact: *"Running one service's
  cutover? → `cutover-runbook-<topic>.md`. Reviewing the rollout strategy? →
  `migration-overview.md`."*
- The one-line purpose of each split artifact, so the index previews each
  destination (the voice helper's bare-cross-reference rule applies here too).

Keep the navigation doc thin — it routes, it does not re-explain.

### 7. Hand off to the voice helper — with findings

Once the shape is settled (whether you split, restructured, or confirmed
well-shaped), invoke `Skill("smithy.helper-voice")` on each resulting
artifact for prose-level cleanup. Use the voice helper's **review / cleanup
mode** for existing artifacts and its **draft mode** when writing a new split
or navigation artifact from scratch.

**Pass it the relevant findings so the cleanup has direction.** The voice
helper still runs its full review-mode checklist — but seed it with what this
pass already learned, so it works targeted instead of blind. For each artifact
(and where useful, each section), hand over:

- The reader-cell each section is meant to serve (Role × Mode), from step 2 —
  so the voice helper knows the cell to hold each section to.
- The quality findings from step 4 that prose cleanup should resolve — e.g.
  "the *Cutover* section is Builder × How-to but has no per-step validation",
  "*Background* and *Context* overlap — voice pass should tighten the survivor",
  "terms-of-art `scale to 0` / `failover plan` are unglossed on first use".
- The genre/template latitude from step 1 — so the voice helper does not
  propose structural moves that this layer has already ruled out.

These findings are *direction, not a cap*: the voice helper may surface more.
The point is that nothing this pass already diagnosed gets rediscovered from
scratch or, worse, dropped.

---

## Cheap pass-through

This skill must not become a tax on well-shaped input. If steps 2–4 find a
single reader-cell with a complete, sensibly ordered, non-redundant body — a
focused README, a single runbook — do **not** manufacture a fuller analysis.
Record a one-line "well-shaped, single cell" verdict and hand straight to
`Skill("smithy.helper-voice")` (still passing the cell as direction, per step
7). The latency cost on healthy input is small; the payoff is that the "I just
want one section polished" request still routes through here and the
mis-shaped / incomplete-artifact footgun stays unreachable.

---

## Responsibility split with `smithy.helper-voice`

| Concern | Owned by |
|---------|----------|
| Is this the right *shape* of artifact for the audiences it serves? | helper-documentation |
| Should this be N artifacts instead of 1? | helper-documentation |
| Are the expected sections present, and is anything missing? | helper-documentation |
| Are the sections in an order that serves the reader? | helper-documentation |
| Does each section earn its place, or do two say the same thing? | helper-documentation |
| What does the navigation doc between split artifacts look like? | helper-documentation |
| Within this artifact, does each section serve one Role × Mode cleanly? | helper-voice |
| Within this section, does the prose voice match the cell? | helper-voice |
| Is jargon glossed, are examples worked, do diagrams earn their space, are cross-refs previewed? | helper-voice |

Structural decisions stop at the template's edge: for a template-governed
artifact, presence and ordering are the template's (and `smithy.audit`'s) to
own — this skill flags deviations rather than overriding them.

**Worked example — the four migration playbooks.** Four ~500-line docs, one per
flow, each serving three cells at once: an internal team reviewing the rollout
(Reviewer × Explanation), a customer team executing one service's migration
(Builder × How-to), and a cutover driver running one topic's phased cutover
(Reviewer × How-to). Fit-for-purpose check: no cell needed more than ~40% of
any doc → mis-shaped at the artifact level. The quality review also found a
missing prerequisites section and two overlapping "background" sections. A
voice-only pass here (audience tables, ASCII→Mermaid, one section move) treated
the symptom and produced +212/−182 lines that did not move the needle. The
right shape: narrow per-shape how-to guides (one per migration shape), separate
cutover runbooks (one per topic), and a single navigation/overview doc routing
each reader to theirs — **then** a voice pass on each thin artifact, handed the
per-section cells and the unresolved quality findings as direction.
