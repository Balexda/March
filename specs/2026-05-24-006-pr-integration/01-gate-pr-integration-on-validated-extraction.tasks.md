# Tasks: Gate PR Integration on Validated Extraction

**Source**: `specs/2026-05-24-006-pr-integration/pr-integration.spec.md` - User Story 1
**Data Model**: `specs/2026-05-24-006-pr-integration/pr-integration.data-model.md`
**Contracts**: `specs/2026-05-24-006-pr-integration/pr-integration.contracts.md`
**Story Number**: 01

---

## Slice 1: PR Integration Eligibility Gate

**Goal**: Add the PR-integration eligibility boundary that accepts only a successful, non-empty Feature 5 `ExtractionResult` whose spawn id and backend match Brood lifecycle state, and returns terminal bounded diagnostics for every rejected request before any repository or GitHub side effect can occur.

**Justification**: User Story 1 is the trust boundary before all Feature 6 mutations. The successful, failed, missing, mismatched, and no-op paths must be evaluated together so the first PR-integration increment cannot accidentally apply a patch, push a branch, or open a PR from untrusted or ambiguous input. This follows the autonomous-component constraints in `docs/vision.md` and `docs/operating-philosophy.md`: callers need a clean terminal result instead of an interactive prompt or a hanging Steward session.

**Addresses**: FR-001, FR-002, FR-003, FR-013, FR-014, FR-015, FR-017; Acceptance Scenarios 1.1, 1.2, 1.3, 1.4, 1.5

### Tasks

- [ ] **Evaluate extraction eligibility before mutation**

  Add the PR-integration runner's first decision point so it reads the Brood lifecycle state and persisted Feature 5 extraction result, then admits only `status: "succeeded"` results whose spawn id, backend, patch digest, touched paths, and validated patch text are internally consistent with the recorded spawn state. Rejected inputs must return a terminal `PrIntegrationResult` without invoking patch application, branch publishing, or pull-request creation.

  _Acceptance criteria:_
  - A succeeded extraction result with matching spawn id and backend proceeds to the next integration stage with the validated patch and extraction metadata only (AS 1.1, FR-001, FR-003).
  - A failed extraction result returns terminal failure metadata and does not call apply, commit, push, or PR behavior (AS 1.2, FR-001).
  - Missing extraction state fails fast with a stable missing-extraction reason and bounded diagnostic (AS 1.3, FR-014, FR-015).
  - Spawn id or backend mismatch between extraction metadata and lifecycle state fails before patch application (AS 1.4, FR-001).
  - The eligibility path does not parse raw backend logs or raw spawn output as fallback patch input (FR-002).

- [ ] **Reject no-op patches and expose observable failures**

  Add the final eligibility guard for successful extraction results whose normalized validated patch is empty or no-op, and wire every refusal path through bounded diagnostics and errored telemetry. The result should preserve enough durable context for orchestration to stop or retry safely while keeping secrets, raw backend logs, and unbounded spawn output out of diagnostics.

  _Acceptance criteria:_
  - Empty, whitespace-only, or normalized no-op validated patches fail eligibility before apply, commit, push, or PR creation (AS 1.5, FR-001).
  - Rejection diagnostics are bounded, redacted, and do not embed raw spawn output or backend logs (FR-013, FR-015).
  - Failed, missing, mismatched, and no-op refusals emit errored spans as children of the deterministic slice trace rather than creating unrelated roots (FR-017; AGENTS.md observability lock-step).
  - The successful eligibility path emits a non-error child span with low-cardinality attributes and passes only validated patch metadata onward.
  - Tests cover successful, failed, missing, mismatched, and no-op extraction eligibility with isolated Brood lifecycle state and without Docker, Castra, GitHub, or a live Steward session.

**PR Outcome**: PR integration has a tested pre-mutation gate that consumes only the persisted successful Feature 5 extraction result and matching lifecycle state. Failed, missing, mismatched, and no-op extraction inputs produce terminal bounded diagnostics and errored telemetry without applying patches, pushing branches, or opening pull requests.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-002 | inherited from spec: The exact persistence owner for `PrIntegrationResult` must be confirmed against the live Brood registry and any Herald projection expectations before implementation tasks are cut. | Domain & Data Model | Medium | Medium | resolved | US1 resolves the eligibility-stage owner: Brood lifecycle state is the source of spawn and extraction truth, and this slice returns a terminal `PrIntegrationResult` for rejected requests without introducing a Herald projection; broader persisted integration state remains US5 scope. |
| SD-003 | inherited from spec: The exact verification commands to run before PR creation are not specified here; implementation planning must decide whether to run repository defaults, spec-provided checks, or no verification in the initial slice. | Functional Scope | Medium | Medium | inherited | US1 does not reach commit, push, verification, or PR creation; this remains for US3/US4 planning. |

_SD-001 from the spec is already resolved there and does not carry implementation impact for this story._

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | PR Integration Eligibility Gate | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| Feature 5: Spawn Output Extraction, User Story 3 | depends on | US1 consumes Brood-backed persisted extraction state and readiness metadata from Feature 5 rather than parsing backend logs. |
| Feature 5: Spawn Output Extraction, User Story 4 | depends on | US1 continues the same Hatchery/Steward safety boundary by refusing failed, missing, or no-op extraction before launching downstream PR work. |
| User Story 2: Apply the Validated Patch to an Integration Branch | depended upon by | US2 may apply a patch only after this story admits a successful, matching, non-empty extraction result. |
| User Story 5: Record Terminal Integration State for Orchestration | depended upon by | US5 persists full success and failure integration state; this story defines the early terminal failure reasons it must preserve. |
