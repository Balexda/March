# Contract: Triage

All profiles share the v1 verdict contract in `src/triage/verdict.ts`. The
published [rubric](../../../specs/2026-11-21-015-versioned-triage-verdicts/versioned-triage-verdicts.contracts.md#rubric)
has revision `baseline-1`, tracked independently of the wire schema version.
Recommender execution and calibration belong to the recommender milestone.

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

- `TriageJudgmentProvider.judge(input)` receives the untrusted issue title and
  body, available repository context as a read-only list of text snippets, and
  the selected rubric revision. Baseline and substitute providers use this
  interface and return untrusted JSON text. The deterministic writer owns any
  later GitHub writes.
  [Operating philosophy rule 2](../../operating-philosophy.md#2-minimum-required-access-not-zero-access)
- `evaluateTriageJudgment(provider, input)` passes the raw output to
  `validateTriageVerdict` before a verdict becomes eligible for recording.
- `validateTriageVerdict(raw: string): VerdictValidation` validates raw JSON
  text. It returns `{ ok: true, verdict }` for an eligible `TriageVerdictV1`, or
  `{ ok: false, diagnostic }`. The diagnostic contains a code and a field path,
  with `$` identifying the whole document.
- `resolveTriageDestination(verdict: TriageVerdictV1)` reads a validated verdict.
  It returns `smithy.spark`, `smithy.ignite`, `smithy.render`, `smithy.mark`, or
  `smithy.strike` for the matching build outcome, and `undefined` otherwise.
- `TRIAGE_SCHEMA_VERSION` (`1`) and `TRIAGE_RUBRIC_REVISION` (`baseline-1`)
  name the wire schema and the rubric revision.
- `TRIAGE_LABEL_CATALOG` in `src/triage/labels.ts` defines the shared GitHub
  [label names and groups](../../../specs/2026-11-23-018-github-triage-labels-and-signals/github-triage-labels-and-signals.contracts.md#label-catalog).
  Outcome and confidence values come from the v1 verdict vocabulary. Acceptance
  and resubmit are operator-owned signals.
- `provisionTriageLabels(options)` in `src/triage/provision-labels.ts` reads
  Herald's active profiles and resolves GitHub identity from each registered
  checkout's origin. The caller supplies `tokenForRepository(repository, signal)`,
  which returns a credential restricted to that repository with GitHub Issues
  write access. Provisioning uses it to list and create repository label definitions.
  The caller may set `heraldUrl` and the per-operation `timeoutMs` (15 seconds by
  default). Local Git lookup uses the shared five-second bound.
  [March vision](../../vision.md) ·
  [Operating philosophy](../../operating-philosophy.md#three-rules-of-thumb)

The issue and its triage note are the intended freeform inputs to the
recommended verb. Intake requires explicit operator acceptance. Before intake
is enabled, milestone 6 checks compatibility for each verb and documents any
upstream mapping or seed-only handoff.

## Invariants

- Every profile uses the same v1 vocabulary: eight outcomes (`spark`, `ignite`,
  `render`, `mark`, `strike`, `needs-definition`, `controversial`, `close`),
  three confidence levels (`high`, `medium`, `low`), and three needs-definition
  grades (`minor-gaps`, `major-gaps`, `insufficient`).
- A verdict is eligible only when the input is a single JSON object with exactly
  the v1 fields: `schemaVersion`, `outcome`, `confidence`, and a nonblank
  `rationale`. The `needsDefinition` object, with a `grade` and a nonblank
  `explanation`, is required for `needs-definition` and forbidden for every
  other outcome.
- `resolveTriageDestination` is read-only. It returns `undefined` for
  `needs-definition`, `controversial`, and `close` at any confidence. A verdict
  conveys a recommendation only. Dispatch, closure, and other issue mutations
  require separate authorization.
- Provisioning deduplicates GitHub repositories by case-insensitive identity.
  A successful result reports `created` and `alreadyPresent` names for each
  repository. It creates only missing definitions and preserves existing colors,
  descriptions, unrelated labels, and issue assignments. A concurrent create
  counts as already present after a read confirms the name.

## Error Modes

A rejected candidate returns `{ ok: false, diagnostic }` and no verdict. The
possible diagnostics are:

| Condition | Code | Field |
|---|---|---|
| Malformed JSON, empty input, or more than one document | `invalid-json` | `$` |
| A duplicate key in any object, at any depth | `duplicate-key` | `$` |
| An extra field, or `needsDefinition` on a non-needs-definition outcome | `unknown-field` | `$` or `$.needsDefinition` |
| `schemaVersion` is not the number `1` | `unsupported-version` | `$.schemaVersion` |
| A required field is absent | `missing-field` | path of the missing field |
| The input is not an object, or a value has the wrong type or is out of vocabulary | `invalid-value` | `$` or the field path |

When telemetry is enabled, every rejection also emits an errored
`triage.verdict.validate` span. The span records `triage.validation.code` and
no candidate content. This follows
[operating philosophy rule 3](../../operating-philosophy.md#3-failures-are-clean-exits-not-hangs).

Provisioning returns `{ ok: false, operation, reason }` if it cannot confirm
full coverage. It includes the repository, profile, or label when available.
It also marks the `triage.labels.provision` span as errored when tracing is
enabled. A retry reads the current catalog and fills the remaining gaps.
