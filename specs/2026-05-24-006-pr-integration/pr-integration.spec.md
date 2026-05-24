# Feature Specification: PR Integration

**Spec Folder**: `2026-05-24-006-pr-integration`
**Branch**: `feature/smithy/mark/march-orchestration-platform-m1-f6`
**Created**: 2026-05-24
**Status**: Draft
**Input**: `docs/rfcs/2026-001-march-orchestration-platform/01-spawn.features.md` - Feature 6: PR Integration
**Source Feature Map**: `docs/rfcs/2026-001-march-orchestration-platform/01-spawn.features.md` - Feature 6: PR Integration

## Clarifications

### Session 2026-05-24

- The referenced feature map and RFC were unavailable in the original sandbox draft; both are present in this repository, and this spec has now been reconciled against `docs/rfcs/2026-001-march-orchestration-platform/01-spawn.features.md` (Feature 6) and the existing Feature 2, Feature 3, and Feature 5 specs plus the live Hatchery, Brood, Castra, Herald, and Legate boundaries.
- Feature 6 consumes only successful Feature 5 `ExtractionResult` values. It does not parse raw backend logs, bypass patch validation, or apply arbitrary spawn output. `[Critical Assumption]`
- PR integration is performed by a Steward session hosted through Castra and driven by Hatchery; March must avoid interactive prompts inside the autonomous path and must surface escalations as terminal diagnostics or events.
- PR integration creates reviewable GitHub pull requests from validated patch artifacts. It does not merge PRs, modify the operator's main checkout directly, or perform post-merge cleanup.
- `docs/vision.md` and `docs/operating-philosophy.md` were unreadable in the original sandbox draft; both are present in this repository, and the spec has been confirmed consistent with their operating principles — no interactive surfaces inside autonomous components, minimum required access, and clean exits instead of hangs (also codified in `AGENTS.md`).

## Artifact Hierarchy

RFC -> Milestone -> Feature -> User Story -> Slice -> Tasks

## User Scenarios & Testing

### User Story 1: Gate PR Integration on Validated Extraction (Priority: P1)

As an operator, I want PR integration to start only after output extraction has produced a successful validated patch so that malformed or hostile spawn output cannot reach my repository or GitHub.

**Why this priority**: This is the trust boundary between autonomous spawn execution and repository mutation. No apply, commit, push, or PR step is safe until the extraction result is known to be successful.

**Independent Test**: Feed PR integration one successful extraction result and several failed or malformed results. Verify only the successful result starts integration and all rejected results exit cleanly without git or GitHub side effects.

**Acceptance Scenarios**:

1. **Given** an extraction result with status `succeeded`, **When** PR integration evaluates eligibility, **Then** integration proceeds using the validated patch and extraction metadata.
2. **Given** an extraction result with status `failed`, **When** PR integration evaluates eligibility, **Then** no patch is applied, no branch is pushed, no PR is created, and a bounded diagnostic is recorded.
3. **Given** a spawn has no extraction result, **When** PR integration is requested, **Then** the request fails fast with a missing-extraction diagnostic.
4. **Given** the extraction result references a backend or spawn ID that does not match the recorded spawn lifecycle state, **When** PR integration evaluates eligibility, **Then** integration fails before applying the patch.
5. **Given** a validated patch is empty after normalization, **When** PR integration evaluates eligibility, **Then** integration fails as a no-op rather than opening an empty PR.

---

### User Story 2: Apply the Validated Patch to an Integration Branch (Priority: P1)

As an operator, I want the validated patch applied only to the spawn or steward integration branch so that my main checkout remains untouched while the proposed work becomes reviewable.

**Why this priority**: Applying the patch is the first repository mutation in the PR path. It must preserve March's isolation model and produce deterministic failure states when the patch cannot be applied.

**Independent Test**: Run integration against a successful extraction result in a disposable worktree. Verify the patch is applied to the expected branch, main checkout files are unchanged, apply conflicts fail cleanly, and the result records touched paths.

**Acceptance Scenarios**:

1. **Given** a successful extraction result and an available integration worktree, **When** PR integration applies the patch, **Then** the patch is applied to the branch associated with the spawn or Steward session.
2. **Given** the operator's main checkout is separate from the integration worktree, **When** the patch is applied, **Then** the main checkout is not modified.
3. **Given** the patch no longer applies cleanly because the base changed, **When** PR integration applies it, **Then** integration fails with a conflict diagnostic and does not push a branch.
4. **Given** the patch touches paths recorded by Feature 5, **When** application succeeds, **Then** the integration result records the same touched paths for review and diagnostics.
5. **Given** the integration worktree or branch is unavailable, **When** application starts, **Then** integration exits cleanly without falling back to the operator's main checkout.

---

### User Story 3: Create a Reviewable Commit and Push Branch (Priority: P1)

As an operator, I want March to turn the applied patch into a focused commit on a pushed branch so that GitHub can host a durable review surface for the spawn's work.

**Why this priority**: GitHub PR creation depends on a pushed branch. The commit and push step must be deterministic and idempotent so retries do not create duplicate commits or unrelated branch names.

**Independent Test**: Run integration twice for the same successful extraction result. Verify the first run creates one commit and pushes the expected branch, while the retry detects the existing equivalent branch state or reuses it without duplicating commits.

**Acceptance Scenarios**:

1. **Given** patch application succeeds with file changes, **When** PR integration creates a commit, **Then** the commit contains only the validated patch changes and generated metadata required for review.
2. **Given** the integration branch name is recorded by the spawn lifecycle state, **When** the branch is pushed, **Then** the exact recorded branch name is used without adding or renaming prefixes.
3. **Given** the remote push fails because authentication or network access is unavailable, **When** PR integration pushes the branch, **Then** integration records a terminal failure and does not attempt PR creation.
4. **Given** an equivalent commit for the same extraction result already exists on the branch, **When** integration is retried, **Then** it does not create duplicate commits for unchanged patch content.
5. **Given** the working tree contains changes outside the validated patch, **When** integration prepares the commit, **Then** those unrelated changes are excluded or integration fails rather than silently committing them.

---

### User Story 4: Open or Reuse a Pull Request (Priority: P1)

As an operator, I want March to open a GitHub pull request for the pushed integration branch so that the spawn's output lands in the normal review workflow.

**Why this priority**: The PR is the primary user-facing artifact for autonomous work. Without it, the operator still has to manually discover and package the branch.

**Independent Test**: Run integration for a pushed branch with no existing PR, then rerun it for the same branch. Verify the first run opens one PR with bounded metadata and the retry reuses the existing PR.

**Acceptance Scenarios**:

1. **Given** the integration branch has been pushed and no open PR exists for it, **When** PR integration runs, **Then** it creates one pull request targeting the repository's configured base branch.
2. **Given** an open PR already exists for the integration branch, **When** integration is retried, **Then** it records and returns the existing PR instead of opening a duplicate.
3. **Given** PR creation fails due to GitHub authentication, permissions, or network failure, **When** integration runs, **Then** it records a terminal failure containing the pushed branch and a bounded diagnostic.
4. **Given** PR metadata is generated, **When** the PR body is written, **Then** it includes the spawn ID, backend, extraction summary, touched paths, and verification status without embedding unbounded raw spawn output.
5. **Given** the repository default branch cannot be determined, **When** PR integration prepares creation, **Then** it fails cleanly rather than guessing an unsafe target.

---

### User Story 5: Record Terminal Integration State for Orchestration (Priority: P2)

As Legate and Herald, we want PR integration to persist terminal state and observable metadata so that orchestration can advance, retry, or escalate without polling raw logs.

**Why this priority**: Autonomous orchestration depends on clean terminal states. This is P2 because it consumes the core apply, commit, push, and PR outcomes but does not itself create the PR.

**Independent Test**: Exercise success, extraction rejection, patch conflict, push failure, and PR creation failure. Verify each path records a terminal state, bounded diagnostics, and the same traceable spawn and PR identifiers where available.

**Acceptance Scenarios**:

1. **Given** PR integration succeeds, **When** state is read, **Then** consumers can observe the spawn ID, branch, commit SHA, PR URL, status `succeeded`, and completion timestamp.
2. **Given** PR integration fails at any step, **When** state is read, **Then** consumers can observe status `failed`, a stable failure reason, bounded diagnostic text, and any durable artifact created before failure.
3. **Given** integration is in progress beyond its configured timeout, **When** the timeout expires, **Then** the process terminates and records a timeout failure rather than hanging.
4. **Given** a new process joins an existing trace, **When** integration emits telemetry, **Then** it reuses deterministic trace identifiers and emits errored spans for failure modes.
5. **Given** orchestration polls integration state, **When** a terminal status exists, **Then** orchestration does not need to inspect container logs or Steward session output to decide the next action.

### Edge Cases

- The validated patch applies locally but produces no staged diff because equivalent changes already exist.
- The base branch has advanced and the patch no longer applies cleanly.
- GitHub reports an existing closed PR for the same branch.
- The remote branch exists but points at a different commit from the local integration branch.
- Branch push succeeds but PR creation fails.
- PR creation succeeds but state persistence fails afterward.
- A retry starts while a previous integration attempt is still running for the same spawn.
- The Steward session loses Castra connectivity mid-apply or mid-PR creation.
- Verification commands fail after the commit is created but before PR creation.
- Diagnostics include secrets or raw model output; integration must bound and redact them before persistence or PR metadata.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| US1 | Gate PR Integration on Validated Extraction | — | — |
| US2 | Apply the Validated Patch to an Integration Branch | US1 | — |
| US3 | Create a Reviewable Commit and Push Branch | US2 | — |
| US4 | Open or Reuse a Pull Request | US3 | — |
| US5 | Record Terminal Integration State for Orchestration | US1, US4 | — |

## Requirements

### Functional Requirements

- **FR-001**: PR integration MUST consume only a successful Feature 5 `ExtractionResult`; failed, missing, mismatched, or malformed extraction results MUST prevent patch application.
- **FR-002**: PR integration MUST NOT parse raw backend logs or raw spawn output as an alternate source of patch content.
- **FR-003**: PR integration MUST apply only the validated patch content from the extraction result.
- **FR-004**: PR integration MUST apply patches only in the spawn or Steward integration worktree and MUST NOT modify the operator's main checkout directly.
- **FR-005**: PR integration MUST fail cleanly when the integration worktree, branch, or lifecycle record is unavailable.
- **FR-006**: Patch application conflicts MUST produce terminal failed integration state and MUST prevent branch push and PR creation.
- **FR-007**: A successful apply MUST create or identify a focused commit containing only validated patch changes and required review metadata.
- **FR-008**: Branch push MUST use the recorded integration branch name exactly as-is, without renaming the branch or adding prefixes during PR creation.
- **FR-009**: PR integration retries for unchanged extraction results MUST be idempotent: they MUST NOT duplicate equivalent commits or open duplicate PRs.
- **FR-010**: PR integration MUST create a GitHub pull request for a pushed integration branch when no open PR already exists for that branch.
- **FR-011**: PR integration MUST reuse an existing open pull request for the same integration branch when one already exists.
- **FR-012**: PR metadata MUST include bounded spawn traceability: spawn ID, backend, branch, extraction summary, touched paths, and verification status.
- **FR-013**: PR metadata and diagnostics MUST NOT include unbounded raw spawn output, unredacted credentials, or arbitrary backend logs.
- **FR-014**: PR integration MUST record terminal success and failure states that orchestration can consume without waiting indefinitely.
- **FR-015**: PR integration MUST record stable failure reasons for extraction rejection, missing lifecycle state, patch conflict, commit failure, push failure, PR creation failure, timeout, and persistence failure.
- **FR-016**: PR integration MUST enforce a bounded timeout around autonomous Steward work and convert timeout expiry into a clean terminal failure.
- **FR-017**: When PR integration emits telemetry, failure modes MUST produce errored spans and new processes MUST reuse deterministic trace identifiers.
- **FR-018**: PR integration MUST NOT merge pull requests or perform post-merge cleanup.

### Key Entities

- **PullRequestIntegrationInput**: The backend-neutral request to integrate one successful extraction result for a recorded spawn.
- **PatchApplicationResult**: The outcome of applying the validated patch in the integration worktree.
- **IntegrationCommit**: The focused commit produced from the validated patch.
- **PullRequestRecord**: Metadata for the GitHub pull request opened or reused for the integration branch.
- **PrIntegrationResult**: Terminal state consumed by orchestration, including success, failure, diagnostics, and durable artifact identifiers.

## Assumptions

- Feature 5 owns extraction and validation; Feature 6 treats its `ExtractionResult` as the only patch input.
- Hatchery owns the manager flow that launches or drives the Steward through Castra.
- Brood remains the lifecycle authority for spawn and worktree state.
- Herald and Legate consume observable integration status but do not perform patch application themselves.
- GitHub is the PR host for this feature; other forge providers are out of scope.
- Verification is recorded when available, but this feature does not define a full CI orchestration system.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | The authoritative Feature 6 description and RFC were unavailable in the original sandbox draft, so this spec needed reconciliation against `docs/rfcs/2026-001-march-orchestration-platform/01-spawn.features.md` before cutting tasks. | Constraints | High | Medium | resolved | Resolved 2026-05-24 — feature map and RFC are present in the repo; spec reconciled against Feature 6 and confirmed consistent. |
| SD-002 | The exact persistence owner for `PrIntegrationResult` must be confirmed against the live Brood registry and any Herald projection expectations before implementation tasks are cut. | Domain & Data Model | Medium | Medium | open | — |
| SD-003 | The exact verification commands to run before PR creation are not specified here; implementation planning must decide whether to run repository defaults, spec-provided checks, or no verification in the initial slice. | Functional Scope | Medium | Medium | open | — |

## Out of Scope

- Spawn dispatch, backend selection, container execution, and sandbox policy.
- Backend output extraction, JSON parsing, and patch path validation.
- Parsing raw backend logs as a fallback patch source.
- Applying patches to the operator's main checkout.
- Merging pull requests.
- Post-merge cleanup of worktrees, branches, containers, or sessions.
- Multi-forge provider support beyond GitHub.
- Designing the complete CI/check orchestration system.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A successful extraction result is applied to an integration worktree, committed, pushed, and represented by exactly one open GitHub pull request.
- **SC-002**: Failed, missing, mismatched, or malformed extraction results create no commit, push no branch, and open no PR.
- **SC-003**: Patch conflicts, push failures, PR creation failures, and timeouts all produce terminal failed integration state with bounded diagnostics.
- **SC-004**: Retrying integration for unchanged patch content reuses existing durable artifacts where possible and does not create duplicate PRs.
- **SC-005**: Orchestration can determine the integration outcome from persisted state and PR metadata without reading raw spawn logs.
