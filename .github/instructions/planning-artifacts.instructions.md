---
applyTo: "specs/**,docs/rfcs/**"
excludeAgent: "coding-agent"
---
# Planning artifacts in this repository

The general rules for Smithy artifacts apply. These are specific to March:

- **Check claims against the source.** A spec or tasks file that names a
  route count, record field, endpoint, contract file, or parameter
  behaviour must match `src/` and `docs/subsystems/` at the pull request's
  head. A mismatch is the most valuable finding on these files. When the
  right answer is a design choice, expect an `SD-NNN` row, not a redesign
  inside the cut.
- **Match sibling files.** Within one spec folder, follow the convention its
  other tasks files already use: the `Artifact` cell form, voice-tag length
  budgets, how inherited debt is marked resolved. An inconsistency across
  siblings is a cleanup of its own, not a finding on the newest file.
- **Checked boxes are the loop's signal.** The Legate loop marks a slice done
  by its checked tasks. Do not ask for boxes to be unchecked because a
  sibling story is unfinished.
- **The philosophy is cited, not restated.** A spec that trades operator
  intervention for automation cites `docs/vision.md` and
  `docs/operating-philosophy.md`. One that breaks a rule of thumb without
  saying so, or without revising that document, is a **Steering question:**.
- **The open-core line.** A plan that puts private-layer behaviour (agentic
  judgment, the action console, enterprise connectors) in this repository,
  or makes the engine depend on it, conflicts with
  `docs/open-core-boundary.md`. Raise it as a **Steering question:**.
- **Planning changes carry no runtime code.** A `mark` or `cut` pull request
  changes only `specs/`, the parent's `Artifact` cell, and corrections
  written back to parents.
