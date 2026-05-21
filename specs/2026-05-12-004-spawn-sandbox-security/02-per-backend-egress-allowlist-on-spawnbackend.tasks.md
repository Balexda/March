# Tasks: Per-Backend Egress Allowlist on SpawnBackend

**Source**: `specs/2026-05-12-004-spawn-sandbox-security/spawn-sandbox-security.spec.md` - User Story 2
**Data Model**: `specs/2026-05-12-004-spawn-sandbox-security/spawn-sandbox-security.data-model.md`
**Contracts**: `specs/2026-05-12-004-spawn-sandbox-security/spawn-sandbox-security.contracts.md`
**Story Number**: 02

---

## Slice 1: Backend-Owned Egress Host Declarations

**Goal**: Extend the live `SpawnBackend` contract in `src/spawn/backends.ts` from the accelerated 5-member shape to the F4 6-member shape by adding `allowedEgressHosts`, populate it on the Claude Code and Codex backends, and update backend-focused tests so future backends must make an explicit egress decision at compile time.

**Justification**: The interface member, concrete backend values, and tests are one coherent change. Landing only the interface would break the concrete backends; landing only constants elsewhere would violate US2's single-source-of-truth requirement. This slice gives US1's proxy sidecar a typed per-backend allowlist input without introducing proxy lifecycle code in this story.

**Addresses**: FR-001, FR-002; Acceptance Scenarios 2.1, 2.2, 2.3, 2.4, 2.6. Acceptance Scenario 2.5 is enabled by this slice and completed when US1 wires the proxy sidecar at Stage 4; this slice must leave no alternate global or parallel registry for US1 to consume.

### Tasks

- [ ] **Add `allowedEgressHosts` to the live backend interface and concrete backends**

  Update `src/spawn/backends.ts` so `SpawnBackend` includes `allowedEgressHosts: readonly string[]` alongside the five existing members. Populate `claudeCodeBackend.allowedEgressHosts` with the F4-specified Claude Code host and populate `codexBackend.allowedEgressHosts` with the resolved Codex hostname set from SD-008.

  _Acceptance criteria:_
  - `SpawnBackend` has exactly the six members named in US2 AS 2.1: `name`, `baseImage`, `requiredEnvVars`, `credentialMounts`, `buildEntrypoint`, and `allowedEgressHosts`.
  - `allowedEgressHosts` is typed as a readonly string array.
  - `claudeCodeBackend.allowedEgressHosts` is exactly `["api.anthropic.com"]` per US2 AS 2.2.
  - `codexBackend.allowedEgressHosts` is the resolved OpenAI / Codex CLI host set required by US2 AS 2.3, with SD-008 updated in the spec if the implementation resolves it differently than the current placeholder.
  - Existing exports and backend selection behavior remain unchanged except for the added field.
  - No new global network-policy constant or parallel backend-network registry is introduced.

- [ ] **Extend backend tests for the six-member contract and egress values**

  Update the existing backend test coverage so the new field is verified on concrete backends and on plain object fixtures satisfying `SpawnBackend`. Keep the coverage local to `src/spawn/backends.test.ts` unless an existing consumer test needs a type fixture updated to compile.

  _Acceptance criteria:_
  - Tests assert the `SpawnBackend` surface expected by US2 AS 2.1 without permitting extra contract members to become invisible.
  - Tests assert the Claude Code and Codex `allowedEgressHosts` values from the implementation.
  - Any fixture backend used by Hatchery or spawn tests is updated to include `allowedEgressHosts`, proving future backend additions must provide the field at compile time (US2 AS 2.6).
  - Existing backend registry, backend-selection, credential-mount, and credential pre-flight tests still pass with the added field.

- [ ] **Record the F3 supersession and SD-008 outcome in the story artifact**

  Keep the story's artifact state consistent with the implementation by ensuring the F4 spec remains explicit that this 6th member supersedes F3's closed 4-member decision and by resolving or carrying forward SD-008 based on the Codex host investigation performed for this slice.

  _Acceptance criteria:_
  - The F4 spec continues to cite the F3 supersession required by US2 AS 2.4; no separate F3 artifact rewrite is required in this slice.
  - If the Codex host set is confirmed, SD-008 is marked resolved with the value implemented in `codexBackend.allowedEgressHosts`.
  - If the Codex host set cannot be confirmed without network/runtime access, the implementation uses the documented placeholder and SD-008 remains open with the blocker stated; the PR body must call out the residual risk.
  - This slice's task checkboxes are checked only after the code, tests, and any SD-008 artifact update are complete.

**PR Outcome**: `SpawnBackend` exposes the F4 `allowedEgressHosts` member as part of the backend contract, both shipped backends declare their egress host sets from the backend single source of truth, tests enforce the 6-member shape and concrete values, and US1 can configure its proxy sidecar from `selectedBackend.allowedEgressHosts` without adding a global allowlist.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-008 | inherited from spec: Codex backend `allowedEgressHosts` hostname set is not pinned. Replaces SD-001, which was Gemini-specific and is now moot. The implementation slice must either confirm the Codex CLI host set and resolve this debt in the spec, or explicitly carry the placeholder risk forward in the PR body if the runtime cannot be measured. | Integration | High | Low | inherited | — |

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Backend-Owned Egress Host Declarations | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Restrict Outbound Network Egress | depended upon by | US1 consumes `selectedBackend.allowedEgressHosts` when configuring the proxy sidecar at Stage 4. This story must not introduce any alternate global allowlist that US1 would have to unwind. |
| User Story 4: Operator Sandbox Verification CLI | depended upon by | US4 uses the selected backend's `allowedEgressHosts` as the expected A7 value in the verification report. |
| User Story 6: Threat-Model Audit + A6 Contract for F5 | depended upon by | US6 cites this story as the owning implementation evidence for per-backend egress declarations in the A7 audit row. |
