# Tasks: Snapshot Worktree into Docker Image

**Source**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.spec.md` — User Story 4
**Data Model**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.data-model.md`
**Contracts**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.contracts.md`
**Story Number**: 04

---

## Slice 1: Snapshot Worktree into Tagged Docker Image Wired into Dispatch

**Goal**: After the worktree and initial SpawnRecord have been created, `march spawn dispatch` generates a temporary build context containing only the worktree's git-tracked files (minus the hardcoded exclusion list), writes a generated `Dockerfile` that `FROM`s the base image and `COPY`s the context into `/march/workspace`, builds a tagged image `march-spawn-<spawn-id>`, and updates the SpawnRecord with the resulting `imageId`. On any failure during snapshot, build, or record update, the SpawnRecord is transitioned to status `"failed"` per the data-model `created → failed` transition and the Dispatch Pipeline contract's "stage 7 Record runs unconditionally" rule, and the image (if any), worktree, and branch are cleaned up in reverse order before the command exits 1. The SpawnRecord file itself is preserved so failure auditing and downstream lifecycle handling remain possible.

**Justification**: The snapshot module, the SpawnRecord `imageId` update, and their dispatch wiring ship together as one cohesive PR. Per the Dispatch Pipeline contract (stage 3 → cleanup covers image + worktree + branch), the build cannot land without the rollback wiring, and the rollback wiring cannot land without a builder to roll back from. Landing the module alone would be disconnected scaffolding and would leave the dispatch command unable to demonstrate the snapshot step; landing the dispatch wiring without the module would break the build. Delivering everything in one PR produces a standalone working increment: after this slice, dispatching a spawn leaves a tagged Docker image on disk plus the SpawnRecord, worktree, and branch from Story 3, then falls through to the existing post-Story-3 placeholder so Stories 5–7 can extend it without test churn.

**Addresses**: FR-008, FR-009, FR-010, FR-019 (imageId update), FR-021, FR-022; Acceptance Scenarios 4.1, 4.2, 4.3, 4.4, 4.5

### Tasks

- [ ] **Introduce snapshot module that assembles a build context from git-tracked files**

  Add a new module under `src/` that, given a worktree path, produces a temporary build-context directory containing only the files reported by `git ls-files` (run inside the worktree), minus the hardcoded exclusion list defined in the contracts' Snapshot Exclusion List. The module must materialize files into the temp directory (via copy, not symlink, so the Docker build context is self-contained) while preserving their relative paths, and must clean up the temp directory after its caller finishes with it. Exposed as a function that returns the temp context path plus a cleanup handle.

  _Acceptance criteria:_
  - File list comes from `git ls-files` executed with `cwd` set to the worktree path (tracked files only; untracked and `.gitignore`-ignored files are excluded by construction) — satisfies FR-008
  - Exclusion list matches the contracts' Snapshot Exclusion List: `.env`, `.env.*`, `*.pem`, `*.key`, `.secrets/` (directory segment), `credentials.json` — satisfies FR-009
  - Exclusion matching uses **recursive path-segment match** consistently: a file-name glob pattern (`.env`, `.env.*`, `*.pem`, `*.key`, `credentials.json`) excludes any path whose final segment matches the pattern at any depth (so a nested `src/config/.env` is excluded), and `.secrets/` excludes any path that contains a `.secrets` directory segment at any depth. This matches SD-001's assumption.
  - Build context is created in an OS temp directory that is unique per call and is safe to `rm -rf` on cleanup
  - Files are materialized as real regular files (copies), not symlinks, so `docker build` sees a self-contained context
  - Cleanup helper is idempotent and does not throw if the temp directory is already gone
  - Unit tests operate against real temp worktree fixtures (no mocking of `git ls-files`), cover the exclusion list end-to-end, and assert that excluded files do not appear in the build context

- [ ] **Add Dockerfile generator and `docker build` invocation producing a tagged image**

  Extend the snapshot module (or add a sibling module under `src/`) with a function that writes a generated `Dockerfile` into the build context and invokes `docker build` to produce a tagged image `march-spawn-<spawn-id>`. The generated Dockerfile must match the contracts' Image Build template: `FROM <base-image-tag>`, `COPY --chown=march:march . /march/workspace`, `WORKDIR /march/workspace`. The base image tag comes from the existing `BASE_IMAGE` constant used by dependency validation. On build failure, the function must surface a `SnapshotError` (or equivalent typed error) whose message includes the docker stderr tail so operators can diagnose the failure, and must not leave a tagged image behind. Successful return yields the image tag/ID for the caller to record.

  _Acceptance criteria:_
  - Generated Dockerfile content exactly matches the contracts' template (base image, `COPY --chown=march:march . /march/workspace`, `WORKDIR /march/workspace`) — satisfies FR-010 and AS 4.4
  - Docker build is invoked via `child_process` (`execFile`/`execFileSync`) against the `docker` CLI using the temp build-context directory and the generated Dockerfile path, with the image tag `march-spawn-<spawn-id>` — matches the contracts' Build command
  - Base image tag is sourced from the dispatch action's existing `BASE_IMAGE` constant so future Story 3 / Feature 3 refactors need only change one place
  - Build is invoked with a `COPY`-only context (no bind mount of host paths) — satisfies FR-010 and AS 4.3
  - On docker build failure, a typed error is thrown whose message surfaces the relevant docker stderr; the partially tagged image, if any, is removed so no stale tag lingers
  - Unit tests exercise the Dockerfile-generation path without requiring a running docker daemon (pure text assertion), and a separate integration-level test either stubs the docker invocation at the `execFile` boundary or guards itself behind a "docker available" check
  - A companion `removeSpawnImage(spawnId)` (or equivalent) helper is exported for use by the dispatch action's rollback path; it is idempotent and does not throw if the image does not exist

- [ ] **Extend SpawnRecord module with `imageId` update and `created → failed` transition helpers**

  Extend `src/spawn-record.ts` with two functions: (a) an `imageId` update used after a successful snapshot build, and (b) a `created → failed` transition used by the dispatch rollback path when snapshot, build, or record-update fails. Both functions must read the existing record, mutate the relevant fields, and write the file back atomically (write-temp-then-rename) so a crash mid-write cannot leave a corrupted JSON file. The `imageId` update does NOT change `status` (Story 7 owns transitions out of `"failed"`/`"stopped"`). The `created → failed` helper sets `status` to `"failed"` and populates `stoppedAt` with the current ISO 8601 timestamp; it optionally accepts an error message to record alongside the transition (stored in a future-compatible way per the data model, or dropped if no schema slot exists). The existing `writeInitialSpawnRecord` and `removeSpawnRecord` functions must continue to work unchanged.

  _Acceptance criteria:_
  - `updateSpawnRecordImageId` (or equivalent) accepts a spawn ID and an image ID/tag, reads the existing record at `spawnRecordPath(id)`, and writes it back with `imageId` populated — satisfies the data-model "Required once an image has been successfully built" rule and the state-transition notes on FR-019
  - `updateSpawnRecordImageId` does NOT modify `status` (remains `"created"`); Story 7 owns status transitions out of `"created"` to `"running"` / `"stopped"`
  - `markSpawnRecordFailed` (or equivalent) accepts a spawn ID, reads the existing record, sets `status` to `"failed"`, and populates `stoppedAt` — this implements the data-model `created → failed` transition for Story 4's failure paths (Docker build failure, record-update failure)
  - Both functions write atomically (temp file + rename) so a crash mid-write cannot corrupt the existing record
  - Missing record file surfaces a `SpawnRecordError` with a clear message (callers should not reach this path under correct dispatch ordering, but the error is defensive)
  - Unit tests cover: the happy path for `imageId` update (initial record → record with `imageId`), the happy path for `markSpawnRecordFailed` (initial record → record with `status: "failed"` and `stoppedAt`), the missing-file error path for both helpers, and assert the round-tripped records still validate against the data-model rules for their respective states

- [ ] **Wire snapshot + image build into the dispatch action with failed-state record preservation**

  Update the `dispatch` action in `src/cli.ts` so that, after the initial SpawnRecord write succeeds, it (a) assembles the build context from the worktree via the snapshot module, (b) invokes the docker build to produce `march-spawn-<spawn-id>`, (c) updates the SpawnRecord with `imageId`, and (d) cleans up the temp build context regardless of outcome. On any failure in (a)–(c), the dispatch action must transition the SpawnRecord to `"failed"` via `markSpawnRecordFailed` (preserving the record on disk for auditing) and clean up the physical artifacts in reverse order: remove the image (if any), remove the worktree, delete the branch. The dispatch command then exits 1 with a clear stderr message. The SpawnRecord file itself is NOT deleted — this implements the data-model `created → failed` transition and the Dispatch Pipeline contract's "stage 7 Record runs unconditionally" rule. Add integration coverage in `src/cli.test.ts` for the success path and for each failure path introduced by this slice. The success path must leave the dispatch command in a post-Story-4 placeholder state so Stories 5–7 can extend it without test churn.

  _Acceptance criteria:_
  - Snapshot + build invocation is reached only after `writeInitialSpawnRecord` has succeeded
  - Temp build-context directory is cleaned up on both success and failure (e.g., via a `try`/`finally`)
  - Success path produces an observable tagged image `march-spawn-<spawn-id>` in the local docker daemon and a SpawnRecord whose `imageId` is populated and whose `status` remains `"created"`
  - Snapshot/build failure exits 1, emits the error to stderr, removes any partially tagged image, removes the worktree, deletes the branch, AND leaves the SpawnRecord file on disk with `status: "failed"` and a populated `stoppedAt` — satisfies FR-021 (physical-artifact cleanup), AS 4.5, the data-model `created → failed` transition, and the contracts' "stage 7 Record runs unconditionally" rule
  - Record-update failure after a successful build also removes the image, removes the worktree, deletes the branch, and transitions the SpawnRecord to `"failed"` before exiting 1. If the `markSpawnRecordFailed` helper itself fails (e.g., disk full), a clear stderr warning is emitted noting that the record file may be in an inconsistent state; artifact cleanup still proceeds
  - Existing Story 3 rollback paths (worktree failure before any record write, and initial record-write failure) continue to pass unchanged — those failures occur before a `"created"` record exists on disk, so the `"failed"` transition does not apply
  - Integration tests run against a real tmp repo fixture with an isolated `HOME`; docker invocations are either exercised against a real daemon in CI or stubbed at the `execFile` boundary in the unit test surface — the testing approach is at the implementer's discretion so long as AS 4.1–4.5 are covered
  - A new integration test asserts that on a simulated build failure the SpawnRecord file remains on disk with `status: "failed"` and the worktree/branch/image are gone

**PR Outcome**: `march spawn dispatch` from inside a valid repo creates the Story 3 worktree + initial record, then assembles a build context of git-tracked files (minus the exclusion list), builds a tagged `march-spawn-<spawn-id>` Docker image via a generated Dockerfile (`FROM` base image, `COPY --chown=march:march . /march/workspace`, `WORKDIR /march/workspace`), updates the SpawnRecord with `imageId`, and falls through to the existing post-Story-3/4 placeholder. Any failure in the new snapshot/build/record-update steps transitions the SpawnRecord to `status: "failed"` (preserved on disk for auditing), removes the image → worktree → branch, and exits 1. All new unit + integration tests pass alongside the existing suite.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | The contracts' Snapshot Exclusion List mixes file-name patterns (`.env`, `.env.*`, `*.pem`, `*.key`, `credentials.json`) with a directory entry (`.secrets/`). The spec does not define whether these patterns apply recursively or only at the top level. Assumption for this slice (aligned with Task 1's acceptance criteria): **recursive path-segment match for all patterns** — file-name globs match any path whose final segment matches the pattern at any depth (so a nested `src/config/.env` is also excluded), and `.secrets/` excludes any path that contains a `.secrets` directory segment at any depth. Flagged for Feature 4 threat-model review; Hatchery (M2) will make the list configurable. | Scope Edges | Medium | Medium | open | — |
| SD-002 | The spec acceptance criteria for Story 4 say "only git-tracked files (via `git ls-files`)" but does not specify whether `.gitattributes` `export-ignore` directives should also be honored (as `git archive` would). Assumption: Feature 2 ignores `export-ignore` and uses the raw `git ls-files` output minus the hardcoded exclusion list. This keeps the snapshot behavior predictable and auditable; revisit if operators report surprising inclusions. | Technical Risk | Low | Medium | open | — |
| SD-003 | The contracts show `COPY --chown=march:march` but do not guarantee the base image contains a `march` user at build time. If the base image does not yet provide this user, the `COPY --chown` will fail. Assumption: the base image is out-of-scope for Feature 2 and is expected to provide a `march` user per the contracts' Container Launch section (`--user march`). If the base image does not, the failure surfaces via the existing docker build failure path (AS 4.5) with a clear error. Flagged so Feature 4 / base-image maintainers can verify the invariant. | Technical Risk | Medium | High | open | — |
| SD-004 | The spec does not specify whether the generated image should be removed on successful dispatch completion or left behind. For this slice, the image is **left in place** on success — it is consumed by Story 5 (Launch Container) in a later slice, and Story 7 / Feature 5 own the final cleanup decision. The rollback path removes the image only on failure. | Scope Edges | Low | High | resolved | Success path leaves the image in place; rollback removes it. Explicitly documented in Slice 1 task 4 acceptance criteria. |

---

## Dependency Order

| ID | Title                                                                   | Depends On | Artifact |
|----|-------------------------------------------------------------------------|------------|----------|
| S1 | Snapshot Worktree into Tagged Docker Image Wired into Dispatch          | —          | —        |

Task 1 (snapshot/context module) must land before Task 2 (Dockerfile generator + `docker build`) because the builder consumes the context produced by Task 1. Task 3 (`imageId` SpawnRecord update) is independent of Tasks 1–2 and may be implemented in parallel, but all three must land before Task 4 (dispatch wiring), whose integration tests exercise the functions introduced by Tasks 1–3. All four tasks belong to the same PR.

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 3: Create Isolated Worktree and Branch per Spawn | depends on | Story 4 consumes the worktree path and spawn ID produced by Story 3's `createSpawnWorktree` and extends Story 3's initial SpawnRecord with `imageId` (on success) or a `"failed"` transition (on failure). The rollback path in this slice invokes Story 3's `removeSpawnWorktree` helper but explicitly does NOT call `removeSpawnRecord` on Story 4 failures — the record is preserved per the `created → failed` transition. `removeSpawnRecord` continues to be used only for Story 3's pre-`"created"` failure paths. |
| User Story 2: Dependency Validation at Dispatch Time | depends on | The generated Dockerfile's `FROM` tag comes from the `BASE_IMAGE` constant already validated by Story 2's `checkSpawnDependencies`. Story 4 assumes the base image is present locally or pullable at dispatch time. |
| User Story 5: Launch Container with Hardcoded Security Configuration | depended upon by | Story 5 `docker run`s the tagged image `march-spawn-<spawn-id>` produced here. Story 5 reuses the same spawn ID for the container name and extends the dispatch action's rollback chain to also remove the stopped container on earlier-stage failures. |
| User Story 7: Container Lifecycle: Wait for Exit | depended upon by | Story 7 updates the SpawnRecord through the remaining lifecycle transitions (`created → running → stopped/failed`). The `imageId` written by Story 4 remains populated through all subsequent transitions. |
