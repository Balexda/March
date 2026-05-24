# Data Model: PR Integration

## Overview

PR Integration turns a successful output-extraction result into a reviewable pull request while preserving the spawn isolation boundary. The model records the request, patch application, commit, PR, and terminal result so orchestration can observe success or failure without scraping logs.

## Entities

### 1) Pull Request Integration Input (`pull_request_integration_input`)

Purpose: Represents one request to integrate a validated patch for a recorded spawn.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `spawnId` | string | Yes | Identifier of the spawn whose output is being integrated. |
| `backend` | `"claude-code" \| "codex"` | Yes | Backend recorded by spawn lifecycle state and extraction. |
| `extractionResult` | `ExtractionResult` | Yes | Resolved successful Feature 5 result; carries the validated patch text, touched paths, and patch digest. |
| `patchSha256` | string | Yes | Digest of the validated patch (from `extractionResult`), used for idempotent retry checks. |
| `integrationBranch` | string | Yes | Branch that receives the commit and is pushed for review. |
| `worktreePath` | string | Yes | Integration worktree where the patch may be applied. |
| `baseBranch` | string | Yes | Pull request target branch resolved for the repository. |
| `timeoutSeconds` | number | Yes | Bound for autonomous integration work. |
| `requestedAt` | ISO-8601 timestamp | Yes | Time integration was requested. |

Validation rules:
- `spawnId`, `backend`, and `patchSha256` must match `extractionResult`.
- `worktreePath` must identify the spawn or Steward integration worktree, not the operator's main checkout.
- `integrationBranch` must be used exactly as recorded.

### 2) Patch Application Result (`patch_application_result`)

Purpose: Records whether the validated patch was applied to the integration worktree.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `spawnId` | string | Yes | Source spawn identifier. |
| `status` | `"applied" \| "failed"` | Yes | Terminal apply status. |
| `touchedPaths` | string[] | Yes | Normalized repository-relative paths from the validated patch. |
| `diagnostic` | string | No | Bounded diagnostic when application fails. |
| `appliedAt` | ISO-8601 timestamp | No | Present when status is `applied`. |

Validation rules:
- `status: "applied"` requires a non-empty touched-path list.
- `status: "failed"` requires a bounded diagnostic.
- `touchedPaths` must match the extraction result's validated touched paths.

### 3) Integration Commit (`integration_commit`)

Purpose: Represents the focused commit created from the applied patch.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `spawnId` | string | Yes | Source spawn identifier. |
| `branch` | string | Yes | Integration branch containing the commit. |
| `commitSha` | string | Yes | Commit created or reused for the patch. |
| `patchSha256` | string | Yes | Digest of the validated patch content. |
| `committedAt` | ISO-8601 timestamp | Yes | Time the commit was created or identified. |

Validation rules:
- One unchanged patch digest for one spawn should map to one equivalent integration commit.
- The commit must contain only validated patch changes and required review metadata.

### 4) Pull Request Record (`pull_request_record`)

Purpose: Captures the GitHub pull request opened or reused for the integration branch.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `provider` | `"github"` | Yes | Forge provider for this feature. |
| `repository` | string | Yes | Repository owner/name or canonical remote identifier. |
| `number` | number | Yes | Pull request number. |
| `url` | string | Yes | Browser URL for the pull request. |
| `headBranch` | string | Yes | Integration branch used as PR head. |
| `baseBranch` | string | Yes | Target branch. |
| `state` | `"open" \| "closed" \| "merged"` | Yes | Observed PR state. |
| `createdAt` | ISO-8601 timestamp | No | Present when March created the PR. |
| `observedAt` | ISO-8601 timestamp | Yes | Time this record was observed or updated. |

Validation rules:
- `headBranch` must equal the recorded integration branch.
- An existing open PR for the same branch must be reused instead of creating a duplicate.

### 5) PR Integration Result (`pr_integration_result`)

Purpose: Terminal outcome consumed by Hatchery, Herald, and Legate.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `spawnId` | string | Yes | Source spawn identifier. |
| `status` | `"succeeded" \| "failed"` | Yes | Terminal integration status. |
| `failureReason` | string | No | Stable category when status is `failed`. |
| `diagnostic` | string | No | Bounded human-readable diagnostic. |
| `application` | PatchApplicationResult | No | Patch application outcome, when attempted. |
| `commit` | IntegrationCommit | No | Commit metadata, when created or reused. |
| `pullRequest` | PullRequestRecord | No | PR metadata, when created or reused. |
| `completedAt` | ISO-8601 timestamp | Yes | Time integration reached a terminal state. |

Validation rules:
- `status: "succeeded"` requires `application`, `commit`, and `pullRequest`.
- `status: "failed"` requires `failureReason` and a bounded diagnostic.
- Diagnostics must not include unbounded raw backend output or unredacted credentials.

## Relationships

- One successful extraction result may produce zero or one current `PrIntegrationResult`.
- One successful `PrIntegrationResult` owns one `PatchApplicationResult`, one `IntegrationCommit`, and one `PullRequestRecord`.
- One integration branch may have zero or one open `PullRequestRecord`.
- `patchSha256` links `PullRequestIntegrationInput` and `IntegrationCommit` for retry deduplication.

## State Transitions

### PR integration lifecycle

1. `requested` -> `eligible`
   - Trigger: A successful extraction result and matching lifecycle state are found.
   - Effects: The integration input is accepted for patch application.

2. `requested` -> `failed`
   - Trigger: Extraction is missing, failed, mismatched, or malformed.
   - Effects: A failed result is persisted without repository or GitHub side effects.

3. `eligible` -> `applied`
   - Trigger: The validated patch applies cleanly in the integration worktree.
   - Effects: A patch application result records touched paths.

4. `eligible` -> `failed`
   - Trigger: Worktree, branch, no-op, or patch conflict failure.
   - Effects: No branch push or PR creation occurs.

5. `applied` -> `committed`
   - Trigger: A focused commit is created or an equivalent commit is identified.
   - Effects: Commit metadata is available for push.

6. `committed` -> `pushed`
   - Trigger: The integration branch is pushed to the remote.
   - Effects: PR creation or lookup may proceed.

7. `pushed` -> `succeeded`
   - Trigger: A GitHub pull request is created or an existing open PR is reused.
   - Effects: Terminal success records PR metadata.

8. `applied` -> `failed`, `committed` -> `failed`, or `pushed` -> `failed`
   - Trigger: Commit, push, PR creation, timeout, or persistence failure.
   - Effects: Terminal failure records the furthest durable artifact reached.

## Identity & Uniqueness

- `PrIntegrationResult` is unique by `spawnId`.
- `IntegrationCommit` is deduplicated by `spawnId` plus `patchSha256`.
- `PullRequestRecord` is deduplicated by repository plus head branch while the PR is open.
- Retries for unchanged extraction content should converge on the same branch, equivalent commit, and same open PR.
