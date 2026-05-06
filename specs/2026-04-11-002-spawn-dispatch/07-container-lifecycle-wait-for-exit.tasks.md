# Tasks: Container Lifecycle: Wait for Exit

**Source**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.spec.md` — User Story 7
**Data Model**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.data-model.md`
**Contracts**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.contracts.md`
**Story Number**: 07

---

## Slice 1: SpawnRecord Lifecycle Helpers and Timeout Constant

**Goal**: Land the data-layer primitives that finalize a SpawnRecord at the end of a wait stage — `markSpawnRecordStopped` for the `running → stopped` transition (AS 7.1, 7.2, 7.4) and `markSpawnRecordTimedOut` for the `running → failed` timeout transition (AS 7.3, 7.4) — plus the shared `TIMEOUT_SECONDS` constant the wait stage depends on. Pure data-layer; no `cli.ts` wiring and no docker invocations.

**Justification**: Touches only `src/spawn-config.ts` and `src/spawn-record.ts` (plus their sibling `*.test.ts` files). Has no file overlap with Slice 2, so the two are parallel-eligible. Stands alone as a coherent "lifecycle primitives" PR — even before any caller exists, the helpers extend the `markSpawnRecordFailed` / `updateSpawnRecordImageId` precedents already in `spawn-record.ts`.

**Addresses**: FR-018 (timeout reporting), FR-019 (record finalization on completion); Acceptance Scenarios 7.1, 7.2, 7.3, 7.4.

### Tasks

- [ ] **Export `TIMEOUT_SECONDS` constant from `spawn-config.ts`** [via Independent Slices]

  Extend `src/spawn-config.ts` with a `TIMEOUT_SECONDS` integer export representing the hardcoded maximum container execution time per the data-model SpawnConfig requirement. Document in JSDoc that Feature 3 / M2 Hatchery will derive this from a backend-profile mechanism, mirroring the existing `BASE_IMAGE` precedent in the same file.

  _Acceptance criteria:_
  - `TIMEOUT_SECONDS` is exported from `src/spawn-config.ts` as a positive integer (data-model SpawnConfig validation rule: "must be a positive integer")
  - Existing `BASE_IMAGE` export and JSDoc are unchanged
  - JSDoc on the new constant names its consumers (`spawn-wait.ts` and the dispatch action) for the same single-source-of-truth rationale `BASE_IMAGE` documents

- [ ] **Add `markSpawnRecordStopped` for the `running → stopped` transition** [via Structural Integrity]

  Extend `src/spawn-record.ts` with `markSpawnRecordStopped(id, exitCode, homeDir?)` covering the data-model `running → stopped` transition. The helper reads the existing record, sets `status: "stopped"`, populates `exitCode` and `stoppedAt`, and writes back atomically using the existing `atomicWriteSpawnRecord` helper. Mirrors `markSpawnRecordFailed`'s structure. Used by the dispatch action on AS 7.1 (exit 0) and AS 7.2 (non-zero exit) per AS 7.4's record-finalization requirement.

  _Acceptance criteria:_
  - Resulting record has `status: "stopped"`, `exitCode` set to the supplied integer, and `stoppedAt` as a valid ISO 8601 timestamp — satisfies the data-model rule that `exitCode` and `stoppedAt` must both be present when `status === "stopped"`
  - All pre-existing fields (`containerId`, `startedAt`, `imageId`, `version`, `id`, `repoPath`, `branch`, `worktreePath`, `backend`, `createdAt`) are preserved via spread
  - Atomic write uses the existing `atomicWriteSpawnRecord` helper — temp file + rename, no leftover temp files on success or failure
  - Throws `SpawnRecordError` when the source record file is missing or unreadable
  - Behavioural unit coverage in `src/spawn-record.test.ts` for the happy path, field-preservation, and the missing-source-record error path — extending the existing test fixtures rather than introducing a new test file

- [ ] **Add `markSpawnRecordTimedOut` for the `running → failed` timeout transition** [via Independent Slices]

  Extend `src/spawn-record.ts` with `markSpawnRecordTimedOut(id, exitCode?, homeDir?)` covering the data-model `running → failed` transition when the cause is a timeout kill. The helper transitions the record to `status: "failed"`, sets `timedOut: true`, populates `stoppedAt`, and conditionally populates `exitCode` when supplied (the data model requires `exitCode` only "if available" because `docker kill` may not yield a deterministic settled code). Sibling to `markSpawnRecordFailed` rather than an extension of it — `markSpawnRecordFailed`'s JSDoc explicitly scopes itself to the pre-container `created → failed` paths owned by Story 4. Satisfies AS 7.3 and AS 7.4 for the timeout outcome.

  _Acceptance criteria:_
  - Resulting record has `status: "failed"`, `timedOut: true`, `stoppedAt` populated as a valid ISO 8601 timestamp, and `exitCode` populated only when the caller supplies one
  - All pre-existing fields are preserved via spread (mirroring `markSpawnRecordStopped`)
  - Atomic write uses the existing `atomicWriteSpawnRecord` helper
  - Throws `SpawnRecordError` on missing source file or atomic-write failure
  - JSDoc explicitly distinguishes this transition from `markSpawnRecordFailed`'s `created → failed` ownership and references the data-model state-transition table
  - `markSpawnRecordFailed` is not modified — its existing tests must continue to pass unchanged
  - Behavioural unit coverage in `src/spawn-record.test.ts` for the with-`exitCode` and without-`exitCode` happy paths plus the missing-source-record error path

**PR Outcome**: `src/spawn-config.ts` exports `TIMEOUT_SECONDS`. `src/spawn-record.ts` exports `markSpawnRecordStopped` and `markSpawnRecordTimedOut`. All existing tests still pass. The two new helpers are fully unit-tested. Slice 2 and Slice 3 can import these symbols once this PR merges.

---

## Slice 2: Container Wait Module

**Goal**: Introduce `src/spawn-wait.ts` housing the `docker wait` and `docker kill` invocations that implement pipeline stage 6 (Wait). Exports `waitForContainer(containerId, timeoutSeconds)` returning a discriminated-union result `{ kind: "exited", exitCode } | { kind: "timedOut", exitCode? }` (the timeout variant carries the killed container's settled exit code — typically 137 for SIGKILL — when the post-kill capture succeeds, so the dispatch action can persist it on the SpawnRecord per AS 7.4), plus a `WaitError` typed error class. Independently testable via stub-bin-dir fixtures; no caller wiring in this slice.

**Justification**: Touches only the new file `src/spawn-wait.ts` and its sibling `src/spawn-wait.test.ts`. No file overlap with Slice 1, so the two are parallel-eligible (the wait module accepts `timeoutSeconds` as a parameter so it does not even need to import `TIMEOUT_SECONDS` from Slice 1 to be testable). Mirrors the `src/snapshot-build.ts` precedent: a focused module per pipeline-stage docker subcommand.

**Addresses**: FR-017 (block until exit), FR-018 (timeout enforcement), FR-020 (stopped container left in place); Acceptance Scenarios 7.1, 7.2, 7.3, 7.5.

### Tasks

- [ ] **Implement `waitForContainer` with discriminated-union result** [via Independent Slices]

  Create `src/spawn-wait.ts` exporting `waitForContainer(containerId, timeoutSeconds)`. The function invokes `docker wait <containerId>` to block until the container exits, parses the integer exit code from stdout, and returns `{ kind: "exited", exitCode }`. When the wait exceeds `timeoutSeconds`, the function issues a best-effort `docker kill <containerId>`, captures the killed container's settled exit code (typically 137 for SIGKILL — via a follow-up `docker wait <containerId>` or `docker inspect`), and returns `{ kind: "timedOut", exitCode }` when the capture succeeds or `{ kind: "timedOut" }` when it fails. The container is NOT removed on either path — `docker rm` must never be invoked from this module (FR-020 / AS 7.5). Docker invocations follow the established `src/snapshot-build.ts` pattern: `execFileSync` with `stdio: ["ignore", "pipe", "pipe"]` and an explicit `maxBuffer` cap so verbose output cannot trigger `ENOBUFS`.

  _Acceptance criteria:_
  - Happy path: `docker wait` returns within the timeout, stdout is parsed as an integer, `{ kind: "exited", exitCode }` is returned — satisfies AS 7.1 and AS 7.2
  - Timeout path: when wall-clock exceeds `timeoutSeconds`, `docker kill <containerId>` is issued; the killed container's settled exit code is captured (e.g., via a follow-up `docker wait <containerId>` or `docker inspect`) and surfaced as `{ kind: "timedOut", exitCode }`; if the capture fails (container vanished, daemon error), the result is `{ kind: "timedOut" }` and the capture failure is swallowed best-effort — satisfies AS 7.3, AS 7.4 (exit-code preservation on timeout per the data-model `running → failed` rule "exitCode populated (if available)"), and FR-018
  - Container is never removed by this module on any path (no `docker rm` / `docker container rm` invocation) — satisfies FR-020 and AS 7.5
  - Throws a typed `WaitError` (exported from this module) when `docker wait` itself fails for non-timeout reasons (e.g., daemon unreachable, unknown container ID); the message includes a tail of the docker stderr stream following `BuildError`'s precedent in `snapshot-build.ts`
  - `timeoutSeconds` is a function parameter — the module does not import `TIMEOUT_SECONDS` from `spawn-config.ts`, so Slice 2 can ship before Slice 1
  - `docker kill` failure on the timeout path (e.g., container has already exited between timeout detection and kill) is swallowed best-effort: the `{ kind: "timedOut", exitCode? }` result remains authoritative

- [ ] **Defensive parse of `docker wait` stdout** [via Minimal Path]

  Within the same module, parse `docker wait`'s stdout robustly. Trim whitespace, then validate the trimmed result against a strict whole-integer pattern (e.g., `/^-?\d+$/`) **before** passing it to `Number.parseInt(trimmed, 10)`. The strict pre-check is required because `parseInt`'s prefix-parsing semantics will silently accept malformed output like `"137junk"` or `"137\n0"` as `137`, which would mis-finalize the SpawnRecord with a fabricated exit code. After conversion, also assert `Number.isInteger` (and finite) on the parsed value as a defence-in-depth check. Empty output, output that fails the strict regex, output with embedded non-digit characters, or multi-line output containing anything beyond a single integer line must surface as a `WaitError` with a diagnostic message that names the unexpected output, rather than producing `NaN` or a partially parsed value.

  _Acceptance criteria:_
  - Trimmed stdout that matches `/^-?\d+$/` parses to the expected exit code and returns `{ kind: "exited", exitCode }`
  - Empty stdout throws `WaitError` with a message that names the unexpected output
  - Stdout with non-integer suffixes (e.g., `"137junk"`) or multiple lines (e.g., `"137\n0"`) throws `WaitError` — `parseInt`'s prefix-parsing must NOT silently accept these
  - Behavioural coverage in `src/spawn-wait.test.ts` exercises the integer, empty, suffixed, and multi-line paths via stub-bin-dir fixtures that emit each shape

- [ ] **Document the synchronous-invocation choice in module JSDoc** [via Minimal Path]

  The module is implemented with `execFileSync`, matching `snapshot-build.ts`. This blocks the Node.js event loop for the duration of the wait. Document the rationale in the module-level JSDoc: the March CLI dispatches one spawn at a time per the spec's single-operator assumption, no concurrent CLI work needs to progress while the wait blocks, and async would add complexity without benefit. Note what would change the choice (a future server / TUI / multi-spawn scenario).

  _Acceptance criteria:_
  - Module-level JSDoc names the synchronous-invocation choice and the conditions under which it should be revisited
  - Reference points at the spec's "## Assumptions" entry in `spawn-dispatch.spec.md` that states March is a single-operator tool at this milestone (the canonical source of the assumption — the data model does not document it)

- [ ] **Behavioural test surface for `waitForContainer` against a docker stub** [via Independent Slices]

  Add `src/spawn-wait.test.ts`. Use a stub `docker` binary placed in a temp `$PATH` directory (mirroring `cli.test.ts`'s `makeDockerStubBinDir` and `makeDockerBuildFailBinDir` patterns) so the wait module can be exercised without a live daemon. Cover the three wait outcomes AS 7.1–7.3 specify plus the two error-handling paths the wait module owns at this layer: container exits 0 (AS 7.1), container exits non-zero (AS 7.2), container hangs longer than `timeoutSeconds` (AS 7.3), `docker wait` fails for a non-timeout reason, and `docker wait` emits unparseable stdout. AS 7.4 (persisted-record finalization) is exercised at the dispatch-integration level in Slice 3 — not here, since this module does not write the SpawnRecord. AS 7.5 / FR-020 (no-`docker rm` invariant) is verified at this level by inspecting the stub bin-dir's invocation log and asserting no `rm` / `container rm` subcommand was called in any path.

  _Acceptance criteria:_
  - Happy path (exit 0) returns `{ kind: "exited", exitCode: 0 }` — AS 7.1
  - Non-zero exit (e.g., 42) returns `{ kind: "exited", exitCode: 42 }` — AS 7.2
  - Timeout path with a stub whose post-kill capture succeeds returns `{ kind: "timedOut", exitCode: 137 }` and the stub records a `docker kill <id>` invocation followed by the post-kill capture call (`docker wait <id>` or `docker inspect <id>`) — AS 7.3 / AS 7.4 / FR-018
  - Timeout path with a stub whose post-kill capture fails (the second `docker wait` exits non-zero, simulating a vanished container) returns `{ kind: "timedOut" }` (no `exitCode`) — exercises the best-effort capture-failure branch
  - Daemon-unreachable / unknown-container path throws `WaitError` whose message surfaces the docker stderr tail
  - Unparseable stdout (empty, suffixed integer like `"137junk"`, multi-line like `"137\n0"`) throws `WaitError`
  - In every path, the stub's invocation log contains no `docker rm` / `docker container rm` call — AS 7.5 / FR-020
  - Tests use a small `timeoutSeconds` (e.g., < 1 second) so the timeout-path test does not slow the suite

**PR Outcome**: `src/spawn-wait.ts` ships fully implemented with behavioural unit coverage. The wait module has no callers yet — the dispatch wiring lands in Slice 3. No CLI behaviour change is observable from this PR alone.

---

## Slice 3: Dispatch Wiring — Wait Stage, Record Finalization, and Placeholder Retirement

**Goal**: Wire the Slice 1 lifecycle helpers and the Slice 2 wait module into the `march spawn dispatch` action in `src/cli.ts` after Stage 3 (Snapshot + Build), behind a `containerId` guard so US7 ships before US5. When `containerId` is present on the SpawnRecord (i.e., once US5 has wired the launch stage or a test fixture has injected one), the dispatch action runs `waitForContainer`, finalizes the SpawnRecord via `markSpawnRecordStopped` or `markSpawnRecordTimedOut`, and exits with the FR-022 codes. Update the existing placeholder-message integration-test assertion to reflect the new dispatch-completion path. Add stub-driven integration tests covering AS 7.1–7.5.

**Justification**: This is the only slice that modifies dispatch flow and the only one that touches `src/cli.ts` and `src/cli.test.ts`. Depends on Slice 1 (lifecycle helpers) and Slice 2 (wait module) being merged. The `containerId` guard makes the cross-story seam with US5 explicit and keeps US7 shippable as a standalone P2 deliverable instead of blocking on US5's P1 completion.

**Addresses**: FR-017, FR-018, FR-019, FR-020, FR-021, FR-022; Acceptance Scenarios 7.1, 7.2, 7.3, 7.4, 7.5.

### Tasks

- [ ] **Insert guarded Wait + Record stages into the dispatch action**

  Update `src/cli.ts` to insert Stage 6 (Wait) and Stage 7 (Record finalization) inside the existing `if (subcommand === "dispatch")` block, immediately after the Stage 3 (Snapshot + Build) success path. Read the persisted SpawnRecord — when `containerId` is absent (the pre-US5 transitional state), fall through to the existing placeholder console-log so today's observable behaviour is preserved. When `containerId` is present, invoke `waitForContainer(containerId, TIMEOUT_SECONDS)`, branch on the discriminated-union result, call `markSpawnRecordStopped(id, exitCode)` or `markSpawnRecordTimedOut(id, exitCode?)`, set `process.exitCode` per FR-022 (0 on natural exit 0, 1 otherwise), and `return` from the dispatch block so the placeholder is not reached on the wired path. The stopped container is never removed by this stage (FR-020). Stage 7 must run unconditionally per the Dispatch Pipeline contract — when `waitForContainer` throws a `WaitError` (a generic non-timeout docker-wait failure such as daemon-down or unknown-container), the dispatch action must transition the SpawnRecord to `"failed"` via the existing `markSpawnRecordFailed` (NOT `markSpawnRecordTimedOut`, because the failure cause is not a timeout — `timedOut` must remain `false`/absent so the failure is not mis-attributed) before the error is surfaced and the FR-021 artifact-cleanup chain runs.

  _Acceptance criteria:_
  - Stage 6 + Stage 7 execute only when the persisted SpawnRecord has `containerId` populated; otherwise the dispatch falls through to the existing placeholder console-log unchanged — preserves today's observable behaviour pre-US5
  - On `{ kind: "exited", exitCode: 0 }`: `markSpawnRecordStopped` is called with `exitCode: 0`, `process.exitCode` is set to `SUCCESS` (0), and dispatch returns — satisfies AS 7.1 and FR-022
  - On `{ kind: "exited", exitCode: <non-zero> }`: `markSpawnRecordStopped` is called with the actual code, `process.exitCode` is set to `ERROR` (1), and dispatch returns — satisfies AS 7.2 and FR-022
  - On `{ kind: "timedOut", exitCode? }`: `markSpawnRecordTimedOut(id, exitCode)` is called, **forwarding the captured `exitCode` whenever Slice 2 supplied one** (typically 137 from the post-kill capture) so the persisted record retains the killed container's settled code per AS 7.4 and the data-model `running → failed` rule. When the wait module could not capture an exit code (best-effort capture failure), `markSpawnRecordTimedOut` is called without an `exitCode` argument and the data model permits the omission via "exitCode populated (if available)". `process.exitCode` is set to `ERROR` (1) and dispatch returns — satisfies AS 7.3 and FR-022
  - In all wired-path outcomes, the persisted SpawnRecord on disk reflects the final `status`, `exitCode` (populated whenever the wait module supplies one — including the timeout path when the post-kill capture succeeds), `stoppedAt`, and `timedOut` (timeout path only) — satisfies AS 7.4
  - `docker rm` / `docker container rm` is never invoked by the dispatch action — satisfies AS 7.5 and FR-020
  - On `WaitError` (or any other thrown error inside Stage 6), the SpawnRecord is transitioned to `"failed"` via `markSpawnRecordFailed` (NOT `markSpawnRecordTimedOut`) so `timedOut` stays `false`/absent and the failure is not mis-attributed to a timeout
  - `markSpawnRecordFailed` is reused as-is from Story 4 for the `running → failed` non-timeout `WaitError` path — its existing behaviour (set `status: "failed"`, populate `stoppedAt`, leave `timedOut` and `exitCode` untouched) already satisfies the data-model `running → failed` requirements when `exitCode` is not deterministically known; no widening of the helper is required for US7 and Slice 1 leaves it unchanged
  - The SpawnRecord transition runs BEFORE the FR-021 reverse-order artifact cleanup (image → worktree → branch); the SpawnRecord file itself is preserved on disk per the existing Story 4 precedent
  - An explicit `return` is added at the end of the wired path so the `march spawn is not yet implemented` placeholder console-log in `src/cli.ts`'s `dispatch` action handler is not reached on the dispatch flow

- [ ] **Update placeholder-message assertion in the dispatch integration test**

  Update the existing dispatch success-path integration test in `src/cli.test.ts` so its assertions remain valid under the new behaviour. The current success-path test runs without an injected `containerId` (US5 has not landed), so dispatch still falls through to the placeholder console-log — its existing assertions on `"march spawn is not yet implemented"` and `exitCode === 1` continue to hold. Verify this is the case and document it in a test comment so future maintainers do not delete the assertion under the assumption that it is dead code. New US7 integration tests (next task) inject a `containerId` to drive the wired path.

  _Acceptance criteria:_
  - The existing placeholder-message assertion in `src/cli.test.ts`'s success-path test continues to pass on the post-Slice-3 codebase because the test does not inject a `containerId`
  - A short comment in the test explains that the placeholder fall-through is intentional pre-US5 and identifies the US5 task that will retire this branch
  - No test that asserted the placeholder message on the unwired path is silently deleted

- [ ] **Cover AS 7.1–7.5 with stub-driven dispatch integration tests**

  Extend `src/cli.test.ts` with new integration tests for the five US7 acceptance scenarios. Each test injects a `containerId` (and a synthetic `startedAt`) directly into the on-disk SpawnRecord fixture between the worktree-creation step and the dispatch-completion step (or, where the test runs dispatch end-to-end, into the persisted record before `dispatch` is invoked the second time). A new docker stub bin-dir variant — built following the `makeDockerStubBinDir` and `makeDockerBuildFailBinDir` patterns — branches on `$1 = "wait"` and emits a configurable exit code (or sleeps long enough to trip the timeout). Each test asserts the persisted record's terminal `status`, `exitCode`, `stoppedAt`, and `timedOut` against AS 7.4, asserts the dispatch CLI exit code per FR-022, and asserts no `docker rm` invocation against AS 7.5 / FR-020.

  _Acceptance criteria:_
  - One integration test per acceptance scenario, AS 7.1 through AS 7.5, referenced by ID in a test comment
  - Tests run against the existing `makeRealRepo` + isolated-`HOME` fixture
  - Each test asserts the persisted SpawnRecord's `status`, `exitCode` (including the timeout-path test, which asserts the captured exit code from the post-kill `docker wait` capture is persisted on the SpawnRecord — satisfying AS 7.4 and the data-model `running → failed` exit-code rule), `stoppedAt`, and `timedOut` against AS 7.4
  - Each test asserts the dispatch CLI exit code matches FR-022 (0 success, 1 error or timeout)
  - The stub bin-dir's invocation log contains no `docker rm` / `docker container rm` call in any path — AS 7.5 / FR-020
  - All pre-existing Story 2, 3, 4 integration tests continue to pass unmodified
  - Timeout-path test uses a small `TIMEOUT_SECONDS` test override (or a small `timeoutSeconds` argument when calling the wait module directly) so the suite does not slow noticeably

**PR Outcome**: `march spawn dispatch` blocks on the running container, finalizes the SpawnRecord, and exits with FR-022 codes for any path where `containerId` is set on the record (US5-driven or test-fixture-driven). The placeholder console-log is preserved as the no-`containerId` fall-through. Five new integration tests cover AS 7.1–7.5. All prior tests continue to pass. US5's eventual landing automatically activates the wait path without requiring further `cli.ts` changes.

---

## Specification Debt

| ID     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Source Category | Impact | Confidence | Status | Resolution |
|--------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------|--------|------------|--------|------------|
| SD-001 | Mechanism for enforcing the wait timeout in `waitForContainer` is not pinned. Two viable shapes: (a) `execFileSync({ timeout })` with the built-in timeout option, where Node sends `killSignal` to the docker-wait child after the deadline and the wrapper then issues `docker kill` against the container itself; (b) a parallel timer that `docker kill`s the container after `TIMEOUT_SECONDS` while a separate `execFileSync('docker', ['wait', ...])` blocks. The discriminated-union return type and the synchronous-invocation note both fit (a), but (b) is also implementable. | Technical Risk  | High   | Medium     | open   | —          |
| SD-002 | How `waitForContainer` distinguishes a timeout from a generic `docker wait` failure (daemon down, container not found) at the error-handling boundary. If using `execFileSync({ timeout })`, the typical signal is `error.signal === 'SIGTERM'` (or the configured `killSignal`); non-`SIGTERM` errors throw `WaitError`. If using the parallel-timer approach, the discriminator is whether the timer fired before `docker wait` resolved. The choice is load-bearing on Slice 2's implementation but does not affect the public API and can be settled at implementation time.            | Technical Risk  | High   | Medium     | open   | —          |
| SD-003 | The contracts' Pipeline Stages table (Stage 4 Launch) lists "Stop and remove container, remove image, delete branch, remove worktree" as the cleanup chain on container-launch failure. US7's `WaitError` path in Slice 3 Task 1 deliberately omits the container from its cleanup chain (image → worktree → branch only) per FR-020 / AS 7.5, which require the stopped container to remain on disk for Feature 5 extraction. The spec does not explicitly resolve whether, on a non-timeout `WaitError`, the container should be `docker stop`'d, killed, or left running — only that it must NOT be `docker rm`'d. Implementation will pick a behaviour; revisit when Feature 4 evaluates the threat model and Feature 5 specifies the exact pre-extraction container state it expects. | plan-review:Logical gap | Important | Low | open | — |
| SD-004 | SD-001 / SD-002 leave the timeout-detection mechanism inside `waitForContainer` open, but Slice 2 Task 1 acceptance criteria pin observable behaviour ("when wall-clock exceeds `timeoutSeconds`, `docker kill <containerId>` is issued") and Slice 2 Task 4 asserts the docker stub records a `docker kill` invocation on the timeout path. Approach (a) from SD-001 — `execFileSync({ timeout })` with `killSignal` — only sends a signal to the *child process* (the `docker wait` invocation), not to the container. Approach (a) therefore requires the wrapper to issue an explicit `docker kill <containerId>` after the child-process timeout fires; otherwise the stub-invocation assertion will not hold. Approach (b) (parallel timer) issues the kill against the container directly. Both approaches must produce the same observable behaviour from the docker stub's perspective. | plan-review:Assumption-output drift | Important | Low | open | — |

_Upstream `## Specification Debt` could not be parsed — inheritance skipped._ The source spec, data model, and contracts have no `## Specification Debt` section to inherit from; the SD-001 / SD-002 entries above originate from this story's own clarify pass.

---

## Dependency Order

| ID | Title                                                                  | Depends On | Artifact |
|----|------------------------------------------------------------------------|------------|----------|
| S1 | SpawnRecord Lifecycle Helpers and Timeout Constant                     | —          | —        |
| S2 | Container Wait Module                                                  | —          | —        |
| S3 | Dispatch Wiring — Wait Stage, Record Finalization, Placeholder Retirement | S1, S2     | —        |

Slice 1 and Slice 2 are parallel-eligible — they touch disjoint file sets (`src/spawn-config.ts` + `src/spawn-record.ts` for S1; new `src/spawn-wait.ts` for S2) and Slice 2 takes `timeoutSeconds` as a function parameter so it does not import `TIMEOUT_SECONDS` from Slice 1. Slice 3 depends on both being merged because it imports `markSpawnRecordStopped` / `markSpawnRecordTimedOut` from Slice 1, `waitForContainer` from Slice 2, and `TIMEOUT_SECONDS` from Slice 1.

### Cross-Story Dependencies

| Dependency                                                                  | Direction          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|-----------------------------------------------------------------------------|--------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| User Story 5: Launch Container with Hardcoded Security Configuration        | depends on         | US5 owns the data-model `created → running` transition: it `docker run`s the tagged image produced by Story 4, captures the resulting container ID, and updates the SpawnRecord with `containerId` and `startedAt`. US7's wait stage reads `containerId` from the persisted record and assumes the record is already in `"running"` when `waitForContainer` is called. The Slice 3 `containerId` guard preserves today's behaviour pre-US5; once US5 lands, the guard opens automatically and US5 should remove the placeholder console-log along with the rest of its dispatch wiring. Note for the eventual US5 tasks file: include an explicit task to retire the placeholder console-log from the dispatch action. |
| User Story 4: Snapshot Worktree into Docker Image                           | depends on         | US7's dispatch wiring sits immediately after Story 4's Stage 3 (Snapshot + Build) success path. The wait stage reads the same SpawnRecord that Story 4's `updateSpawnRecordImageId` already touches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| User Story 6: Finalize Prompt and Hand Off to Backend                       | depends on         | US7 does not directly read US6's output, but US6 runs between US5 (Launch) and US7 (Wait) in the pipeline. By the time `waitForContainer` runs, the backend CLI has already been invoked inside the running container with the finalized prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Feature 5: Spawn Output Extraction                                          | depended upon by   | Feature 5 reads the stopped container that US7's wait stage leaves behind (FR-020 / AS 7.5). The `containerId`, `worktreePath`, `branch`, and `status` fields the SpawnRecord contains after US7's finalization are the contract surface Feature 5 consumes.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
