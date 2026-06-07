# Data Model: Contract-Freshness Enforcement Directive

## Overview

This model supports the Smithy-agent directive that enforces subsystem contract
freshness on PRs. It defines the directive artifact, the verdict invocation it
delegates to Feature 5, the enforcement result it reports, the bounded diagnostics
it preserves for repair, and the recorded SD-002 vehicle decision. The directive
consumes Feature 5's local verdict (`npm run docs:contracts:check`) rather than
introducing a second checker or depending on live March services.

## Entities

### 1) Enforcement Directive (`enforcement_directive`)

Purpose: Represents the Smithy-agent instruction requiring a contract verdict
before a PR that can stale a subsystem contract is reported complete.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `appliesTo` | trigger rule | Yes | When the directive fires — a PR diff touching a source path mapped in `contract-freshness.config.json`. |
| `command` | literal command | Yes | `npm run docs:contracts:check` (Feature 5's verdict). |
| `nonInteractive` | boolean | Yes | Always true for autonomous agent contexts. |
| `delegatesToVerdict` | boolean | Yes | Always true; the directive consumes Feature 5's verdict instead of re-deriving freshness. |
| `failClosed` | boolean | Yes | A non-zero or unavailable verdict blocks completion. |
| `boundedDiagnostics` | boolean | Yes | Failures preserve concise verdict diagnostics, not full logs. |

Validation rules:

- `command` must reference the npm-run verdict from Feature 5; no second parser.
- The directive must not require prompts, live service readiness, or network access.
- The directive must not name AUTOGEN extraction (`docs:contracts:extract`) or a CI workflow as part of the enforcement path.

### 2) Contract Verdict Invocation (`contract_verdict_invocation`)

Purpose: Represents one execution of Feature 5's verdict command from the
directive's PR-handling context.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `repoRoot` | filesystem path | Yes | Repository checkout being changed by the PR. |
| `command` | literal command | Yes | `npm run docs:contracts:check`. |
| `changedFileInput` | repo-relative path list or git diff base | Conditional | Supplied explicitly or derived by the verdict command. |
| `exitCode` | integer | Yes | `0` means pass; non-zero means enforcement failure. |
| `diagnostics` | `VerdictDiagnostic[]` | No | Bounded diagnostics emitted by the verdict. |

Validation rules:

- The invocation must run from the repository root or an equivalent path that lets the npm script resolve local inputs.
- Non-zero exit codes are not retried through prompts or alternate ad hoc checkers.
- A missing, timed-out, or malformed verdict becomes an enforcement failure.

### 3) Enforcement Result (`enforcement_result`)

Purpose: Represents the pass/fail outcome the directive reports for a PR after
invoking the contract verdict.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `status` | enum | Yes | `pass` or `fail`. |
| `verdictExitCode` | integer | Yes | Exit code from the verdict invocation. |
| `diagnostics` | `VerdictDiagnostic[]` | No | Preserved from the verdict or synthesized only for invocation failures. |
| `blocksCompletion` | boolean | Yes | True whenever `status` is `fail`. |
| `summary` | bounded text | Yes | Deterministic agent-facing summary. |

Validation rules:

- `status` is `fail` whenever `verdictExitCode` is non-zero or the command cannot be executed.
- A failed result must block PR/slice completion.
- Summaries must not include unbounded logs or full contract contents.

### 4) Verdict Diagnostic (`verdict_diagnostic`)

Purpose: Represents one bounded contract-check finding preserved for repair
guidance.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `category` | enum/string | Yes | Verdict category: presence, section-schema, config, freshness, or invocation. |
| `ownerName` | string | Conditional | Present when the verdict associates the finding with a configured owner. |
| `sourcePath` | repo-relative path | Conditional | Present for source-drift findings. |
| `contractPath` | repo-relative path | Conditional | Present for contract-related findings. |
| `message` | bounded text | Yes | Concise diagnostic from the verdict or invocation wrapper. |

Validation rules:

- Paths must be repo-relative and must not escape the repository.
- Source-drift findings include both `sourcePath` and `contractPath` when the verdict provides them.
- The directive must not invent ownership facts absent from the verdict.

### 5) SD-002 Decision Record (`sd002_decision_record`)

Purpose: Represents the recorded operator decision that this milestone enforces
the verdict via a Smithy-agent directive rather than a CI workflow.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `chosenVehicle` | enum | Yes | `smithy-agent-directive` for this milestone. |
| `rejectedAlternative` | enum | Yes | `github-actions-workflow` (`.github/workflows/contract-freshness.yml`). |
| `reversibility` | bounded text | Yes | Reverting to the workflow alternative is cheap and deliberate. |
| `deferredEscalation` | bounded text | Yes | Structural AST-diff escalation deferred (RFC SD-002) until drift is observed. |
| `openSubQuestion` | reference | Yes | SD-011: review-advisory vs merge-blocking, unsettled. |

Validation rules:

- The record must name both the chosen and rejected vehicles.
- The record must not implement the deferred escalation; it only documents the deferral.

## Relationships

- One Enforcement Directive creates zero or more Contract Verdict Invocations across PRs.
- One Contract Verdict Invocation produces one Enforcement Result.
- One failed Enforcement Result contains one or more Verdict Diagnostics.
- One SD-002 Decision Record governs how every Enforcement Result is acted on (block vs allow).

## State Transitions

### Enforcement result lifecycle

1. `pending` → `passed`
   - Trigger: The verdict command exits `0`.
   - Effects: The directive records the contract-enforcement step as satisfied for the PR.

2. `pending` → `failed`
   - Trigger: The verdict exits non-zero, cannot be executed, times out, or emits malformed output.
   - Effects: The directive blocks completion and reports bounded diagnostics.

3. `failed` → `passed`
   - Trigger: A later repair updates the drifted contract or source and reruns the verdict successfully.
   - Effects: The PR can proceed only after the new passing result.

## Identity & Uniqueness

- A Contract Verdict Invocation is identified by `(repoRoot, command, changedFileInput, run id)` for audit purposes.
- A Verdict Diagnostic is uniquely identified within one result by `(category, ownerName, sourcePath, contractPath, message)`.
- The SD-002 Decision Record is a single, milestone-scoped record keyed by `(milestone, chosenVehicle)`.
