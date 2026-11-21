# Triage contract

All profiles share the v1 verdict contract in `src/triage/verdict.ts`. The
published [rubric](../../../specs/2026-11-21-015-versioned-triage-verdicts/versioned-triage-verdicts.contracts.md#rubric)
has revision `baseline-1`, tracked independently of the wire schema version.
Recommender execution and calibration belong to the recommender milestone.

## Verdict validation

`validateTriageVerdict(raw)` takes raw JSON text. It returns either
`{ ok: true, verdict }` or `{ ok: false, diagnostic }`. The latter contains a
diagnostic code and a field path, with `$` identifying the document. A
rejection emits an errored `triage.verdict.validate` span when telemetry is
enabled. The span records the diagnostic code and excludes candidate content.
This follows [operating philosophy rule 3](../../operating-philosophy.md#3-failures-are-clean-exits-not-hangs).

## Recommendation

`resolveTriageDestination(verdict)` reads a validated verdict and returns
`smithy.spark`, `smithy.ignite`, `smithy.render`, `smithy.mark`, or
`smithy.strike` for the corresponding build outcome. It returns `undefined`
for `needs-definition`, `controversial`, and `close` at any confidence.

The issue and its triage note are the intended freeform inputs. Intake requires
explicit operator acceptance. Before enabling intake, milestone 6 verifies
compatibility per verb and documents any upstream mapping or seed-only handoff.
A verdict conveys a recommendation only. Dispatch and issue mutations require
separate authorization.
