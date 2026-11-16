# Engraved inventory payload

The wire shape of `smithy status --engraved --format json`. Read this file
only when the question is about durable commitments — decisions,
invariants, principles. Planning-artifact questions never need it.

`smithy status --engraved` reports durable knowledge — decisions, invariants,
and principles — grouped by the level whose store holds them. It is a separate
inventory, not a filter on the planning one: engraved records are graph roots
with no dependency lineage, so the `--status`, `--type`, `--all`, and graph
flags are rejected under `--engraved` rather than ignored.

The JSON payload carries:

- `levels` — one entry per level in `user` → `repo` → `project` order, each
  with its `root`, whether the store is `present`, and its `record_count`. A
  level that is absent from this list was never in scope; a level with
  `present: false` was looked at and has no store. Say which one when
  reporting coverage.
- `project` — the resolved workstream slug, or `null` when no project level
  was in play. When it is `null` and the user asked a workstream-scoped
  question, say so and mention `--project <slug>` rather than answering as if
  the project level had been read.
- `summary` — `total`, `by_level`, `by_kind`, and `drifting` (invariants whose
  ledger carries at least one `Temporary:` row).
- `records` — every record, with `id`, `kind`, `level`, `domain`, `title`,
  `status`, store-relative `path`, the recall metadata (`topics`, `scope`,
  `applies_to`), the graph edges (`establishes`, `established_by`,
  `supersedes`, `superseded_by`, `excepts`), and for invariants a `ledger`
  roll-up (`accepted`, `temporary`, `max_severity`, `derived_status`,
  `status_drift`).

Three fields report defects rather than state, and are worth surfacing unasked
when they are set: `ledger.status_drift` means the record's declared status
disagrees with its own ledger, `id_level_mismatch` means the record's `id`
prefix names a level other than the store it sits in, and
`frontmatter_mismatch` means its declared `kind` or `domain` disagrees with
that store. In all three the store is authoritative and the record needs
repair.

When answering "which rules apply here?", report the records with their level
and say which one governs: precedence is **project > repo > user**, narrower
wins. A record with a non-empty `excepts` list deliberately overrides the
broader records it names.
