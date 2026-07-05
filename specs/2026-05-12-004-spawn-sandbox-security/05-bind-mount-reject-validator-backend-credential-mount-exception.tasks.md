# Tasks: Bind-Mount Reject Validator + Backend Credential Mount Exception

**Source**: `specs/2026-05-12-004-spawn-sandbox-security/spawn-sandbox-security.spec.md` - User Story 5
**Data Model**: `specs/2026-05-12-004-spawn-sandbox-security/spawn-sandbox-security.data-model.md`
**Contracts**: `specs/2026-05-12-004-spawn-sandbox-security/spawn-sandbox-security.contracts.md`
**Story Number**: 05

---

## Slice 1: Credential-Mount Source Pre-Flight

**Goal**: Ensure dispatch fails before any spawn-scoped artifact is created when the selected backend declares credential mounts whose host sources are missing or unreadable.

**Justification**: The pre-flight is the earliest and lowest-risk enforcement point for backend-declared credential sources. Keeping it separate from the argv validator preserves the spec's ordering: missing Codex credentials fail before Stage 4 launch validation ever sees a bind-mount flag.

**Addresses**: FR-013a; Acceptance Scenario 5.7.

### Tasks

- [x] **Run credential-mount readability checks before artifact creation**

  Wire the selected backend's `credentialMounts` into the existing dispatch validation path so each mount source is resolved from the process environment and checked before worktree, branch, snapshot image, container, proxy, or network artifacts can be created.

  _Acceptance criteria:_
  - Backends with no credential mounts continue through dispatch without new operator input.
  - Backends with credential mounts fail with `USAGE_ERROR` when any resolved source is missing or unreadable.
  - Failure diagnostics name the selected backend and the missing credential source category without leaking credential contents.
  - No spawn-scoped artifacts or SpawnRecord are created for this pre-flight failure.
  - F3's env-var auth pre-flight remains the owner of `requiredEnvVars` checks and is not duplicated.
  - Codex accepts an explicit readable `CODEX_HOME` source.
  - Codex falls back to a readable `HOME/.codex` source when `CODEX_HOME` is unset or empty.
  - Codex missing-credential failures exit before launch artifacts are created.
  - Existing Claude Code and backend auth tests still pass without requiring credential mounts.

**PR Outcome**: Credential-mount backends fail fast with a clean usage error when their declared host credential source is unavailable, preserving March's no-hang autonomous posture while avoiding any partial spawn artifacts.

---

## Slice 2: Typed-Exception Bind-Mount Validator

**Goal**: Add a Stage 4 validator that inspects the fully composed `docker run` argv and rejects every bind mount not declared by the selected backend's credential-mount contract.

**Justification**: The validator must operate on the launch argv after backend credential mounts are composed, because that is the concrete surface future code changes can accidentally expand. This slice enforces the structural "no operator-authored host paths" invariant while admitting Codex's typed credential exception.

**Addresses**: FR-012, FR-013; Acceptance Scenarios 5.1, 5.3, 5.4, 5.5, 5.6.

### Tasks

- [ ] **Validate launch argv bind mounts against backend declarations**

  Add launch-time validation for `-v`, `--volume`, and `--mount` flags. Compare each parsed bind source, target, and read-only posture to the selected backend's resolved `credentialMounts`, and allow only exact declared credential mounts. Treat `--tmpfs` as a non-bind mount and allow it unconditionally.

  _Acceptance criteria:_
  - Claude Code launches continue with no bind-mount flags and no false positives.
  - Codex launch argv admits only its declared credential mount source, target, and read-only posture.
  - Undeclared `-v`, `--volume`, and `--mount` bind forms are rejected.
  - `--tmpfs` flags are ignored by the bind-mount allow-set and remain valid.
  - No global bind-mount allowlist or operator-authored exception path is introduced.
  - Tests fail if a future contributor adds an undeclared Claude OAuth bind mount without declaring it on `claudeCodeBackend.credentialMounts`.
  - Tests prove long and short Docker bind-mount flag forms are covered.

- [ ] **Emit actionable validator failures**

  Convert validator rejection into the existing launch failure path so dispatch exits with `ERROR`, reports the offending flag, and lists the selected backend's declared credential mounts or states that none are declared.

  _Acceptance criteria:_
  - Rejection diagnostics identify the offending bind-mount flag.
  - Diagnostics explain that only backend-declared credential mounts are permitted.
  - Backends with no credential mounts report that no declared mounts are available.
  - Rejections flow through the same cleanup path as other launch failures.
  - Existing launch tests still pass under normal dispatch configuration.

**PR Outcome**: Stage 4 refuses undeclared host bind mounts from the concrete launch argv while admitting typed backend credential mounts and tmpfs scratch mounts.

---

## Slice 3: Dispatch Cleanup and Contract Surface Alignment

**Goal**: Ensure bind-mount validator failures behave like clean launch failures across dispatch cleanup, SpawnRecord state, and subsystem contract documentation.

**Justification**: The validator is only complete when its rejection path leaves no dangling launch artifacts and the mapped public surface documents the new Stage 4 behavior. This slice keeps the failure mode observable and aligned with the subsystem contract upkeep rule.

**Addresses**: FR-012; Acceptance Scenario 5.2.

### Tasks

- [ ] **Route validator rejection through reverse-order cleanup**

  Integrate the validator failure with the existing launch error handling so snapshot image, worktree, branch, and any prior launch artifacts are cleaned up consistently with the F2/F4 reverse-order contract.

  _Acceptance criteria:_
  - No spawn container is created after validator rejection.
  - Snapshot image, worktree, and branch cleanup still run after rejection.
  - Any Stage 4 artifacts created before rejection are cleaned up by exact name.
  - The SpawnRecord reflects a failed dispatch with the validator diagnostic when the surrounding dispatch path records launch failures.
  - Repository verification appropriate for a spawn launch/security change passes, or environment-specific failures are documented with the exact blocker.

- [ ] **Update mapped contracts for the Stage 4 validator**

  Refresh affected subsystem contract documentation only where the validator changes a mapped public or internal surface, keeping the docs aligned with the implementation and the F4 contracts artifact.

  _Acceptance criteria:_
  - The owning subsystem contract describes the validator's launch-time role and failure semantics if that surface is mapped.
  - Documentation cites the F4 spec or contracts artifact rather than restating the full philosophy.
  - No unrelated contract sections or generated `dist/` artifacts are changed.

**PR Outcome**: Validator rejections are clean, observable launch failures with no dangling artifacts, and subsystem contracts stay current with the new Stage 4 enforcement point.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| — | No open US5-specific debt after the 2026-05-16 rework; SD-009, SD-010, and SD-011 are resolved in the source spec. | — | — | — | — | — |

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Credential-Mount Source Pre-Flight | — | — |
| S2 | Typed-Exception Bind-Mount Validator | S1 | — |
| S3 | Dispatch Cleanup and Contract Surface Alignment | S2 | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Per-Backend Egress Allowlist on `SpawnBackend` | related | US5 consumes the already-live `SpawnBackend.credentialMounts` member. The egress allowlist itself is not part of US5. |
| User Story 4: Operator Sandbox Verification CLI | depended upon by | US4's A2 verification uses the selected backend's declared credential mounts as the expected bind-source set. |
| User Story 6: Threat-Model Audit + A6 Contract for F5 | depended upon by | US6 cites the validator and credential-mount pre-flight as A2/A3 evidence and residual-risk controls. |
