---
applyTo: "**/*.rfc.md,**/*.features.md,**/*.spec.md,**/*.data-model.md,**/*.contracts.md,**/*.tasks.md,**/*.strike.md,**/*.prd.md"
excludeAgent: "coding-agent"
---
<!-- Smithy-general layer: true in any repository that uses Smithy. Keep repository-specific rules out of this file. -->

# Reading Smithy planning artifacts

These files are plans. Smithy commands write them; later commands and the
person steering the work read them. Before commenting on one, load the
`smithy-review-planning` skill and follow it: it holds the review procedure
and the per-artifact checks. This file covers only how to read an artifact
correctly.

## The lineage

| Artifact | Holds | Row IDs | Written by |
|----------|-------|---------|------------|
| `.rfc.md` | milestones | `M1`, `M2` | `smithy.ignite` |
| `.features.md` | features | `F1`, `F2` | `smithy.render` |
| `.spec.md`, with `.data-model.md` and `.contracts.md` | user stories | `US1`, `US2` | `smithy.mark` |
| `.tasks.md` | slices, inline | `S1`, `S2` | `smithy.cut` |

## Conventions

- A parent links to its children through a `## Dependency Order` table with
  four columns: `ID | Title | Depends On | Artifact`. That table is the link,
  not filenames, prose, or folder layout.
- A spec for a UI feature uses a six-column typed ledger in that section
  instead: `ID | Kind | Title | Depends On | Design | Artifact`, with `SC<N>`
  screen rows, `FL<N>` flow rows, and `US<N>` story rows. Both shapes are
  valid. Do not ask for one to be converted to the other.
- `Depends On` lists IDs from the same table, or `—`. `Artifact` is a
  repo-relative path to the child, or `—` when it does not exist yet. Slice
  rows always use `—`. Checkboxes are not valid in this table.
- `AS 2.1` is the first acceptance scenario of user story 2 in the parent
  spec, which numbers them 1, 2, 3 under each story. Tasks cite scenarios by
  that ID on purpose.
- `SD-NNN` rows under `## Specification Debt` are choices waiting on a
  person. `IQ-NNN` rows under `## Open Implementation Questions` are unknowns
  the implementer settles by building.
- Older table shapes in files the change did not touch are not findings.
