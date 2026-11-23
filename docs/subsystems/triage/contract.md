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
