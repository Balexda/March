# Tasks: Document Steward Launch and Input Contract

**Source**: `specs/2026-06-03-008-steward-role-contract/steward-role-contract.spec.md` - User Story 1
**Data Model**: `specs/2026-06-03-008-steward-role-contract/steward-role-contract.data-model.md`
**Contracts**: `specs/2026-06-03-008-steward-role-contract/steward-role-contract.contracts.md`
**Story Number**: 01

---

## Slice 1: Steward Launch Contract Surface

**Goal**: Author the Steward contract artifact with the required subsystem-contract shape and the launch/input rules that determine when a validated spawn result may become a Castra-hosted manager session.

**Justification**: User Story 1 is documentation-only and can land as one coherent contract slice because the required section shape, empty AUTOGEN region, launch envelope, and fail-closed eligibility rules are all needed before L2 tests can assert Steward launch readiness. Patch-application outcomes, cleanup ordering, lifecycle teardown, and cross-contract freshness ownership remain in later stories.

**Addresses**: FR-001, FR-002, FR-003, FR-004, FR-004a, FR-005, FR-012; Acceptance Scenarios 1.1, 1.2, 1.3.

### Tasks

- [x] **Create the Steward contract artifact and required section shape**

  Add `docs/subsystems/steward/contract.md` as the role-level contract for the Castra-hosted Steward manager session. The artifact should establish Steward as a documented role boundary rather than a new runtime service, include the required H2 sections, and reserve the generated public-interface region for later extraction without populating it in this slice.

  _Acceptance criteria:_
  - `docs/subsystems/steward/contract.md` exists and identifies Steward as the Castra-hosted manager role that consumes validated spawn output.
  - The contract contains exactly one `## Public Interface`, one `## Invariants`, and one `## Error Modes` H2 section.
  - `## Public Interface` contains an empty `<!-- BEGIN AUTOGEN -->` / `<!-- END AUTOGEN -->` marker pair.
  - The contract states that Steward is not a standalone TypeScript subsystem, HTTP service, CLI command, or agent-deck adapter.
  - No contract checker, freshness checker, AUTOGEN generation, CI enforcement, runtime behavior, PR creation, push, or merge behavior is introduced.

- [x] **Document launch envelope inputs and Castra consumer methods**

  In `## Public Interface`, document the facts that must be present before Steward can launch: the validated patch, target worktree, target branch, spawn id, slice id, profile or session metadata, and role prompt context. Pin the Hatchery-to-Castra consumer boundary by naming the `launch`, `send`, `output`, and `remove` methods in `src/castra/client.ts` as consumed by `src/hatchery/spawn-handoff.ts`, while deferring server route shapes to Castra's own contract.

  _Acceptance criteria:_
  - The launch envelope names validated patch output, target worktree, target branch, spawn id, slice id, session/profile metadata, and role prompt context as required launch facts.
  - The contract states that the worktree, branch, spawn id, and slice id remain correlated for the Steward handoff.
  - The `launch`, `send`, `output`, and `remove` methods of `src/castra/client.ts` are named explicitly as the Castra client surface consumed by `src/hatchery/spawn-handoff.ts`.
  - Castra is described as the interactive session host, with server-side `/v1/sessions*` wire shapes owned by Castra's contract rather than duplicated here.
  - Hatchery is described as the launch/handoff consumer boundary, not as the owner of Steward's role semantics.

- [x] **Record launch eligibility and fail-closed refusals**

  Document the invariant that Steward launches only for successful, non-empty, validated spawn output and that ineligible output stops before session launch with bounded diagnostics or evented state. Keep the refusal language focused on launch eligibility; do not implement or specify later patch-apply, PR-ready, lifecycle cleanup, or freshness-check behavior beyond naming them as later contract concerns.

  _Acceptance criteria:_
  - The contract states that failed, malformed, missing, ambiguous, unsafe, or no-op spawn output is not eligible for Steward launch.
  - The refusal cases are represented as clean failed outcomes, bounded diagnostics, or events rather than prompts for input inside the autonomous role.
  - The contract consumes Spawn's validated-output result without restating Spawn's raw output parsing or validation internals.
  - Error modes include launch refusal for invalid spawn output and missing or mismatched launch context.
  - Later patch application, PR-ready branch state, lifecycle tracking, cleanup ordering, and freshness mapping remain out of this slice except where referenced as downstream boundaries.

**PR Outcome**: The Steward role contract exists with the required subsystem-contract sections, an empty AUTOGEN region, launch envelope inputs, Castra client consumer methods, and fail-closed launch eligibility rules. L2 tests can identify when a validated spawn result is eligible to launch a Steward manager session without requiring runtime changes or PR integration behavior.

---

## Specification Debt

None - all ambiguities resolved.

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Steward Launch Contract Surface | - | `docs/subsystems/steward/contract.md` |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Document Patch Application and PR-Ready Outcome Contract | depended upon by | US2 extends the Steward contract with patch-application, index/worktree, failure, and PR-ready outcome promises after the launch envelope is stable. |
| User Story 3: Document Steward Lifecycle, Tracking, and Cleanup Boundaries | depended upon by | US3 adds Brood, Herald, Castra session identity, parent spawn ownership, cleanup, loss, and timeout lifecycle boundaries after the launch contract exists. |
| User Story 4: Record Cross-Contract Ownership for Steward Consumers | depended upon by | US4 records complete cross-contract ownership and freshness binding once launch, patch application, and lifecycle content are documented. |
