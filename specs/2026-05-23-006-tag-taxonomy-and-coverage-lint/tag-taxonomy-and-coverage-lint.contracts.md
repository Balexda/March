# Contracts: Tag Taxonomy & Coverage Lint

## Overview

This feature introduces a repository-local test taxonomy contract. The runtime boundary is intentionally small: test files provide a leading tag block, and a deterministic npm-run lint validates every `*.test.ts` file against the frozen vocabulary from the layered testing RFC.

## Interfaces

### Test File Tag Block

**Purpose**: Declares the layer, determinism, and execution channel for one vitest test file.
**Consumers**: Test authors, coverage lint, future staged npm scripts, future CI jobs.
**Providers**: Every `*.test.ts` file in the repository.

#### Signature

```ts
/**
 * @l1 @deterministic @ci
 */
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `scopeTag` | enum | Yes | Exactly one of `@l0`, `@l1`, `@l2`, `@l3`. |
| `determinismTag` | enum | Yes | Exactly one of `@deterministic`, `@stochastic`. |
| `executionChannelTag` | enum | Yes | Exactly one of `@ci`, `@scheduled`. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `taxonomyTuple` | tuple | The parsed `(scope, determinism, executionChannel)` classification. |
| `scriptSelectorInput` | tags | Stable tags future scripts can filter against. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Missing leading tag block | Coverage lint failure | The file cannot be classified safely. |
| Missing axis | Coverage lint failure | One required position is absent. |
| Multiple tags from one axis | Coverage lint failure | The file has an ambiguous classification. |
| Tags only appear outside the leading block | Coverage lint failure | The declaration is not in the canonical location. |

### Coverage Lint Command

**Purpose**: Validates complete taxonomy coverage for every vitest test file.
**Consumers**: Contributors, CI, future staged pipeline setup.
**Providers**: Repository npm script and its underlying lint implementation.

#### Signature

```bash
npm run test:taxonomy
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoRoot` | path | Yes | Root used to discover `*.test.ts` files. |
| `testFiles` | path set | Yes | All matching test files outside the generated dependency directories defined by spec FR-005 (`node_modules/`, `dist/`, `.git/`). |
| `validAxes` | vocabulary | Yes | Frozen scope, determinism, and execution-channel tag sets. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `exitCode` | integer | `0` when all files are valid; non-zero when any failure exists. |
| `diagnostics` | text | File-level errors naming the path, axis, and reason. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Untagged test file | Non-zero exit with missing axes | Prevents silent CI miscategorization. |
| Duplicate axis tag (same tag repeated) | Non-zero exit naming the axis and the `duplicate` reason | Prevents ambiguous staged-script filtering. |
| Conflicting axis tags (distinct tags in one axis) | Non-zero exit naming the axis and the `conflicting` reason | Prevents ambiguous staged-script filtering. |
| Unknown taxonomy tag | Non-zero exit if it replaces a required axis | Extending the vocabulary requires an explicit future spec. |

### Documentation Baseline

**Purpose**: Keeps operator-facing testing guidance aligned with the new taxonomy and corrected L2-shaped test premise.
**Consumers**: Contributors, Test Authors, CI Failure Triagers.
**Providers**: `CONTRIBUTING.md` and `docs/testing-strategy.md`.

#### Signature

```text
CONTRIBUTING.md
docs/testing-strategy.md
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tagVocabulary` | prose | Yes | The required three-axis tag tuple. |
| `baselineDisposition` | prose | Yes | The day-one classification of existing test files. |
| `l2VitestCorrection` | prose | Yes | The three existing L2-shaped tests mock `node:child_process` and do not exercise real Docker. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `operatorGuidance` | prose | Day-to-day rule for tagging new tests. |
| `strategicReference` | prose | Strategy document remains principles-level and delegates tactical sequencing. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Docs describe the old Docker premise | Review finding | Future Feature 4 migration decisions start from incorrect facts. |
| Docs mention staged scripts as delivered | Review finding | Feature 2 owns staged scripts and CI fan-out. |

## Events / Hooks

No runtime events or hooks are introduced. The lint is a local deterministic command; later CI wiring can invoke the npm script without changing the contract.

## Integration Boundaries

- **Layered testing RFC**: Supplies the frozen vocabulary, day-one L2-shaped test list, and scope boundary rules.
- **Operating philosophy**: The lint supports clean, loud failures rather than silent misclassification or operator-discovered drift.
- **Future Feature 2 staged pipeline**: Consumes the tag tuple to filter layer-specific scripts; it owns script fan-out and runtime guards.
- **Future Feature 4 migration policy**: Consumes the corrected baseline that the three L2-shaped vitest tests mock `node:child_process` and remain vitest until a material change.
