# Contracts: PR Integration

## Overview

PR Integration defines the boundary between validated spawn output and the review surface on GitHub. It consumes Feature 5 extraction results, applies validated patches in an integration worktree, creates or reuses a commit and branch, opens or reuses a pull request, and records terminal state for orchestration.

## Types

These named types appear in the signatures below. Field-level validation rules live in the [data model](pr-integration.data-model.md).

| Type | Kind | Shape |
|------|------|-------|
| `ExtractionResult` | input | Successful Feature 5 result containing spawn ID, backend, validated patch, touched paths, and patch digest. |
| `PullRequestIntegrationInput` | input | `{ spawnId: string; backend: "claude-code" \| "codex"; extractionResult: ExtractionResult; integrationBranch: string; worktreePath: string; baseBranch: string; timeoutSeconds: number; requestedAt: string }`. |
| `PatchApplicationResult` | result | `{ spawnId: string; status: "applied" \| "failed"; touchedPaths: string[]; diagnostic?: string; appliedAt?: string }`. |
| `IntegrationCommit` | value | `{ spawnId: string; branch: string; commitSha: string; patchSha256: string; committedAt: string }`. |
| `PullRequestRecord` | value | `{ provider: "github"; repository: string; number: number; url: string; headBranch: string; baseBranch: string; state: "open" \| "closed" \| "merged"; createdAt?: string; observedAt: string }`. |
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
| `backend` | `"claude-code" \| "codex"` | Yes | Backend recorded by spawn lifecycle state and extraction. |
| `extractionResult` | ExtractionResult | Yes | Successful Feature 5 output containing the validated patch. |
| `integrationBranch` | string | Yes | Branch to apply, commit, push, and use as PR head. |
| `worktreePath` | string | Yes | Integration worktree path where the patch may be applied. |
| `baseBranch` | string | Yes | Target branch for the pull request. |
| `requestedAt` | ISO-8601 timestamp | Yes | Time integration was requested. |
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
| Unexpected staged tree | Publisher error | The staged tree differs from the validated patch result, including extra edits on touched paths. Unstaged changes are excluded. |
| Empty staged diff | Publisher error | No reviewable commit would be created. |
| Commit failure | Publisher error | Git cannot create or identify the focused commit. |
| Push failure | Publisher error | Remote push fails due to network, auth, or remote rejection. |

---

### Pull Request Publisher

**Purpose**: Open or reuse a GitHub pull request for the pushed integration branch.
**Consumers**: PR Integration Runner.
**Providers**: Castra-hosted Steward review and the GitHub API under the repository-scoped Steward entitlement.

#### Signature

```typescript
openOrReusePullRequest(input: {
  repository: string;
  commit: IntegrationCommit;
  baseBranch?: string;
  metadata: PullRequestMetadata | (() => Promise<PullRequestMetadata | "review_failed" | "timeout">);
}): Promise<PullRequestPublication>
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repository` | string | Yes | GitHub repository receiving the PR. |
| `commit` | IntegrationCommit | Yes | Verified pushed commit and exact integration branch. Its source repository is the pushed origin. |
| `baseBranch` | string | No | Preferred target branch. Fall back to the authoritative repository default when the preferred branch is absent. |
| `metadata` | PullRequestMetadata or review callback | Yes | Bounded title and body with validated spawn traceability. A fresh PR in the Hatchery flow requires an approving Steward receipt. |

#### Outputs

`PullRequestPublication` is `succeeded` with a `pullRequest` record or
`failed` with a stable `failureReason`, pushed `branch` and `commit`,
and a bounded `diagnostic`. Base failures can include `existingPullRequest`.

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
| Existing open PR | Reused record | Match the target repository, source repository, exact head, and resolved base. |
| Existing closed PR only | New PR | Attempt creation after resolving the base and obtaining metadata. |
| Open PR has a different base | `base_mismatch` | Return the mismatched record when no open PR matches the resolved base. |
| Base branch unknown | `base_unresolved` | Return any matched open PR for context. Skip creation. |
| GitHub auth or permission failure | `unauthorized` or `forbidden` | Return a bounded failure. |
| GitHub network failure or timeout | `network` or `timeout` | Recheck for an exact open PR if creation may have succeeded. |

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
