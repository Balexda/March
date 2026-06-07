# Contracts: Staged CI Pipeline

## Overview

This feature introduces repository-local command and CI contracts. Test files provide tag blocks through Feature 1; npm scripts consume those tags; CI invokes the same npm scripts as staged jobs with an `l0` gate and a parallel fan-out.

## Interfaces

### Layered Npm Scripts

**Purpose**: Provide stable local entrypoints for deterministic CI test layers.
**Consumers**: Contributors, the CI workflow, future Smithy task verification.
**Providers**: `package.json` scripts and their selector implementation.

#### Signature

```bash
npm run test:l0
npm run test:l1
npm run test:l2-cassette
npm run test:l3-cassette
npm test   # sequential, fail-fast alias over the four layers above
```

These script names are pinned by the feature map and the adjacent Feature 3 quarantine-routing contract, which identifies the staged scripts that must exclude `tests/quarantine/`.

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoRoot` | path | Yes | Repository root used to discover test files. |
| `tagTuple` | tags | Yes | Leading tag block supplied by Feature 1. |
| `layer` | enum | Yes | `@l0`, `@l1`, `@l2`, or `@l3`. |
| `excludedPath` | path | Yes | `tests/quarantine/`, the Feature 3 directory-path exclusion contract. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `exitCode` | integer | `0` when the selected layer passes; non-zero on test failure or an untagged-but-matched file. |
| `diagnostics` | text | Bounded test-runner diagnostics, including which file failed the untagged-but-matched guard. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Untagged-but-matched file | Non-zero before/at layer execution | The per-script guard refuses to run a matched file with no leading tag block. |
| Selected test fails | Non-zero for that layer | Identifies the failing deterministic layer. |
| No tests selected for a layer | Explicit empty-layer behavior (SD-001) | The script must not fail mysteriously or hide selector drift. |
| Quarantined test selected | Contract violation | The path exclusion must take precedence over tag selection. |

### CI Fan-Out

**Purpose**: Report deterministic gates as independently legible staged CI jobs.
**Consumers**: CI Failure Triagers, reviewers, PR authors.
**Providers**: `.github/workflows/ci.yml`.

#### Signature

```text
l0 (fail-fast gate)
  └─ on success, fan out in parallel:
       ├─ l1
       ├─ l2-cassette
       └─ l3-cassette
(each job runs only its `npm run test:<layer>`, across the Node 20/22 matrix)
```

These are expressed as separate jobs so the reported failure identifies the layer off the pipeline graph. `l1`, `l2-cassette`, and `l3-cassette` declare a dependency on `l0` and run concurrently with each other once it passes.

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `nodeMatrix` | Node versions | Yes | Preserves the existing Node 20/22 build matrix unless a later spec changes it. |
| `npmScripts` | command set | Yes | The four `npm run test:*` layer scripts. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `jobResult` | pass/fail | Result for a named staged job. |
| `aggregatePrGate` | pass/fail | Overall deterministic CI status (l0 gate + parallel fan-out). |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| `l0` exits non-zero | Gate fails; fan-out jobs do not run | A broken-fundamentals stop-the-build. |
| A fan-out job exits non-zero | That job fails | The PR shows the named failing layer (`l1`/`l2-cassette`/`l3-cassette`). |
| A direct tool command is used instead of npm | Review finding | Violates the repository's npm-run verification contract. |
| Live service dependency is required | Review finding | M1 deterministic CI must remain local and non-interactive. |

## Events / Hooks

No runtime events, metrics, logs, or spans are introduced. This is CI and repository-script behavior only.

## Integration Boundaries

- **Feature 1 tag taxonomy & coverage lint**: Provides the valid tag tuple. This feature consumes it to select layers and does not redefine it or own the whole-repo coverage lint.
- **GitHub Actions CI**: Runs the staged npm-run jobs and reports per-layer results. The workflow must not require live March services for M1.
- **Feature 3 quarantine routing**: Provides the `tests/quarantine/` directory path this feature's staged scripts exclude; moving tests into or out of quarantine remains Feature 3's responsibility.
- **Feature 4 migration policy**: Out of scope; material-change Cucumber.js ports may later feed the L2 path, but this feature does not perform migration.
- **Operator docs**: `CONTRIBUTING.md` script references and the Pre-Release Checklist's `npm test` step are kept current as this feature lands.
