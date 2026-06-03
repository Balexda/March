# Feature Specification: Spawn Output Extraction

**Spec Folder**: `2026-05-21-005-spawn-output-extraction`
**Branch**: `feature/smithy/mark/march-orchestration-platform-m1-f5`
**Created**: 2026-05-21
**Status**: Draft
**Input**: `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md` - Milestone 1: Spawn
**Source Feature Map**: `docs/rfcs/2026-001-march-orchestration-platform/01-spawn.features.md` - Feature 5: Spawn Output Extraction

## Clarifications

### Session 2026-05-21

- The source feature map (`docs/rfcs/2026-001-march-orchestration-platform/01-spawn.features.md`) and its RFC are present in the repository and are the authoritative source for this spec. The spec was additionally cross-checked against the existing F2, F3, and F4 specs and the live spawn, Hatchery, Brood, and Castra modules.
- Feature 5 consumes stopped spawn output and produces a validated patch artifact for downstream Steward / PR integration; it does not create or merge the PR.
- Spawn output is untrusted input. Feature 5 implements F4's A6 contract by validating backend JSON before processing, rejecting malformed payloads, and validating patch paths before any handoff.
- Multi-backend support is live with Claude Code and Codex. Gemini references in older specs are historical and must not drive new acceptance criteria.

## Artifact Hierarchy

RFC -> Milestone -> Feature -> User Story -> Slice -> Tasks

## User Scenarios & Testing

### User Story 1: Capture Backend Output Envelope (Priority: P1)

As an operator, I want March to collect the completed spawn's structured backend output so that downstream automation has a deterministic artifact to inspect instead of raw container logs.

**Why this priority**: No validation or handoff can happen until March has a bounded output payload tied to the correct spawn record and backend.

**Independent Test**: Run a successful spawn that emits a backend JSON envelope. Verify extraction reads the completed spawn's output, associates it with the recorded spawn ID and backend, and stores a bounded raw envelope for validation.

**Acceptance Scenarios**:

1. **Given** a spawn has reached a terminal stopped state with exit code 0, **When** output extraction starts, **Then** the extractor reads the backend output associated with the recorded container or Hatchery job.
2. **Given** the spawn record identifies backend `claude-code`, **When** extraction parses the output, **Then** Claude Code's JSON envelope is parsed with the Claude-specific adapter.
3. **Given** the spawn record identifies backend `codex`, **When** extraction parses the output, **Then** Codex's output envelope is parsed with the Codex-specific adapter.
4. **Given** the output source is empty or unavailable, **When** extraction runs, **Then** extraction fails cleanly with a diagnostic and does not create a patch artifact.
5. **Given** the backend emits more output than the extractor's configured capture limit, **When** extraction runs, **Then** the extractor keeps the bounded diagnostic tail and reports truncation without hanging or reading unbounded data.

---

### User Story 2: Validate Patch Payload (Priority: P1)

As an operator, I want March to validate the spawn's proposed patch before any downstream handoff so that malformed or hostile output cannot modify unrelated files or crash the manager flow.

**Why this priority**: F4 assigns output-channel manipulation mitigation to F5. Patch validation is the security gate between an autonomous spawn and the operator's repository state.

**Independent Test**: Feed extraction fixtures with malformed JSON, non-patch text, absolute paths, parent-directory escapes, and valid git patches. Verify only the valid in-worktree patch is accepted.

**Acceptance Scenarios**:

1. **Given** backend output is not valid JSON for the selected backend, **When** extraction validates it, **Then** extraction rejects it with a clear malformed-output diagnostic.
2. **Given** backend output contains no git patch, **When** extraction validates it, **Then** extraction rejects it with a clear "no patch produced" diagnostic.
3. **Given** a patch contains an absolute path, **When** extraction validates patch targets, **Then** extraction rejects the patch.
4. **Given** a patch contains `..` path traversal or otherwise resolves outside the spawn worktree, **When** extraction validates patch targets, **Then** extraction rejects the patch.
5. **Given** a patch modifies only paths inside the spawn worktree, **When** extraction validates it, **Then** extraction accepts the patch for artifact persistence.
6. **Given** a rejected patch, **When** extraction exits, **Then** the operator receives a diagnostic and no downstream PR integration is triggered.

---

### User Story 3: Persist Extraction Result (Priority: P1)

As a downstream Steward, I want a canonical extraction result that contains the validated patch and failure metadata so that PR integration can proceed without re-parsing backend-specific logs.

**Why this priority**: Feature 6 should consume a backend-neutral result. Without a stable result contract, PR integration would duplicate parsing and validation logic.

**Independent Test**: Run extraction against a valid spawn output. Verify the result contains the spawn ID, backend, status, patch text, diagnostics, and timestamps, and that the SpawnRecord or Brood session reflects extraction completion.

**Acceptance Scenarios**:

1. **Given** extraction accepts a patch, **When** the result is persisted, **Then** the result records status `succeeded`, the spawn ID, backend name, patch text, and extraction timestamp.
2. **Given** extraction rejects output, **When** the result is persisted, **Then** the result records status `failed`, the spawn ID, backend name, failure reason, diagnostic summary, and extraction timestamp.
3. **Given** extraction completes, **When** the spawn lifecycle state is read, **Then** consumers can determine whether the spawn is ready for PR integration without inspecting container logs.
4. **Given** extraction is retried for the same spawn and the source output has not changed, **When** the extractor runs, **Then** the persisted result is deterministic and does not append duplicate patch artifacts.

---

### User Story 4: Hand Off Valid Patch to Steward Boundary (Priority: P2)

As the Hatchery manager flow, I want extraction to expose only validated patch content at the Steward boundary so that the Steward applies and reviews a known-safe artifact rather than arbitrary spawn text.

**Why this priority**: The handoff is downstream of validation. It is P2 because the first three stories define the extraction result; this story defines how Hatchery and Steward consume it.

**Independent Test**: Run a Hatchery spawn whose worker emits a valid patch. Verify the manager prompt or Castra handoff receives the validated patch plus diagnostics metadata, and that invalid output prevents steward launch.

**Acceptance Scenarios**:

1. **Given** extraction succeeds, **When** Hatchery prepares the Steward handoff, **Then** only the validated patch and extraction metadata are included as patch input.
2. **Given** extraction fails, **When** Hatchery evaluates handoff eligibility, **Then** no Steward session is launched for patch application.
3. **Given** a Steward session is launched, **When** it applies the patch, **Then** the patch is applied to the spawn or manager worktree branch only, never directly to the operator's main checkout.
4. **Given** the validated patch is empty after normalization, **When** Hatchery prepares handoff, **Then** the flow fails with a no-op diagnostic rather than launching a Steward.

### Edge Cases

- The container or session output source has been removed before extraction starts.
- The backend process exits 0 but emits malformed JSON.
- The backend process exits non-zero but still emits a patch-like payload; extraction records failure and does not treat the patch as ready for PR integration.
- The patch contains binary file markers, renames, deletes, or file modes; validation accepts only forms the downstream apply step can process safely.
- The backend emits multiple candidate patches; extraction chooses a deterministic single patch or rejects ambiguity.
- The same spawn is extracted more than once by retrying a Hatchery job.
- The extractor runs while cleanup is reclaiming the spawn container, proxy, or worktree.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| US1 | Capture Backend Output Envelope | — | — |
| US2 | Validate Patch Payload | US1 | — |
| US3 | Persist Extraction Result | US2 | — |
| US4 | Hand Off Valid Patch to Steward Boundary | US3 | — |

## Requirements

### Functional Requirements

- **FR-001**: The extraction flow MUST run only for a spawn that has reached a terminal state.
- **FR-002**: The extraction flow MUST read the selected backend from the spawn record or Brood session state before parsing output.
- **FR-003**: The extraction flow MUST use backend-specific adapters for Claude Code and Codex output envelopes.
- **FR-004**: The extraction flow MUST reject malformed backend JSON without throwing an uncaught exception.
- **FR-005**: The extraction flow MUST reject output that does not contain exactly one usable git patch payload.
- **FR-006**: The extraction flow MUST treat all backend output as untrusted input.
- **FR-007**: The extraction flow MUST reject patch paths that are absolute, contain parent-directory traversal, or resolve outside the spawn worktree.
- **FR-008**: The extraction flow MUST reject no-op or empty patches before Steward handoff.
- **FR-009**: The extraction flow MUST persist a backend-neutral extraction result containing spawn ID, backend, status, patch text when successful, diagnostic text when failed, and extraction timestamp.
- **FR-010**: Extraction retry for unchanged source output MUST be deterministic and MUST NOT duplicate persisted patch artifacts.
- **FR-011**: A failed extraction MUST prevent downstream PR integration from applying or submitting a patch.
- **FR-012**: A successful extraction MUST expose the validated patch through a stable contract that Hatchery's Steward handoff can consume without re-parsing raw backend logs.
- **FR-013**: Extraction diagnostics MUST be bounded and MUST NOT include unbounded raw backend output.
- **FR-014**: Extraction MUST produce clean terminal states for success and failure so autonomous Hatchery callers do not wait indefinitely.

### Key Entities

- **SpawnOutputEnvelope**: Backend-specific structured output captured after a spawn reaches a terminal state.
- **SpawnPatch**: A validated git patch derived from a backend output envelope and constrained to paths inside the spawn worktree.
- **ExtractionResult**: Backend-neutral result consumed by Hatchery and Steward integration, recording success or failure plus patch or diagnostic metadata.

## Assumptions

- The live supported backends for new work are Claude Code and Codex.
- The extractor is invoked by Hatchery or spawn lifecycle code after the spawn has stopped; it is not a streaming observer.
- Brood is the lifecycle authority for session state. Legacy `~/.march/spawns/<id>.json` records may still exist and should remain readable when present.
- Feature 6 owns branch push and PR creation. Feature 5 stops at validated patch extraction and handoff eligibility.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Initial draft was uncertain whether the source feature map and RFC were available; both are present in the repo, and the F5 scope (sequential handoff, JSON retrieval, structure validation, patch parsing, untrusted-input/A6 defense) was reconciled against `docs/rfcs/2026-001-march-orchestration-platform/01-spawn.features.md`. | Constraints | High | Medium | resolved | Spec confirmed against the present feature map and RFC; dependency wording matches the F5 row. |
| SD-002 | The exact storage location for `ExtractionResult` must be reconciled with the live Brood registry and any legacy SpawnRecord JSON compatibility expectations before cutting implementation tasks. | Domain & Data Model | Medium | Medium | resolved | Resolved by the US3 cut (`03-persist-extraction-result.tasks.md`): Brood owns the current persisted `ExtractionResult` on the spawn lifecycle row; legacy `~/.march/spawns/<id>.json` compatibility remains read-through/fallback only. |

## Out of Scope

- Launching the spawn container or changing sandbox posture.
- Backend selection and backend registry changes beyond consuming the recorded backend name.
- Applying the patch to the operator's main checkout.
- Creating commits, pushing branches, or opening pull requests.
- Real-time streaming output observation.
- Cleaning up spawn containers, proxy sidecars, worktrees, or branches.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Valid Claude Code spawn output is converted into a successful `ExtractionResult` with a validated git patch.
- **SC-002**: Valid Codex spawn output is converted into a successful `ExtractionResult` with a validated git patch.
- **SC-003**: Malformed JSON, missing patches, absolute patch paths, and path traversal patches all produce failed extraction results without launching Steward integration.
- **SC-004**: Hatchery can consume a successful extraction result without reading raw container or session logs.
- **SC-005**: Re-running extraction for unchanged output produces the same result and does not duplicate artifacts.
