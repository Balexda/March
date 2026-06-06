# Contracts: Test Layer Migration Policy

## Overview

This feature introduces **no programmatic interfaces, APIs, events, or OpenTelemetry spans**. Its single artifact is a written policy in `CONTRIBUTING.md`. The "contract" it establishes is a human one: a documented, citable rule that PR authors and reviewers consume to classify changes to the two governed vitest tests. This file records that human contract and the boundaries the policy must respect with adjacent features.

## Interfaces

### Test Layer Migration Policy (documentation contract)

**Purpose**: Defines, in prose, when a change to a governed L2-shaped vitest test must be ported to Cucumber.js.
**Consumers**: Test Authors touching a governed file; reviewers and CI Failure Triagers classifying a diff.
**Providers**: The "Test Layer Migration" section in `CONTRIBUTING.md`.

#### Signature

```text
classify-change(governedPath, changedSurface) -> material | nonMaterial
required-outcome(material) -> port affected scenario to Cucumber.js
required-outcome(nonMaterial) -> none (stays in vitest)
```

This is a reading-comprehension contract, not a callable function: the classification is performed by a human applying the verbatim conditions to a diff.

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `governedPath` | enum path | Yes | One of the two governed vitest files (`src/spawn/container-launch.test.ts`, `src/spawn/snapshot-build.test.ts`). |
| `changedSurface` | enum | Yes | An edit to the governed test file: its assertions, mocked process behavior, fixtures, the subsystem boundary it drives, or a non-semantic edit. A change that does not edit a governed test file is not an input to this contract. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `classification` | enum | `material` or `nonMaterial`. |
| `requiredOutcome` | enum | `portToCucumber` for material; `none` for non-material. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Governed file changed materially without a port in the same PR | Review finding | The policy is violated; the reviewer requests the port. |
| Change to a non-governed file | Out of scope | The migration trigger does not apply. |
| Ambiguous material/non-material call | Cite the policy | The verbatim conditions are the tie-breaker, not a fresh debate. |

## Events / Hooks

None. This feature adds no runtime events, metrics, logs, or spans. It is documentation.

## Integration Boundaries

- **Feature 1 (Tag Taxonomy & Coverage Lint)**: Supplies the `@l2 @deterministic @ci` tags on the governed files and the corrected "mocks `node:child_process`, no real Docker" premise. This feature records those facts; it does not assign tags or change the lint. (Feature 1's spec also tagged the since-deleted `src/hatchery/legate-container.test.ts` — see spec SD-002.)
- **Feature 2 (Staged CI Pipeline)**: Owns the staged npm scripts and CI fan-out. A scenario ported on a material change runs through Feature 2's existing L2 path; this feature defines no new script or job.
- **Feature 3 (Quarantine Routing Scaffold)**: Owns `tests/quarantine/`. This feature defines no parking mechanism and references quarantine only if a contributor independently chooses it.
- **RFC cassette substrate (M3+)**: A real Cucumber.js port consumes the step-definition library and cassette infrastructure delivered later. This feature names the port as the required outcome of a material change but does not build that infrastructure.
