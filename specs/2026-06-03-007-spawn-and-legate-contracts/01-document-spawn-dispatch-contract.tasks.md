# Tasks: Document Spawn Dispatch Contract

**Source**: `specs/2026-06-03-007-spawn-and-legate-contracts/spawn-and-legate-contracts.spec.md` - User Story 1
**Data Model**: `specs/2026-06-03-007-spawn-and-legate-contracts/spawn-and-legate-contracts.data-model.md`
**Contracts**: `specs/2026-06-03-007-spawn-and-legate-contracts/spawn-and-legate-contracts.contracts.md`
**Story Number**: 01

---

## Slice 1: Author Spawn Dispatch Contract
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Deliver `docs/subsystems/spawn/contract.md` as a complete, testable documentation contract for Spawn's dispatch inputs, execution lifecycle, terminal output, validation-gated handoff, cleanup boundary, and externally visible failures.

**Justification**: User Story 1 is documentation-only and all acceptance scenarios depend on one coherent Spawn contract. Splitting the public dispatch surface from lifecycle, output, or error promises would leave downstream L2 tests without a complete boundary to assert, while adding Legate content, checkers, freshness globs, AUTOGEN generation, or runtime changes would cross into other stories or later features.

**Addresses**: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-012, FR-013, FR-014; Acceptance Scenarios 1.1, 1.2, 1.3, 1.4

### Tasks

- [ ] **Author the Spawn public interface contract**

  Create `docs/subsystems/spawn/contract.md` with the required contract section shape and a Spawn-owned `## Public Interface` section. Document the operator and Hatchery dispatch inputs, metadata, exported dispatch/execution entrypoint surface, and output handoff boundary as human-authored prose while leaving generated extraction content empty.

  _Acceptance criteria:_
  - The contract contains `## Public Interface`, `## Invariants`, and `## Error Modes` as H2 sections.
  - `## Public Interface` contains an empty `<!-- BEGIN AUTOGEN -->` / `<!-- END AUTOGEN -->` marker pair.
  - Required dispatch input coverage includes prompt and repository context.
  - Accepted metadata coverage includes backend, profile, branch, task identity, spawn identity, and slice correlation.
  - The public interface describes Spawn's exported-signature-level TypeScript surface for dispatch and execution entrypoints as prose, without requiring AUTOGEN output in this slice.
  - Hatchery, Brood, Castra, and Steward are referenced only as integration boundaries; their route, lifecycle authority, session-hosting, and role-interface contracts are not re-authored.
  - No Legate contract, Steward role contract, contract checker, freshness mapping, AUTOGEN generator, CI enforcement, or runtime behavior change is introduced.

- [ ] **Document Spawn lifecycle and handoff invariants**

  Fill `## Invariants` with assertable lifecycle, output, validation, handoff, trace, and cleanup promises owned by Spawn. The contract should support L2 tests that assert the boundary without reverse-engineering CLI control flow, Hatchery handoff, or legacy flat-file artifacts.

  _Acceptance criteria:_
  - Lifecycle promises cover accepted work, launch or execution, terminal success, terminal failure, and cleanup attempts.
  - Brood is identified as the lifecycle record authority where Spawn behavior is observed through managed session and cleanup state.
  - Output extraction is documented as consuming only terminal successful spawn output.
  - Raw backend output is documented as untrusted until validated.
  - Malformed, missing, ambiguous, unsafe, failed, or no-op output prevents Steward handoff.
  - Validated handoff eligibility is documented without describing Feature 4's Steward-specific role interface.
  - Trace and correlation prose aligns with slice identity without introducing new metrics, spans, or runtime instrumentation.

- [ ] **Document Spawn observable error modes**

  Fill `## Error Modes` with externally visible failure behavior for dependency, launch, runtime, timeout, output, validation, handoff, and cleanup failures. Keep the error contract focused on diagnostics and clean terminal outcomes rather than interactive recovery.

  _Acceptance criteria:_
  - Missing required input, invalid backend or profile metadata, missing repository context, dependency readiness failure, image/build failure, container launch failure, backend failure, timeout, output capture failure, validation failure, and cleanup failure are covered.
  - Each error mode names the externally visible outcome or diagnostic class a caller or test can assert.
  - Failed extraction, unsafe output, and no-op output are documented as no-handoff outcomes.
  - Cleanup failures retain observable lifecycle evidence and do not mask the original terminal outcome.
  - The contract states failures exit cleanly or surface events/diagnostics rather than blocking on an interactive prompt.

**PR Outcome**: Spawn's dispatch contract exists as a stable documentation target for L2 tests and later freshness or AUTOGEN tooling. It records the accepted dispatch inputs, exported public surface, lifecycle and terminal-output promises, validation-gated Steward handoff boundary, cleanup behavior, and externally visible failure modes without changing runtime code or authoring Legate/Steward contracts.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

None - all ambiguities resolved.

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Author Spawn Dispatch Contract | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Document Legate Loop Contract | depended upon by | US2 can author the Legate loop contract independently after the Spawn contract plan is available. |
| User Story 3: Record Cross-Contract Ownership Boundaries | depended upon by | US3 consolidates Spawn and Legate boundary references after both subsystem contracts exist. |
