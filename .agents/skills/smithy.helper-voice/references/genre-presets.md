# Genre presets — applying the axes beyond Smithy

The same axes apply to non-Smithy prose. Pick Role × Mode first;
everything else follows. Load this file when the deliverable is one of
the genres below and you want its preset rather than deriving one.

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
