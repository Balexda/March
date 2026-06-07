# Data Model: Staged CI Pipeline

## Overview

This feature models repository-local test execution metadata rather than durable runtime storage. Feature 1's tag tuple remains the source of truth; the staged pipeline derives npm-script selection and CI job outcomes from that tuple.

## Entities

### 1) Layered Test Script

Purpose: Represents one npm-run entrypoint for a deterministic CI layer.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | npm script name | Yes | One of `test:l0`, `test:l1`, `test:l2-cassette`, `test:l3-cassette`. Stable local and CI entrypoint. |
| `scope` | enum | Yes | One of `@l0`, `@l1`, `@l2`, or `@l3`. Exactly one per script. |
| `determinism` | enum | Yes | Always `@deterministic` for this feature. |
| `executionChannel` | enum | Yes | Always `@ci` for this feature. |
| `selector` | tag expression | Yes | Includes files whose leading tag block matches the tuple and excludes `tests/quarantine/`. |
| `untaggedGuard` | behavior | Yes | Exits non-zero when the selector matches a file with no leading tag block. |

Validation rules:
- A script selects exactly one scope layer.
- A script always includes the deterministic and CI axes.
- A script is invoked through npm, not by direct test-runner commands in documented or CI use.
- A script exits non-zero on an untagged-but-matched file rather than running it silently.

### 2) Aggregate Deterministic Gate

Purpose: Represents the rebuilt `npm test` PR gate.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `layers` | ordered script list | Yes | Runs `test:l0`, `test:l1`, `test:l2-cassette`, `test:l3-cassette` sequentially. |
| `failFast` | boolean | Yes | Stops on the first failing layer. |
| `pretestBuild` | behavior | Yes | Builds at most once; the staged scripts do not each trigger a redundant rebuild. |
| `exitCode` | integer | Yes | Non-zero if any layer fails. |

Validation rules:
- The aggregate gate runs the staged scripts sequentially and fails fast.
- The aggregate gate covers all deterministic CI tests outside quarantine.
- `npm test` is never narrowed to a single layer.
- The whole-repo coverage lint is Feature 1's, not part of this aggregate.

### 3) Staged CI Job

Purpose: Represents a named CI job that reports one layer independently.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `jobName` | text | Yes | `l0`, `l1`, `l2-cassette`, or `l3-cassette`. |
| `command` | npm command | Yes | The single `npm run test:<layer>` command the job invokes. |
| `gateRole` | enum | Yes | `l0` is the fail-fast gate; the others are parallel fan-out. |
| `dependsOn` | job reference | Yes | `l1`/`l2-cassette`/`l3-cassette` depend on `l0` succeeding; `l0` depends on nothing. |
| `nodeVersion` | matrix value | Yes | Preserves the existing Node 20/22 build matrix. |
| `result` | enum | Yes | `pass` or `fail`. |

Validation rules:
- Job names stay stable across the Node matrix.
- `l1`, `l2-cassette`, and `l3-cassette` start only after `l0` passes and run in parallel with each other.
- CI jobs do not require interactive input.
- CI jobs do not depend on live March services for M1.

## Relationships

- The Aggregate Deterministic Gate runs the four Layered Test Scripts sequentially.
- A Staged CI Job invokes exactly one `npm run test:<layer>` command.
- The `l0` Staged CI Job gates the parallel `l1`/`l2-cassette`/`l3-cassette` jobs.
- A Layered Test Script consumes Feature 1's Test File tag blocks.
- A Layered Test Script consumes Feature 3's `tests/quarantine/` exclusion path.

## State Transitions

### Staged gate lifecycle

1. `gateRunning` → `gateFailed`
   - Trigger: The `l0` layer fails (a broken-fundamentals stop-the-build) or a staged script hits an untagged-but-matched file.
   - Effects: The `l0` job fails, the parallel fan-out jobs do not run, and the PR gate is red.

2. `fanOutRunning` → `layerFailed`
   - Trigger: A selected test in `l1`, `l2-cassette`, or `l3-cassette` fails.
   - Effects: The corresponding CI job exits non-zero and the PR gate is red, with the failing layer named on the pipeline graph.

3. `running` → `passed`
   - Trigger: `l0` passes and every parallel fan-out job passes across the Node matrix.
   - Effects: The deterministic PR gate is satisfied, equivalent to `npm test`.

## Identity & Uniqueness

- A Layered Test Script is uniquely identified by its npm script name.
- A Staged CI Job is uniquely identified by its job name plus Node-version matrix value.
- The Aggregate Deterministic Gate is identified by `npm test`.
