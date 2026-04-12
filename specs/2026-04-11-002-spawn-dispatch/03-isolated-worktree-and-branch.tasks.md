# Tasks: Create Isolated Worktree and Branch per Spawn

**Source**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.spec.md` — User Story 3
**Data Model**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.data-model.md`
**Contracts**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.contracts.md`
**Story Number**: 03

---

## Slice 1: Worktree Creation Module Wired into Dispatch

**Goal**: `march spawn dispatch` creates a uniquely-named branch from the current HEAD and a linked git worktree at `<repo>/../worktrees/march/<spawn-id>/` after dependency validation succeeds. On any failure mid-creation, partial state is rolled back before the command exits 1.

**Justification**: The worktree module and its dispatch-action wiring ship together as one cohesive increment. A worktree module without a caller would be disconnected scaffolding, and the dispatch action cannot demonstrate branch+worktree creation without the module. Delivering both in one PR keeps the test suite green across every commit and produces a standalone working capability: after this slice, dispatching a spawn yields visible git artifacts on disk.

**Addresses**: FR-005, FR-006, FR-007, FR-021, FR-022; Acceptance Scenarios 3.1, 3.2, 3.3, 3.5, 3.6

### Tasks

- [ ] **Introduce worktree creation module with collision retry and cleanup**

  Add a new module under `src/` that exports a function to create a spawn's branch and linked worktree given a repo root. The function generates a SpawnId, detects branch-name collisions and regenerates, ensures the worktree parent directory exists, invokes git to create the branch and worktree, and rolls back any partial branch on failure. Satisfies AS 3.1–3.3, 3.5, and 3.6.

  _Acceptance criteria:_
  - SpawnId format matches the data-model pattern (`YYYYMMDD-<6-char-hex>`)
  - Branch name follows the contract's Branch Naming Convention (`march/spawn/<spawn-id>`)
  - Branch is created from the current HEAD of the supplied repo root
  - Worktree is created at the path defined in FR-006 via `git worktree add`
  - Missing worktree parent directory is created on demand (FR-007)
  - Collision on an existing branch triggers regeneration with a bounded retry; callers never see the collision
  - Any failure after branch creation removes the branch before surfacing the error
  - Returned value exposes spawn ID, branch name, and absolute worktree path for downstream consumers
  - Unit tests operate against a real temporary git repository fixture (no mocking of the git CLI)

- [ ] **Wire worktree creation into the dispatch action**

  Update the `dispatch` action in `src/cli.ts` to invoke the new worktree module after dependency validation passes, and add integration coverage in `src/cli.test.ts` for success and rollback paths. The success path must leave the dispatch command in its existing post-validation placeholder state so Stories 4–7 can extend it without test churn. Satisfies AS 3.1, 3.2, and 3.6.

  _Acceptance criteria:_
  - Worktree creation is invoked only when `checkSpawnDependencies()` returns `ok: true`
  - Success path creates an observable `march/spawn/*` branch and a sibling worktree directory in a real tmp repo fixture
  - Worktree failure exits with code 1 and emits a clear error to stderr
  - Worktree failure leaves no residual `march/spawn/*` branch (FR-021)
  - Existing Story 2 dependency-validation integration tests continue to pass unchanged
  - No SpawnRecord is written by this slice (see SD-001)

**PR Outcome**: `march spawn dispatch` from inside a valid repo creates a fresh `march/spawn/<spawn-id>` branch and a sibling worktree directory, then falls through to the existing placeholder. Branch or worktree creation failures roll back cleanly and exit 1, and all new unit + integration tests pass alongside the existing suite.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Story 3's acceptance scenarios are silent on SpawnRecord creation, but FR-019 and the data-model state transition (`absent → created`) place initial record creation at the moment worktree and branch are created. Assumption: Story 7 owns the full SpawnRecord lifecycle (initial write + finalization). Story 3 does not write a record. If Story 7 requires the record to exist at the moment worktree creation succeeds, this boundary will need to be revisited. | Scope Edges | Medium | High | open | — |
| SD-002 | The spec edge case "dispatch from a submodule — should detect the parent repo root or fail with a clear error" is an unresolved disjunction. Assumption: Story 3 relies on `git rev-parse --show-toplevel`, which returns the submodule's own top level, so dispatching from inside a submodule will place the worktree as a sibling of the submodule rather than the superproject. Acceptable for Feature 2; flagged for Feature 4 threat-model review. | Scope Edges | Low | Medium | open | — |
| SD-003 | Collision retry bound is unspecified. Assumption: a small hardcoded retry count (e.g., 5) is sufficient given the 16M-combination-per-day ID space. Exhausting retries yields a clear error and exits 1. | Technical Risk | Low | High | open | — |

---

## Dependency Order

Recommended implementation sequence:

1. [ ] **Slice 1** — This is the only slice. Task 1 (worktree module) must land before Task 2 (dispatch wiring) because Task 2's integration tests exercise the function introduced by Task 1. Both tasks belong to the same PR.

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Dependency Validation at Dispatch Time | depends on | Story 3 runs only after Story 2's `checkSpawnDependencies()` gate (git, docker, repo context, base image) succeeds. Story 3 assumes the `dispatch` action already enforces these preconditions before reaching worktree creation. |
| User Story 4: Snapshot Worktree into Docker Image | depended upon by | Story 4's Docker build context is derived from the worktree path returned here and a `git ls-files` listing inside it. Story 4 reuses the spawn ID for image/container naming. |
| User Story 7: Container Lifecycle: Wait for Exit | depended upon by | Story 7 writes and finalizes the SpawnRecord (FR-019) using the spawn ID, branch, and worktree path produced here. Story 3 does not create the SpawnRecord itself — see SD-001. |
