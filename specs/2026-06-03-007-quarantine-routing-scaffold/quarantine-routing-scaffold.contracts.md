# Contracts: Quarantine Routing Scaffold

## Overview

This feature introduces three repository-local contracts: the quarantine routing primitive (park/restore a test), the directory-path exclusion contract that Feature 2's staged scripts consume, and the generated `tests/quarantine/INDEX.md` roster. All contracts are filesystem- and command-level — no March runtime dispatch, event-bus messages, or OpenTelemetry spans are added, because quarantine routing does not change spawn/lifecycle behavior.

## Interfaces

### Quarantine Routing Primitive

**Purpose**: Parks a failing test into `tests/quarantine/` (and restores it back out) without deleting or silencing it, then regenerates the roster.
**Consumers**: The Operator, contributors, and (later) the M6 cassette-refresh workflow.
**Providers**: The repository routing primitive (`quarantine.ts` or equivalent; its source-tree location is open per SD-101).

#### Signature

```text
quarantine.park(testPath) -> quarantinedPath
quarantine.restore(quarantinedPath) -> originPath
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `testPath` | repo-relative path | Yes | The `*.test.ts` file to park. |
| `quarantinedPath` | repo-relative path | Yes (restore) | A file currently under `tests/quarantine/`. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `quarantinedPath` | repo-relative path | New location under `tests/quarantine/` after parking. |
| `originPath` | repo-relative path | Location the test returns to on restore. |
| `indexRegenerated` | boolean | Whether `tests/quarantine/INDEX.md` was rewritten to match. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Target is not a test file | Non-zero exit, no move | Only `*.test.ts` files may be parked. |
| Target already quarantined | Deterministic no-op or non-zero exit | Never hang; report the existing state. |
| Restore target not in quarantine | Non-zero exit | Cannot restore a file that is not parked. |
| Interactive prompt required | Disallowed | The primitive must run non-interactively (operating-philosophy rule 1). |

### Directory-Path Exclusion Contract

**Purpose**: Tells Feature 2's four staged scripts which path to exclude so parked tests do not run in the deterministic gate.
**Consumers**: Feature 2's `test:l0`, `test:l1`, `test:l2-cassette`, `test:l3-cassette` scripts.
**Providers**: This feature, via the fixed `tests/quarantine/` directory path.

#### Signature

```text
exclude(path = "tests/quarantine/") for { test:l0, test:l1, test:l2-cassette, test:l3-cassette }
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `excludePath` | repo-relative path | Yes | `tests/quarantine/` — the only path the staged scripts exclude for quarantine. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `selectedFiles` | path set | Per script: layer-matching tests minus anything under `tests/quarantine/`. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| A staged script selects a quarantined file | Contract violation (Feature 2 bug) | The exclusion path must take precedence over the script's selection glob. |
| Exclusion expressed as a tag predicate | Contract violation | The contract is directory-path based by design, independent of the taxonomy. |

### Generated Quarantine Index

**Purpose**: A generated roster of currently quarantined tests, visible without reading CI internals.
**Consumers**: The Operator, the CI Failure Triager, and (later) the M6 SLA timer and weekly report.
**Providers**: The index generation step of this feature.

#### Signature

```text
generate-index(tests/quarantine/) -> tests/quarantine/INDEX.md
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `quarantineDir` | repo-relative path | Yes | `tests/quarantine/`, scanned for parked tests. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `indexPath` | repo-relative path | `tests/quarantine/INDEX.md`. |
| `entries` | list of repo-relative paths | One row per currently quarantined test; empty when none are parked. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Stale or missing entry | Regeneration failure | The index must equal the directory contents at generation time. |
| Hand-edited index | Overwritten on regeneration | The roster is generated, not authored. |

### Quarantine Documentation (`CONTRIBUTING.md`)

**Purpose**: Tells contributors how to park a test and that quarantine is a visible state, not a silence.
**Consumers**: Contributors, the Operator.
**Providers**: This feature's `CONTRIBUTING.md` update.

#### Signature

```text
CONTRIBUTING.md — quarantine routing section
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `parkInstructions` | prose | Yes | How to route a failing test into `tests/quarantine/`. |
| `visibilityStatement` | prose | Yes | That parked tests stay in the repo and on the roster, with the SLA deferred to M6. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `contributorGuidance` | prose | How and when to quarantine a test. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Doc omits the quarantine primitive | Review finding | Contributors cannot park a test the documented way. |
| Doc implies silencing | Review finding | Contradicts the visible-state policy. |

## Events / Hooks

No runtime events are introduced. CI may invoke the staged scripts (which honor the exclusion path) and the index generation step, but this feature adds no March event-bus messages or OpenTelemetry spans because it does not change runtime dispatch behavior.

## Integration Boundaries

- **Feature 1 tag taxonomy**: A parked test keeps its tag tuple; quarantine membership is location-based and does not consume or alter the taxonomy.
- **Feature 2 staged scripts**: Consume the directory-path exclusion contract. This feature provides the path; Feature 2 wires the exclusion into the four scripts.
- **Milestone M6**: The generated `INDEX.md` roster is the surface the one-week SLA timer and the weekly stochastic-suite report will read; that wiring is out of scope here.
- **Contributor documentation**: `CONTRIBUTING.md` describes the primitive so the workflow is discoverable without reading implementation code.
