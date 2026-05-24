# Contracts: PR Integration

## Overview

PR Integration defines the boundary between validated spawn output and the review surface on GitHub. It consumes Feature 5 extraction results, applies validated patches in an integration worktree, creates or reuses a commit and branch, opens or reuses a pull request, and records terminal state for orchestration.

## Types

These named types appear in the signatures below. Field-level validation rules live in the [data model](pr-integration.data-model.md).

| Type | Kind | Shape |
|------|------|-------|
| `ExtractionResult` | input | Successful Feature 5 result containing spawn ID, backend, validated patch, touched paths, and patch digest. |
| `PullRequestIntegrationInput` | input | `{ spawnId: string; extractionResultId: string; integrationBranch: string; worktreePath: string; baseBranch: string }` plus extraction metadata. |
| `PatchApplicationResult` | result | `{ status: "applied" \| "failed"; touchedPaths: string[]; diagnostic?: string }`. |
| `IntegrationCommit` | value | `{ branch: string; commitSha: string; patchSha256: string }`. |
| `PullRequestRecord` | value | `{ provider: "github"; repository: string; number: number; url: string; headBranch: string; baseBranch: string; state: string }`. |
| `PrIntegrationResult` | result | Terminal success or failure state for orchestration. |

## Interfaces

### PR Integration Runner

**Purpose**: Coordinate validated patch application, commit, push, PR creation, and terminal state recording.
**Consumers**: Hatchery manager flow, Legate orchestration.
**Providers**: PR integration module or Steward orchestration boundary.

#### Signature

```typescript
integratePullRequest(input: PullRequestIntegrationInput): PrIntegrationResult
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `spawnId` | string | Yes | Spawn whose successful extraction is being integrated. |
| `extractionResult` | ExtractionResult | Yes | Successful Feature 5 output containing the validated patch. |
| `integrationBranch` | string | Yes | Branch to apply, commit, push, and use as PR head. |
| `worktreePath` | string | Yes | Integration worktree path where the patch may be applied. |
| `baseBranch` | string | Yes | Target branch for the pull request. |
| `timeoutSeconds` | number | Yes | Bound for autonomous integration work. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `spawnId` | string | Source spawn identifier. |
| `status` | `"succeeded" \| "failed"` | Terminal integration status. |
| `application` | PatchApplicationResult | Patch application outcome, when attempted. |
| `commit` | IntegrationCommit | Commit created or reused, when available. |
| `pullRequest` | PullRequestRecord | PR created or reused, when available. |
| `failureReason` | string | Stable failure category when failed. |
| `diagnostic` | string | Bounded human-readable diagnostic. |
| `completedAt` | ISO-8601 timestamp | Time the terminal state was produced. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Extraction not successful | Failed result | No patch application, commit, push, or PR creation is attempted. |
| Spawn lifecycle mismatch | Failed result | Extraction metadata does not match recorded spawn state. |
| Patch application conflict | Failed result | Patch cannot be applied to the integration worktree. |
| Commit failure | Failed result | No focused commit can be created or identified. |
| Push failure | Failed result | Branch cannot be pushed; PR creation is skipped. |
| PR creation failure | Failed result | Branch may be pushed, but no PR is available. |
| Timeout | Failed result | Integration exceeded its configured bound and reached terminal failure. |

---

### Validated Patch Applier

**Purpose**: Apply only the Feature 5 validated patch to the integration worktree.
**Consumers**: PR Integration Runner.
**Providers**: Steward or lower-level git adapter.

#### Signature

```typescript
applyValidatedPatch(input: {
  spawnId: string;
  patchText: string;
  touchedPaths: readonly string[];
  worktreePath: string;
}): PatchApplicationResult
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `spawnId` | string | Yes | Source spawn identifier. |
| `patchText` | string | Yes | Validated patch text from Feature 5. |
| `touchedPaths` | string[] | Yes | Validated repository-relative paths from Feature 5. |
| `worktreePath` | string | Yes | Worktree where the patch may be applied. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"applied" \| "failed"` | Apply outcome. |
| `touchedPaths` | string[] | Paths affected by the applied patch. |
| `diagnostic` | string | Bounded failure detail when failed. |
| `appliedAt` | ISO-8601 timestamp | Time of successful application. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Worktree unavailable | Failed result | The target integration worktree cannot be accessed. |
| Main checkout target | Failed result | The target path resolves to the operator's main checkout. |
| No-op patch | Failed result | Patch produces no staged changes. |
| Apply conflict | Failed result | Patch cannot be applied cleanly. |
| Touched-path mismatch | Failed result | Applied changes do not match validated touched paths. |

---

### Branch Publisher

**Purpose**: Create or reuse a focused commit and push the recorded integration branch.
**Consumers**: PR Integration Runner.
**Providers**: Steward or git adapter.

#### Signature

```typescript
publishIntegrationBranch(input: {
  spawnId: string;
  branch: string;
  patchSha256: string;
  touchedPaths: readonly string[];
}): IntegrationCommit
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `spawnId` | string | Yes | Source spawn identifier. |
| `branch` | string | Yes | Exact integration branch name to push. |
| `patchSha256` | string | Yes | Digest used for idempotent retry checks. |
| `touchedPaths` | string[] | Yes | Paths allowed in the focused commit. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `branch` | string | Pushed branch name. |
| `commitSha` | string | Created or reused commit SHA. |
| `patchSha256` | string | Patch digest represented by the commit. |
| `committedAt` | ISO-8601 timestamp | Time the commit was created or identified. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Dirty unrelated changes | Publisher error | Worktree contains changes outside the validated patch. |
| Empty staged diff | Publisher error | No reviewable commit would be created. |
| Commit failure | Publisher error | Git cannot create or identify the focused commit. |
| Push failure | Publisher error | Remote push fails due to network, auth, or remote rejection. |

---

### Pull Request Publisher

**Purpose**: Open or reuse a GitHub pull request for the pushed integration branch.
**Consumers**: PR Integration Runner.
**Providers**: GitHub integration boundary.

#### Signature

```typescript
openOrReusePullRequest(input: {
  repository: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}): PullRequestRecord
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repository` | string | Yes | GitHub repository receiving the PR. |
| `headBranch` | string | Yes | Pushed integration branch. |
| `baseBranch` | string | Yes | Target branch. |
| `title` | string | Yes | Bounded PR title. |
| `body` | string | Yes | Bounded PR body with spawn traceability and diagnostics. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `"github"` | Forge provider. |
| `repository` | string | GitHub repository. |
| `number` | number | Pull request number. |
| `url` | string | Pull request URL. |
| `headBranch` | string | PR head branch. |
| `baseBranch` | string | PR target branch. |
| `state` | string | Observed PR state. |
| `observedAt` | ISO-8601 timestamp | Time the PR was created or observed. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Existing open PR | Reused record | Return the existing PR for the same head branch. |
| Existing closed PR only | Publisher error or new PR | Behavior must be explicit in implementation tasks before coding. |
| Base branch unknown | Publisher error | Do not guess a target branch. |
| GitHub auth failure | Publisher error | No PR can be created or queried. |
| GitHub network failure | Publisher error | No PR can be created or queried. |

## Events / Hooks

PR integration should expose terminal state to existing orchestration and observation surfaces. Failure modes must be observable as errored telemetry spans, and state updates must be sufficient for Legate and Herald consumers to advance without inspecting raw spawn logs.

## Integration Boundaries

- **Feature 5 (Spawn Output Extraction)**: Feature 6 consumes successful `ExtractionResult` values and must reject failed or mismatched results.
- **Hatchery**: Hatchery drives the manager flow and may launch or instruct the Steward that performs apply, commit, push, and PR work.
- **Castra / Steward**: Castra hosts the interactive Steward session; the integration contract is HTTP/session driven and must not require shelling into the operator's terminal.
- **Brood**: Brood remains the lifecycle authority for spawn, branch, worktree, and terminal integration state.
- **Herald and Legate**: Orchestration consumes terminal state and PR metadata; it does not parse raw backend output to infer integration status.
- **Git**: Git is used only against the integration worktree and recorded branch; the operator's main checkout is not the mutation target.
- **GitHub**: GitHub hosts the pull request. This feature creates or reuses PRs but does not merge them.
- **Observability**: Integration work that joins an existing trace must reuse deterministic trace identifiers and emit errored spans for terminal failures.
