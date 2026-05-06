# Tasks: Launch Container with Hardcoded Security Configuration

**Source**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.spec.md` — User Story 5
**Data Model**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.data-model.md`
**Contracts**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.contracts.md`
**Story Number**: 05

---

## Slice 1: Launch Hardened Container with Stage 4 Wired into Dispatch

**Goal**: After Stage 3 has built the spawn image and updated the SpawnRecord with `imageId`, `march spawn dispatch` launches the spawn's container with the hardcoded security configuration (`--cap-drop=ALL`, non-root `march` user, memory/CPU limits, env-var whitelist, default bridge network), invokes the Claude Code entrypoint via `docker run -d`, captures the container ID, and transitions the SpawnRecord from `"created"` to `"running"` (populating `containerId` and `startedAt`). On any failure during launch or the running-record update, the SpawnRecord is transitioned to `"failed"` per the data-model `created → failed` transition and the Dispatch Pipeline contract's "stage 7 Record runs unconditionally" rule, and the partial container (if any), image, worktree, and branch are cleaned up in reverse order before the command exits 1. The SpawnRecord file itself is preserved on failure for auditing. On success, the existing Story 4 "not yet implemented" placeholder is removed; dispatch exits cleanly so Stories 6–7 can extend the pipeline without the misleading message reappearing after a successful launch.

**Justification**: The `SPAWN_CONFIG` constant, the container-launch helpers, the `markSpawnRecordRunning` SpawnRecord transition, and their dispatch wiring ship together as one cohesive PR. Per the Dispatch Pipeline contract (stage 4 → cleanup covers container + image + worktree + branch), a launch helper cannot land without rollback wiring, and rollback wiring cannot land without a launcher to roll back from. A `SPAWN_CONFIG`-only PR or a `markSpawnRecordRunning`-only PR would be exactly the disconnected scaffolding the cut rules forbid — neither would deliver any observable behavior change to dispatch. Delivering everything in one PR mirrors the US4 single-slice precedent (`04-snapshot-worktree-into-docker-image.tasks.md`): after this slice, dispatching a spawn leaves a running, security-hardened container plus the image, SpawnRecord (status `"running"`), worktree, and branch from earlier stages, ready for Stories 6 (prompt handoff) and 7 (lifecycle wait) to extend.

**Addresses**: FR-011, FR-012, FR-013, FR-019 (running transition), FR-021, FR-022; Acceptance Scenarios 5.1, 5.2, 5.3, 5.4, 5.5, 5.6

### Tasks

- [ ] **Define `SpawnConfig` typed interface and `SPAWN_CONFIG` constant in `spawn-config.ts`**

  Extend `src/spawn-config.ts` with a typed `SpawnConfig` interface and an exported `SPAWN_CONFIG` constant carrying the hardcoded security and resource defaults consumed by Stage 4. Field names and validation rules come from the data-model SpawnConfig entity. Update the module-level JSDoc to no longer conflate `SpawnConfig` and `SpawnBackend`.

  _Acceptance criteria:_
  - Exports a typed `SpawnConfig` interface and a single `SPAWN_CONFIG` constant whose fields and validation rules match the data-model SpawnConfig entity
  - `SPAWN_CONFIG` is the single auditable source of truth — no other module hardcodes any of these values; values match those documented in SD-001 of this tasks file
  - `capDrop` contains `"ALL"` (AS 5.1); `user` is a non-root identifier (AS 5.2); `memoryLimit` and `cpuLimit` are non-empty strings matching Docker's formats (AS 5.3); `envWhitelist` contains exactly `["ANTHROPIC_API_KEY"]` (AS 5.4); `networkMode` is `"bridge"` (AS 5.5)
  - JSDoc references Feature 4 as the owner of network-policy hardening and notes the bridge-network gap is intentional
  - Existing `BASE_IMAGE` export is preserved unchanged

- [ ] **Add `markSpawnRecordRunning` SpawnRecord transition to `spawn-record.ts`**

  Extend `src/spawn-record.ts` with a `markSpawnRecordRunning(id, containerId, homeDir?)` helper that reads the existing record, populates `containerId` and `startedAt` (current ISO 8601 timestamp), transitions `status` to `"running"`, and writes the result back atomically (temp file + rename). Implements the data-model `created → running` transition for Stage 4. Mirrors the existing `updateSpawnRecordImageId` and `markSpawnRecordFailed` patterns.

  _Acceptance criteria:_
  - Reads the record at `spawnRecordPath(id)`, sets `status` to `"running"`, populates `containerId` and `startedAt`, and writes back atomically — satisfies FR-019 and the data-model `created → running` transition
  - Atomic write semantics match `updateSpawnRecordImageId` and `markSpawnRecordFailed` (temp file + rename, best-effort temp cleanup on failure)
  - Missing record file or write failure surfaces a `SpawnRecordError`
  - The round-tripped record satisfies the data-model rules for the `"running"` state (`containerId` and `startedAt` both present)
  - Unit tests cover the happy-path transition (`"created"` with `imageId` → `"running"` with `imageId`/`containerId`/`startedAt`), the missing-file error path, and assert all pre-existing fields are preserved through the transition

- [ ] **Introduce container-launch helpers in new `src/container-launch.ts`**

  Create `src/container-launch.ts` mirroring the small-module pattern of `snapshot-build.ts`. Export a `LaunchError` typed error class (mirrors `BuildError`), a `launchSpawnContainer({ spawnId })` function that runs `docker run -d` against the spawn's tagged image with all flags derived from `SPAWN_CONFIG` plus the Claude Code entrypoint per the contracts' Container Launch and Claude Code Implementation sections, and an idempotent `removeSpawnContainer(spawnId)` helper for the dispatch rollback chain. Returns the container ID captured from `docker run -d` stdout. Internally, use a small `buildClaudeCodeEntrypoint(promptFilePath)` helper so Feature 3's later `SpawnBackend.buildEntrypoint` migration is a rename rather than a re-architecting.

  _Acceptance criteria:_
  - `launchSpawnContainer` invokes `docker run -d` via `child_process` (`execFile`/`execFileSync`) with `--name march-spawn-<spawn-id>`, `--cap-drop=ALL`, `--user`, `--memory`, `--cpus`, `--network`, `-e <var>` passthrough for each entry in `SPAWN_CONFIG.envWhitelist`, the image tag `march-spawn-<spawn-id>` (computed via `spawnImageTag(spawnId)` for naming parity with `buildSpawnImage`), and the Claude Code entrypoint command — satisfies FR-011 through FR-013 and AS 5.1–5.5 (Container `--name` and the absence of `--rm` are spec assumptions documented above)
  - Env-vars are passed via `-e VAR` passthrough (Docker reads the value from the operator's environment), not `-e VAR=<inlined>` — see SD-001
  - The Claude Code entrypoint command matches the contracts' Claude Code Implementation section verbatim, including `--output-format json --dangerously-skip-permissions --bare --no-session-persistence` and the `sh -c` shell expansion of `$(cat /march/prompt.txt)`
  - On `docker run` failure a `LaunchError` is thrown whose message includes the docker stderr tail (matching `BuildError`'s pattern); before re-throw, `removeSpawnContainer` is called best-effort so a partially started container does not linger
  - `launchSpawnContainer` returns the trimmed container ID from `docker run -d` stdout (the full container ID, not the name) suitable for the SpawnRecord `containerId` field
  - `removeSpawnContainer` invokes `docker rm -f march-spawn-<spawn-id>`, is idempotent (no-throw when the container does not exist or never started), and matches the never-throws contract of `removeSpawnImage` and `removeSpawnWorktree`
  - The internal `buildClaudeCodeEntrypoint(promptFilePath)` helper has signature `(promptFilePath: string) => string[]` matching the future `SpawnBackend.buildEntrypoint` shape; no exported `SpawnBackend` interface is introduced (Feature 3 owns that)
  - Unit tests stub the docker invocation at the `execFile` boundary and assert flag composition end-to-end (every flag from `SPAWN_CONFIG` appears in the captured argv)

- [ ] **Wire Stage 4 launch into the dispatch action with success record-update and failure rollback**

  Update the `dispatch` action in `src/cli.ts` so that, after the Stage 3 snapshot+build block has succeeded, it (a) invokes `launchSpawnContainer` with the spawn ID, and (b) on success calls `markSpawnRecordRunning(spawnId, containerId)` to transition the record to `"running"`. On any failure in (a) or (b), call `markSpawnRecordFailed` (preserving the record on disk for auditing), then clean up physical artifacts in reverse order: remove the container (idempotent — no-op if launch never produced one) → remove the image → remove the worktree → delete the branch, then write the error to stderr and exit 1. Failure handling matches the inline-in-catch pattern already used by the Stage 3 wiring. Remove the existing post-Stage-3 "not yet implemented" placeholder and its `process.exitCode = ERROR` so a successful Stage 4 launch leaves the dispatch in a clean exit-0 state — see SD-005 for the rationale.

  _Acceptance criteria:_
  - Stage 4 launch is reached only after `updateSpawnRecordImageId` has succeeded (the Stage 3 try-block's success path)
  - On success, the SpawnRecord on disk has `status: "running"`, populated `containerId` and `startedAt`, and the existing fields from Stages 1–3 unchanged
  - Launch failure transitions the SpawnRecord to `"failed"` (preserved on disk with a populated `stoppedAt`), then in reverse order removes any partially started container, removes the image, removes the worktree, deletes the branch — satisfies FR-021, AS 5.6, the data-model `created → failed` transition, and the contracts' "stage 7 Record runs unconditionally" rule
  - `markSpawnRecordRunning` failure after a successful launch follows the same rollback chain (container → image → worktree → branch) and transitions the record to `"failed"` before exiting 1 — see SD-002. If `markSpawnRecordFailed` itself fails, a stderr warning notes the record may be inconsistent; artifact cleanup still proceeds
  - The Stage 4 catch surfaces `LaunchError` and `SpawnRecordError` messages distinctly so operators can tell which boundary failed
  - The "not yet implemented" placeholder (`console.log` + `process.exitCode = ERROR`) is removed from the post-Stage-3 fall-through; dispatch returns to the natural exit path on success, leaving `process.exitCode` unset (i.e., 0)
  - Existing Story 1–4 rollback paths continue to pass unchanged — those failures occur before Stage 4 and are unaffected by this slice
  - Behavioral coverage of AS 5.1–5.6 is exercised by the integration tests below; this task introduces no standalone test files

- [ ] **Extend integration coverage in `cli.test.ts` for Stage 4 success and launch-failure paths**

  Update `src/cli.test.ts` to cover the new Stage 4 behaviors against the existing real-tmp-repo fixture with isolated `HOME`. Update the existing dispatch success test so its tail no longer asserts the post-Stage-3 placeholder text and instead asserts the `"running"` SpawnRecord and a populated container ID. Extend the existing `makeDockerStubBinDir` so the docker stub prints a deterministic fake container ID on `docker run -d` so `launchSpawnContainer`'s stdout-capture path is exercisable end-to-end (see SD-003). Add a new `makeDockerRunFailBinDir` stub patterned after `makeDockerBuildFailBinDir` and a new launch-failure integration test. Fix the stale Story-7-attribution comment near the success-path assertions (see SD-004) and audit the rest of `src/` for similar drift while you're there.

  _Acceptance criteria:_
  - The existing dispatch success test asserts `record.status === "running"`, `record.containerId` is a non-empty string matching the stub-emitted ID, and `record.startedAt` matches the ISO 8601 pattern; it no longer asserts `"march spawn is not yet implemented"`
  - Success-path test exit code expectation is updated to reflect the post-Stage-4 exit-0 behavior
  - The existing docker stub used by the success test is extended (or replaced) so `docker run -d` prints a deterministic fake container ID on stdout; existing US2/US4 tests using this stub continue to pass
  - A new `makeDockerRunFailBinDir` builds a stub that succeeds on every subcommand except `run` (exits 1 with a clear stderr identifier such as `"simulated launch failure"`)
  - A new launch-failure integration test asserts: exit code 1, stderr surfaces the launch-failure message, no container survives, the image/worktree/branch are gone, and the SpawnRecord file remains on disk with `status: "failed"` and a populated `stoppedAt`
  - The stale `Story 7 owns transitions out of "created" to "running" / "stopped"` comment near the success-path assertions is rewritten to attribute `created → running` to US5 and `running → stopped/failed` to US7
  - A `grep`-style audit of `src/` for other stale `Story <N>` attributions is performed and any drift fixed in this commit
  - Existing Story 1–4 tests continue to pass unchanged

**PR Outcome**: `march spawn dispatch` from inside a valid repo creates the Story 3 worktree + initial record, builds the Story 4 image and updates the SpawnRecord with `imageId`, then launches a security-hardened container (`--cap-drop=ALL`, non-root `march` user, memory/CPU limits, env-var whitelist, bridge network, real Claude Code entrypoint) via `docker run -d`, captures the container ID, transitions the SpawnRecord to `status: "running"` with `containerId` and `startedAt`, and exits cleanly. Any failure in the new launch or running-record-update steps transitions the SpawnRecord to `status: "failed"` (preserved on disk for auditing), removes the container → image → worktree → branch, and exits 1. All new and updated unit + integration tests pass alongside the existing suite.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | The data-model SpawnConfig entity gives field types and example values (`memoryLimit: "4g"`, `cpuLimit: "2"`, `timeoutSeconds: 3600`, `user: "march" or "1000:1000"`) but the spec/data-model/contracts never commit to specific values for Feature 2. Assumption for this slice (used by Task 1's acceptance criteria): adopt the data-model examples verbatim — `capDrop: ["ALL"]`, `user: "march"` (matches the `--chown=march:march` already baked into the Dockerfile by `writeSpawnDockerfile`), `networkMode: "bridge"`, `memoryLimit: "4g"`, `cpuLimit: "2"`, `timeoutSeconds: 3600`, `envWhitelist: ["ANTHROPIC_API_KEY"]`. Env-vars are passed via `-e VAR` passthrough form (Docker reads the value from the operator's environment), not `-e VAR=<inlined>`. No pre-flight check that `ANTHROPIC_API_KEY` is set — if absent at dispatch time, docker passes an empty value and the Claude Code session fails inside the container with an authentication error. Feature 4 may add a pre-flight check based on threat-model evaluation; Hatchery (M2) will make these values configurable per profile. | Technical Risk | Medium | High | resolved | Resolved 2026-05-05 — slice adopts the data-model example values verbatim; env-var passthrough form chosen; pre-flight env-var validation deferred to Feature 4. |
| SD-002 | The plan does not specify failure-handling when `markSpawnRecordRunning` itself fails after a successful `launchSpawnContainer` (e.g., disk full, atomic-rename failure). Assumption (used by Task 4's acceptance criteria): mirror Story 4's record-update-failure pattern — call `markSpawnRecordFailed`, then run reverse-order cleanup (`removeSpawnContainer` → `removeSpawnImage` → `removeSpawnWorktree`), exit 1. If `markSpawnRecordFailed` itself fails, emit a stderr warning that the record may be inconsistent (matching the existing US4 catch-block pattern in the `dispatch` action that emits a `warning: failed to transition spawn record to "failed"` stderr message before falling through to artifact cleanup). Worth flagging because Story 4 deliberately does NOT remove the record file on failure; the same convention applies here. | Implementation Order | Medium | High | resolved | Resolved 2026-05-05 — failure-handling mirrors Story 4's record-update-failure pattern; record file preserved on disk per the `created → failed` transition. |
| SD-003 | The hardcoded entrypoint `sh -c 'claude -p "$(cat /march/prompt.txt)" ...'` references `/march/prompt.txt`, which Story 6 owns writing into the build context (or via pre-launch `docker cp`). After this slice lands, real spawns will start the container, the `cat /march/prompt.txt` will fail, and the container will exit non-zero almost immediately. The success-path integration test cannot rely on a real container exiting 0 and must therefore stub docker. Assumption: extend the existing `makeDockerStubBinDir` so `docker run -d` prints a deterministic fake container ID on stdout so `launchSpawnContainer` can capture it via `execFileSync` stdout. The success-path test asserts CLI flag composition + SpawnRecord `"running"` transition only — it does NOT assert real container execution or the entrypoint command's runtime correctness. The docker-stub contract becomes a load-bearing test fixture: any drift between the stub's argv handling and `launchSpawnContainer`'s flag set would silently break the test. | Testing Strategy | Medium | High | resolved | Resolved 2026-05-05 — slice extends the existing docker stub to print a fake container ID and asserts on flag composition + SpawnRecord state, not real container execution; documented as a known load-bearing fixture for future US5/US6/US7 work. |
| SD-004 | The reconciled plan calls out a stale Story-7-attribution comment near the success-path assertions in `src/cli.test.ts`. The current text reads `// Story 4: imageId is populated by the snapshot/build stage on the success path. Status remains "created" — Story 7 owns transitions out of "created" to "running" / "stopped".` US5 (this story) actually owns the `created → running` transition per the data model; US7 only owns `running → stopped/failed`. Assumption: rewrite this comment to attribute the `running` transition to US5 and the `stopped`/`failed` transitions to US7. Low impact (comment hygiene) but flagged because the same drift may exist elsewhere — Task 5 includes a `grep`-style audit of `src/` for other `Story <N>` attributions to catch any other stale comments before they become permanent fossil comments. | Scope Edges | Low | High | resolved | Resolved 2026-05-05 — Task 5 includes the comment fix and a `src/`-wide audit for similar drift. |
| SD-005 | The reconciled plan's Task 4 originally said "On success, fall through to existing post-Story-4 placeholder." The existing placeholder in the dispatch action's post-Stage-3 fall-through (the `console.log` of `march spawn is not yet implemented... after Feature 2: Spawn Dispatch.` followed by `process.exitCode = ERROR`) writes that text to stdout and sets exit code 1. After US5 lands, the dispatch has launched a container and transitioned the record to `"running"` — printing "not yet implemented" is misleading and exit code 1 contradicts launch having succeeded. Decision: remove the placeholder entirely. Dispatch exits cleanly (exit 0) after a successful Stage 4 launch; the operator's terminal returns with the container running. Stories 6 (prompt handoff) and 7 (lifecycle wait) extend dispatch from there — Story 7 in particular will replace exit 0 with the container's actual exit code. The alternative — keep the placeholder with a different message — was rejected because it adds churn that Stories 6/7 immediately undo. | Scope Edges | Medium | High | resolved | Resolved 2026-05-05 — Task 4 removes the placeholder so dispatch exits cleanly after Stage 4; Stories 6/7 will set exit codes from the container's lifecycle. |

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | Launch Hardened Container with Stage 4 Wired into Dispatch | — | — |

Within S1, Tasks 1 (`SPAWN_CONFIG`), 2 (`markSpawnRecordRunning`), and 3 (container-launch helpers) are independent of each other and may be implemented in parallel. All three must land before Task 4 (dispatch wiring) and Task 5 (integration coverage). All five tasks belong to the same PR.

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 4: Snapshot Worktree into Docker Image | depends on | Story 5 `docker run`s the tagged image `march-spawn-<spawn-id>` produced by Story 4 and extends Story 4's rollback chain to also remove the started container. The Story 4 success-path SpawnRecord (`status: "created"`, `imageId` populated) is the input precondition for `markSpawnRecordRunning`. |
| User Story 3: Create Isolated Worktree and Branch per Spawn | depends on | The launch flag construction reuses `worktree.spawnId` for the container name and the rollback chain invokes Story 3's `removeSpawnWorktree` helper. |
| User Story 2: Dependency Validation at Dispatch Time | depends on | The container is launched against the same `BASE_IMAGE`-derived tag already validated by Story 2's `checkSpawnDependencies`. |
| Feature 3: Multi-Backend Execution Interface | depended upon by | Feature 3 replaces the hardcoded Claude Code entrypoint with a polymorphic `SpawnBackend.buildEntrypoint` and may extend `SPAWN_CONFIG` into per-backend defaults. The internal `buildClaudeCodeEntrypoint` helper introduced by Task 3 reduces the size of that future change to a rename. |
| Feature 4: Spawn Sandbox Security | depended upon by | Feature 4 audits `SPAWN_CONFIG` against the RFC's Appendix A threat model. The bridge network mode is a known gap deliberately left for Feature 4 to address; documented in `SPAWN_CONFIG`'s JSDoc. |
| User Story 6: Finalize Prompt and Hand Off to Backend | depended upon by | Story 6 will inject the finalized prompt file into the container before launch (or via a pre-launch `docker cp`). This slice's entrypoint references `/march/prompt.txt` per the contracts but Story 6 is responsible for ensuring the file exists at that path. Until Story 6 lands, real spawns will launch and immediately fail because the prompt file is absent — see SD-003. |
| User Story 7: Container Lifecycle: Wait for Exit | depended upon by | Story 7 transitions the SpawnRecord through `running → stopped/failed`, consumes the `containerId` written by this slice, and replaces the exit-0 fall-through introduced here with the container's actual exit code. |
