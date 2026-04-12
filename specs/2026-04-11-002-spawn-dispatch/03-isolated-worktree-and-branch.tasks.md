# Tasks: Create Isolated Worktree and Branch per Spawn

**Source**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.spec.md` — User Story 3
**Data Model**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.data-model.md`
**Contracts**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.contracts.md`
**Story Number**: 03

---

## Slice 1: Worktree Creation and Initial SpawnRecord Wired into Dispatch

**Goal**: `march spawn dispatch` creates a uniquely-named branch from the current HEAD, a linked git worktree at `<repo>/../worktrees/march/<spawn-id>/`, and an initial SpawnRecord at `~/.march/spawns/<spawn-id>.json` with status `"created"` after dependency validation succeeds. On any failure mid-creation, partial state (record file, worktree, branch) is rolled back before the command exits 1.

**Justification**: The worktree module, the SpawnRecord module, and their dispatch-action wiring ship together as one cohesive increment. Per FR-019 and the data-model state transition `absent → created`, the SpawnRecord is created at the moment worktree and branch are created — splitting these across slices would either leave the dispatch action in a half-working state or require re-reading the same git artifacts twice. A worktree module without a caller would be disconnected scaffolding, and the dispatch action cannot demonstrate branch + worktree + initial record creation without both modules. Delivering everything in one PR keeps the test suite green across every commit and produces a standalone working capability: after this slice, dispatching a spawn yields visible git artifacts and a persisted record on disk.

**Addresses**: FR-005, FR-006, FR-007, FR-019, FR-021, FR-022; Acceptance Scenarios 3.1, 3.2, 3.3, 3.5, 3.6

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

- [ ] **Add SpawnRecord module writing the initial `created` record**

  Add a new module under `src/` that writes and updates SpawnRecord files at `~/.march/spawns/<spawn-id>.json`. This slice exercises the initial-write path (status `"created"`) per the data-model `absent → created` transition; Stories 4–7 extend the module with status updates and finalization. The module must create the `~/.march/spawns/` directory on first use per the spec edge case. Satisfies FR-019 for the initial write.

  _Acceptance criteria:_
  - Initial record contains `version`, `id`, `repoPath`, `branch`, `worktreePath`, `backend` (`"claude-code"`), `status` (`"created"`), and `createdAt` (ISO 8601) as defined in the data model
  - `~/.march/spawns/` directory is created on demand if it does not exist
  - Written JSON validates against the data-model constraints for a `"created"` record (no `containerId`, `imageId`, `startedAt`, `exitCode`, or `stoppedAt` required at this stage)
  - A delete/rollback helper removes the record file for a given spawn ID and is idempotent if the file is already absent
  - Unit tests write to an isolated `HOME`/`~/.march` tmpdir and assert the emitted JSON structure

- [ ] **Wire worktree creation and initial record into the dispatch action**

  Update the `dispatch` action in `src/cli.ts` to invoke the worktree module after dependency validation passes, then write the initial SpawnRecord. Add integration coverage in `src/cli.test.ts` for the success path and for the rollback paths introduced by this slice. The success path must leave the dispatch command in its existing post-validation placeholder state so Stories 4–7 can extend it without test churn. Satisfies AS 3.1, 3.2, and 3.6 plus FR-019's initial-write requirement.

  _Acceptance criteria:_
  - Worktree creation is invoked only when `checkSpawnDependencies()` returns `ok: true`
  - Success path creates an observable `march/spawn/*` branch, a sibling worktree directory, and a SpawnRecord JSON file in a real tmp repo fixture with an isolated `HOME`
  - SpawnRecord JSON written on success has `status: "created"` and all fields required by the data model for that state
  - Worktree failure exits 1, emits a clear error to stderr, leaves no residual `march/spawn/*` branch and no SpawnRecord file (FR-021)
  - Record-write failure after successful worktree creation also rolls back the branch and worktree before exiting 1 (FR-021)
  - Existing Story 2 dependency-validation integration tests continue to pass unchanged

**PR Outcome**: `march spawn dispatch` from inside a valid repo creates a fresh `march/spawn/<spawn-id>` branch, a sibling worktree directory, and an initial SpawnRecord JSON file with status `"created"`, then falls through to the existing placeholder. Branch, worktree, or record creation failures roll back cleanly (no residual branch, worktree, or record file) and exit 1. All new unit + integration tests pass alongside the existing suite.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Originally flagged Story 3's silence on SpawnRecord creation vs. FR-019 and the `absent → created` transition. Resolved by pulling initial SpawnRecord creation (status `"created"`) into this slice, aligning with FR-019 and the data-model state transition. Story 7 updates and finalizes the record but does not create it. | Scope Edges | Medium | High | resolved | Initial SpawnRecord creation incorporated into Slice 1 Task 2 and Task 3. |
| SD-002 | The spec edge case "dispatch from a submodule — should detect the parent repo root or fail with a clear error" is an unresolved disjunction. Assumption: Story 3 relies on `git rev-parse --show-toplevel`, which returns the submodule's own top level, so dispatching from inside a submodule will place the worktree as a sibling of the submodule rather than the superproject. Acceptable for Feature 2; flagged for Feature 4 threat-model review. | Scope Edges | Low | Medium | open | — |
| SD-003 | Collision retry bound is unspecified. Assumption: a small hardcoded retry count (e.g., 5) is sufficient given the 16M-combination-per-day ID space. Exhausting retries yields a clear error and exits 1. | Technical Risk | Low | High | open | — |
| SD-004 | The data model lists `prompt` as a required SpawnRecord field, but prompt reading (`--prompt`, `--prompt-file`, stdin) is owned by Story 6 (Finalize Prompt and Hand Off to Backend). Story 3 writes the initial `"created"` record without a `prompt` field; Story 6 must populate `prompt` when the prompt is first read, before container launch. This means the `"created"`-state record briefly violates the data model's required-field rule for `prompt`. Assumption: the required-field rule applies to finalized records, not to in-flight lifecycle states; Story 6 is responsible for making the record conformant before it is consumed by downstream features. | Scope Edges | Medium | Medium | open | — |

---

## Dependency Order

Recommended implementation sequence:

1. [ ] **Slice 1** — This is the only slice. Task 1 (worktree module) and Task 2 (SpawnRecord module) are independent of each other and may be implemented in either order, but both must land before Task 3 (dispatch wiring), whose integration tests exercise the functions introduced by Tasks 1 and 2. All three tasks belong to the same PR.

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Dependency Validation at Dispatch Time | depends on | Story 3 runs only after Story 2's `checkSpawnDependencies()` gate (git, docker, repo context, base image) succeeds. Story 3 assumes the `dispatch` action already enforces these preconditions before reaching worktree creation. |
| User Story 4: Snapshot Worktree into Docker Image | depended upon by | Story 4's Docker build context is derived from the worktree path returned here and a `git ls-files` listing inside it. Story 4 reuses the spawn ID for image/container naming. |
| User Story 6: Finalize Prompt and Hand Off to Backend | depended upon by | Story 6 reads the operator's prompt and MUST populate the `prompt` field on the SpawnRecord created by this slice before container launch, because this slice writes the initial record without a `prompt` value — see SD-004. |
| User Story 7: Container Lifecycle: Wait for Exit | depended upon by | Story 7 updates and finalizes the SpawnRecord created here (transitions `created → running → stopped/failed`, populates `containerId`, `startedAt`, `exitCode`, `stoppedAt`, `timedOut`). Story 7 does not create the record — Story 3 owns the initial write per FR-019 and the data-model `absent → created` transition. |
