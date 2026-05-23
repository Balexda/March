# Tasks: Validate Patch Payload

**Source**: `specs/2026-05-21-005-spawn-output-extraction/spawn-output-extraction.spec.md` - User Story 2
**Data Model**: `specs/2026-05-21-005-spawn-output-extraction/spawn-output-extraction.data-model.md`
**Contracts**: `specs/2026-05-21-005-spawn-output-extraction/spawn-output-extraction.contracts.md`
**Story Number**: 02

---

## Slice 1: Backend Envelope and Patch Payload Validation

**Goal**: Add the extraction validation core that turns backend output into either one accepted in-worktree patch candidate or a bounded failed validation result. This slice covers malformed backend JSON, missing or ambiguous patch payloads, absolute paths, path traversal, no-op patches, and unsupported patch forms without persisting results or launching Steward integration.

**Justification**: User Story 2 is the security gate between autonomous spawn output and any downstream repository mutation. The backend envelope checks and patch path checks need to land together because AS 2.1-2.6 verify the same rejection boundary: untrusted output must fail closed before any handoff. Persistence and Hatchery consumption stay in US3 and US4.

**Addresses**: FR-004, FR-005, FR-006, FR-007, FR-008, FR-011, FR-013; Acceptance Scenarios 2.1, 2.2, 2.3, 2.4, 2.5, 2.6

### Tasks

- [ ] **Introduce spawn output validation types and failure categories**

  Add the validation-facing types in the spawn output extraction ownership area, keeping them backend-neutral where the contracts require it and backend-specific only at the parser boundary. Model successful validation with accepted patch text, normalized touched paths, and a stable digest, and model failed validation with stable failure categories plus bounded diagnostics suitable for operator display. Keep the module independent of Brood persistence and Hatchery Steward launch code so this slice cannot trigger downstream PR integration.

  _Acceptance criteria:_
  - Types represent success and failure without throwing uncaught exceptions for malformed backend output (AS 2.1).
  - Failure categories distinguish malformed output, no patch produced, ambiguous patch payloads, unsafe patch paths, unsupported patch forms, and empty or no-op patches (AS 2.1, AS 2.2, AS 2.6).
  - Diagnostics are bounded and do not include unbounded raw backend output (FR-013).
  - The validation module has no Hatchery Steward launch side effect and no Brood persistence dependency (AS 2.6).

- [ ] **Parse Claude Code and Codex envelopes into exactly one candidate patch**

  Implement backend-specific adapter behavior for the live supported backend names, treating raw backend output as untrusted JSON and returning a single candidate patch only when the selected envelope shape contains exactly one usable patch payload. Reject malformed JSON, unsupported backend names, missing patch content, and ambiguous multiple-patch output as structured validation failures.

  _Acceptance criteria:_
  - Invalid JSON for the selected backend returns a malformed-output failure instead of escaping as an uncaught parse exception (AS 2.1).
  - Claude Code and Codex fixtures with one git patch produce one candidate patch for later path validation.
  - Output with no usable git patch returns a no-patch failure (AS 2.2).
  - Output with multiple incompatible candidate patches returns an ambiguity failure rather than choosing nondeterministically (FR-005).
  - Tests cover both supported backend names and do not introduce Gemini behavior.

- [ ] **Validate git patch targets against the spawn worktree**

  Add patch validation that extracts every changed path from an accepted candidate patch, normalizes those targets against the supplied spawn worktree root, and rejects any patch that is absolute, contains parent-directory traversal, resolves outside the worktree, or uses a patch form the downstream apply path cannot safely process. Preserve the accepted patch text only after every touched path has passed validation.

  _Acceptance criteria:_
  - A patch containing an absolute target path is rejected (AS 2.3).
  - A patch containing `..` traversal or any normalized target outside the worktree is rejected (AS 2.4).
  - A patch modifying only relative in-worktree paths is accepted with normalized touched paths and a stable digest (AS 2.5).
  - Empty and no-op patches are rejected before any downstream handoff can consume them (FR-008).
  - Tests include create, modify, delete, rename, and mode-only examples when those forms are accepted; unsupported forms are rejected with stable failure categories.

- [ ] **Wire validation result behavior without downstream PR integration**

  Expose a validation entrypoint that composes backend envelope parsing with patch target validation and returns a terminal validation result to future extraction persistence. Ensure rejected payloads stop at diagnostics and never call Hatchery Steward launch or PR integration surfaces. Keep retry behavior deterministic for unchanged raw output by deriving accepted patch identity from the patch content rather than the validation timestamp.

  _Acceptance criteria:_
  - Valid backend output with a safe in-worktree patch returns an accepted validation result containing patch text, touched paths, and digest (AS 2.5).
  - Rejected backend output returns a failed validation result with bounded diagnostics and no patch payload exposed for handoff (AS 2.6).
  - The composition path has no dependency on Feature 6 PR creation or patch application code (FR-011).
  - Re-running validation for unchanged output produces the same patch digest and failure category, excluding operational timestamps outside this slice's scope (FR-005, FR-010).

**PR Outcome**: Spawn output extraction has a tested validation core for Claude Code and Codex backend envelopes plus safe git patch target validation. Malformed JSON, missing or ambiguous patches, absolute paths, path traversal, unsupported patch forms, and empty patches fail closed with bounded diagnostics. Valid in-worktree patches produce a backend-neutral accepted validation value for US3 persistence, while Hatchery and Steward integration remain untouched.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Initial draft was uncertain whether the source feature map and RFC were available; both are present in the repo, and the F5 scope was reconciled against `docs/rfcs/2026-001-march-orchestration-platform/01-spawn.features.md`. | Constraints | High | Medium | resolved | Spec confirmed against the present feature map and RFC; dependency wording matches the F5 row. |
| SD-002 | inherited from spec: The exact storage location for `ExtractionResult` must be reconciled with the live Brood registry and any legacy SpawnRecord JSON compatibility expectations before cutting implementation tasks. | Domain & Data Model | Medium | Medium | open | - |

_SD-002 does not block US2. This story validates payloads but does not persist `ExtractionResult`; US3 must resolve the storage boundary before implementation._

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | Backend Envelope and Patch Payload Validation | US1 | - |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Capture Backend Output Envelope | depends on | US2 consumes bounded raw backend output and recorded backend identity produced by US1. |
| User Story 3: Persist Extraction Result | depended upon by | US3 persists the success or failure result produced by this validation core and resolves the Brood storage boundary. |
| User Story 4: Hand Off Valid Patch to Steward Boundary | depended upon by | US4 gates Hatchery Steward launch on the validated patch result introduced here and persisted by US3. |
