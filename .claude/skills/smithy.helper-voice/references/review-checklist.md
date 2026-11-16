# Review-mode anti-pattern checklist

Run every check below and flag each hit explicitly. The two axes and the
per-cell voice rules are in `SKILL.md`; this file is the checklist review
mode works through.

- **Missing diagrams.** A block, sequence, or ER diagram would carry
  the same information in less space, but the section is wall-of-text.
- **Verbosity.** More detail than the chosen reader needs at this
  depth. Often shows up as restating the goal in three sentences.
- **Depth-first tangents.** Prose dives into implementation detail
  inside a Stakeholder×Explanation, then climbs back out.
- **Commingled audiences.** One section serves humans (review,
  approval) and AI sub-agents (input to `smithy-slice`,
  `smithy-implement`) with no signal of which paragraph is which.
  Artifact-level commingling escalates out of this skill — see the
  escalation note in `SKILL.md` §2.
- **Unglossed terms-of-art.** A term-of-art is used without definition
  on its first occurrence in a section ("failover plan", "scale to 0",
  "all participants inventoried"). Flag hardest when a term one
  audience-cell owns appears inside another cell's section — an Ops term
  in a Reviewer×Explanation, a runbook step inside an Explanation.
- **Schema without a worked instance.** A schema, contract, manifest,
  or YAML/JSON shape is described in prose or as a key/type table with
  no filled-in example a reader can pattern-match against. (Distinct
  from the `examples:` directive in `SKILL.md` §5, which is about
  whether a *code snippet* suits the section's mode; this is about an
  *abstract description* lacking a concrete companion — add the worked
  instance, don't delete the description.)
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
