# Tasks: Finalize Prompt and Hand Off to Backend

**Source**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.spec.md` — User Story 6
**Data Model**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.data-model.md`
**Contracts**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.contracts.md`
**Story Number**: 06

---

## Slice 1: Finalize Prompt and Define Backend Contract

**Goal**: `march spawn dispatch` reads the operator's raw prompt from `--prompt-file`, `--prompt`, or stdin (in that precedence order); finalizes it with spawn context (spawn ID and the container working directory); persists the raw prompt onto the SpawnRecord written by Story 3; ships a Stage 5 handoff helper that delivers the finalized prompt into a running spawn container at the path the Claude Code backend reads; and exposes a `SpawnBackend` interface plus a hardcoded Claude Code implementation whose `buildEntrypoint(promptFilePath)` returns the contracts' exact entrypoint command. Per the spec's Critical Assumption ("The finalized prompt is written to a file inside the container") and the contracts' Stage 5 ("Write finalized prompt to container, invoke backend CLI"), the prompt is NOT baked into the image at Stage 3 — the Image Build template (`FROM/COPY/WORKDIR`) is unchanged. The dispatch action still falls through to the existing post-Stage-3 placeholder after this slice; Story 5 owns Stage 4 Launch and the wiring that invokes the Stage 5 handoff helper between launch and backend execution.

**Justification**: The five tasks below operate on a single end-to-end data flow (raw prompt → finalized prompt → SpawnRecord + handoff helper + backend entrypoint) and share one dispatch-action call site and the existing Stage-3 rollback chain. Splitting them across PRs would either fragment the data flow (e.g., a SpawnBackend interface with no consumer, a finalization helper with no caller, or a handoff helper with no prompt to deliver) or stage disconnected scaffolding. Bundling them produces a standalone working increment that is verifiable at the helper layer — `finalizePrompt(...)` returns a string containing the raw prompt + spawn context, `claudeCodeBackend.buildEntrypoint("/march/prompt.txt")` returns the contracts' exact array, the SpawnRecord on disk carries the operator's raw prompt, and the Stage 5 handoff helper writes a finalized prompt into a running container in an integration test — without preempting Story 5's container-launch design or expanding scope into Story 1's pending Commander subcommand-group refactor.

**Addresses**: FR-014, FR-015, FR-016, FR-019 (`prompt` field write), FR-021, FR-022; Acceptance Scenarios 6.1, 6.2, 6.3, 6.5; partially addresses 6.4 (entrypoint construction in Task 2 + Stage 5 handoff helper in Task 4 — end-to-end backend invocation gated on Story 5's Stage 4 Launch); closes SD-004 from `03-isolated-worktree-and-branch.tasks.md`.

### Tasks

- [x] **Resolve raw prompt from `--prompt-file`, `--prompt`, or stdin**

  Add a prompt-ingestion module under `src/` that resolves the operator's raw prompt from one of three sources with the precedence defined in the contracts' `march spawn dispatch` Inputs table. The module must work against today's flat `program.command("spawn [subcommand]")` Commander stub in `src/cli.ts`; the implementer chooses whether to register Commander options on the existing command or parse `process.argv` directly, but must not introduce the Commander subcommand-group refactor that User Story 1 owns. Resolution failures must follow the contracts' Error Conditions table.

  _Acceptance criteria:_
  - AS 6.1 holds: `--prompt-file <path>` reads the file contents as the raw prompt
  - AS 6.2 holds: piped stdin is read as the raw prompt when no flag is supplied
  - Inline `--prompt <string>` is supported and takes precedence over stdin
  - Source precedence is `--prompt-file` > `--prompt` > stdin per the contracts' Inputs table
  - Missing or unreadable prompt file produces the contracts' "prompt file not found or not readable" error and exit code 1, before any git or Docker operation runs
  - Absence of all three sources produces a usage error and exit code 2 (per the spec edge case "fail with a clear error before any git or Docker operations")
  - Existing Stages 1–3 of `march spawn dispatch` continue to run unchanged when a valid prompt source is supplied
  - Unit tests exercise each source, the precedence order, and the missing-file/no-source error paths against real temp files and a fake readable stream — no mocking of the module internals

- [x] **Define `SpawnBackend` interface with hardcoded Claude Code implementation**

  Extend `src/spawn-config.ts` (per the file's existing header comment, which already pre-announces this growth) with the `SpawnBackend` interface from the contracts' SpawnBackend Interface section and a single hardcoded Claude Code implementation. The implementation's `buildEntrypoint(promptFilePath)` must return the exact command array specified in the contracts' Claude Code Implementation block. `BASE_IMAGE` must remain consistent with `claudeCodeBackend.baseImage` so existing imports from `src/cli.ts` and `src/snapshot-build.ts` continue to work. AS 6.5 is satisfied by the entrypoint this implementation returns.

  _Acceptance criteria:_
  - The exported interface shape matches the contracts' SpawnBackend Interface section: `name`, `baseImage`, `requiredEnvVars`, `buildEntrypoint(promptFilePath: string): string[]`
  - The Claude Code implementation's `name`, `baseImage`, `requiredEnvVars`, and `buildEntrypoint` output match the contracts' Claude Code Implementation block exactly, including the explicit `sh -c` shell form and all four flags listed in AS 6.5
  - Existing consumers of `BASE_IMAGE` (dispatch action, Dockerfile generator) continue to compile and pass tests without import-path churn
  - Unit tests assert the entrypoint array returned for a representative prompt path and the field values for `name`, `baseImage`, and `requiredEnvVars`

- [x] **Finalize raw prompt with spawn ID and container working directory**

  Add a pure finalization helper alongside the prompt-ingestion module that takes the raw prompt plus the spawn context (spawn ID, container working directory) and returns the finalized prompt string the backend will see. The container working directory must be derived from the Dockerfile `WORKDIR` declared in `src/snapshot-build.ts` rather than hardcoded as a separate literal. AS 6.3 is satisfied by the finalization output.

  _Acceptance criteria:_
  - AS 6.3 holds: the finalized prompt contains the operator's raw prompt verbatim plus spawn context metadata (spawn ID and container working directory)
  - The function is pure — no filesystem, network, or clock side effects beyond its inputs — so it composes cleanly with Tasks 1, 4, and 5
  - The container working directory referenced in the finalized prompt matches the Dockerfile's `WORKDIR` (single source of truth)
  - Unit tests assert the finalized output contains all three required pieces (raw prompt, spawn ID, working directory) for representative inputs

- [x] **Implement Stage 5 prompt handoff into the running container**

  Add a Stage 5 handoff helper that takes a `containerId` (produced by Stage 4 Launch — owned by Story 5) and the finalized prompt string from Task 3 and writes the prompt into the running container at the path consumed by `claudeCodeBackend.buildEntrypoint`. Per the spec's Critical Assumption and the contracts' Stage 5 row ("Write finalized prompt to container, invoke backend CLI"), the prompt is delivered to the running container at handoff time — it is NOT baked into the image. The Image Build template (`FROM/COPY/WORKDIR`) in `src/snapshot-build.ts`, the `createBuildContext` output in `src/snapshot.ts`, and the Snapshot Exclusion List MUST remain untouched. The helper is exported but not wired into `src/cli.ts`'s dispatch action; the wiring lands in Story 5 alongside the Stage 4 Launch integration so the call sequence (launch → handoff → wait) is added in one place. See SD-002 for the exact handoff mechanism the helper uses (`docker cp` vs. `docker exec`) and SD-003 for how Story 5 will sequence the launch and handoff so the entrypoint does not race the prompt write.

  _Acceptance criteria:_
  - The exported helper writes the finalized prompt into a running container at the path embedded in `claudeCodeBackend.buildEntrypoint` (e.g., `/march/prompt.txt`)
  - `src/snapshot.ts` and `src/snapshot-build.ts` remain unchanged: no new `COPY` for the prompt, no addition of the prompt to the build context, no changes to the Snapshot Exclusion List or the `WORKDIR`
  - Prior US4 unit and integration tests pass without modification
  - Handoff failures surface a clear error from the helper that callers (US5's eventual integration) can route into the existing reverse-order cleanup chain plus the SpawnRecord `created → failed` transition per FR-021
  - The helper is exported from its module but is not invoked from the dispatch action; the post-Stage-3 fallthrough placeholder remains in place
  - Unit tests exercise the helper against a stubbed Docker invocation; an integration test gated on a "docker available" check round-trips the prompt through a real container started for the test (mirroring US4's docker-stub-vs-real-daemon pattern) and asserts the file contents inside the container post-handoff

- [x] **Persist raw prompt onto SpawnRecord before backend handoff**

  Add an `updateSpawnRecordPrompt` helper to `src/spawn-record.ts` alongside the existing `updateSpawnRecordImageId` helper. The helper reads the existing record, sets the `prompt` field to the operator's raw prompt, and writes the record back atomically (temp file + rename) following the existing helpers' pattern. Wire the call into the dispatch action in `src/cli.ts` between prompt resolution (Task 1) and Stage 4 (Launch — owned by Story 5) so the record is data-model-conformant before any downstream consumer reads it. This closes SD-004 from `03-isolated-worktree-and-branch.tasks.md`.

  _Acceptance criteria:_
  - The SpawnRecord at `~/.march/spawns/<spawn-id>.json` contains the operator's raw prompt before the dispatch action would proceed into Stage 4
  - The atomic-write pattern (temp file + rename) matches `updateSpawnRecordImageId` and `markSpawnRecordFailed`
  - The helper does NOT modify `status` or any other field on the record
  - A missing record file surfaces a `SpawnRecordError` with a clear message
  - Failure to persist the prompt triggers the same reverse-order cleanup as a snapshot/build failure and transitions the SpawnRecord to `"failed"` per the data-model `created → failed` transition (FR-021)
  - SD-004 from `03-isolated-worktree-and-branch.tasks.md` is closed: any record reaching `"running"` or beyond carries a populated `prompt` field
  - Unit tests cover the happy path, the missing-record error path, and assert that no other fields are mutated; an integration test in `src/cli.test.ts` asserts the post-Stage-3 record on disk includes `prompt`

**PR Outcome**: `march spawn dispatch --prompt-file <path>` (and the `--prompt <string>` and piped-stdin variants) from inside a valid repo runs Stages 1–3 unchanged, reads and finalizes the operator's prompt, persists the raw prompt onto the SpawnRecord, and exposes a `SpawnBackend` interface plus a Claude Code implementation whose `buildEntrypoint` returns the contracts' exact entrypoint command array. A Stage 5 handoff helper that writes a finalized prompt into a running container is implemented and (where docker is available) integration-tested; it is intentionally NOT wired into the dispatch action. The Image Build template in `src/snapshot-build.ts` and the build context produced by `createBuildContext` in `src/snapshot.ts` are unchanged. The dispatch action still falls through to the existing "march spawn is not yet implemented" placeholder after Stage 3 (Story 5 removes it and wires Stage 4 Launch + the Stage 5 handoff helper between launch and wait). AS 6.1, 6.2, 6.3, and 6.5 are fully satisfied by this slice; AS 6.4 is satisfied at the layer this slice owns (entrypoint construction in Task 2 + handoff helper in Task 4) but its full end-to-end execution — backend CLI actually invoked inside the container with the finalized prompt — requires Story 5's container launch.

---

## Specification Debt

_Upstream spec debt could not be parsed — inheritance skipped._

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Finalized prompt format is unspecified. FR-014 requires the finalized prompt to "include the operator's raw prompt plus spawn context metadata (spawn ID, container working directory)" but does not define the structure (header block prepended, trailing footer, key-value preamble, JSON envelope). Assumption for this slice: prepend a short header block (`Spawn ID: <id>` and `Working Directory: <path>` lines) followed by a blank line and the raw prompt verbatim. Multiple defensible formats exist; flag for operator validation once a real spawn runs end-to-end (post-Story 5). | Scope Edges | High | Medium | open | — |
| SD-002 | The exact mechanism by which Task 4's Stage 5 handoff helper writes the finalized prompt into the running container is unspecified. The contracts' Stage 5 row says "Write finalized prompt to container, invoke backend CLI" but does not pick a Docker primitive. Candidate mechanisms: (a) `docker cp <local-temp-file> <container>:/march/prompt.txt` — simplest, leaves the prompt at rest in a temp file the operator can audit, requires the container to exist before the entrypoint reads the file; (b) `docker exec -i <container> sh -c 'cat > /march/prompt.txt'` piping the prompt over stdin — no temp file on the host but the file's owner inside the container is whichever user `exec` runs as; (c) write the prompt via `docker cp` from stdin (`docker cp - <container>:/march/`) packaging it as a tar stream. Assumption: (a) `docker cp` from a temp file. The temp file is created next to (and cleaned up alongside) the build-context cleanup machinery established by US4. | Technical Risk | High | Medium | open | — |
| SD-003 | How Story 5 will sequence Stage 4 Launch and Task 4's Stage 5 handoff so the entrypoint does not race the prompt write is unspecified. The contracts' Container Launch template uses a single `docker run`, which would start the entrypoint immediately and race the handoff. Spec line 14 ("the finalized prompt is written to a file inside the container") and contracts Stage 5 ("Write finalized prompt to container, invoke backend CLI") together imply a non-racy sequence. Candidate sequences: (i) US5 splits the contracts' single `docker run` into `docker create` (with all security flags) → US6 handoff helper writes the prompt → `docker start` → entrypoint reads the prompt and runs; (ii) US5 keeps `docker run` but the base image's entrypoint waits (e.g., for a sentinel) before invoking `claude`; (iii) the prompt is delivered via stdin to the entrypoint rather than via filesystem (changes the Claude Code Implementation entrypoint array). Assumption: (i) `docker create` + handoff + `docker start`, with the Container Launch security flags applied at `docker create` time. Reviewers may prefer a different split; this is properly a US5/contract-level question, flagged here because Task 4's helper signature must match whichever sequence US5 picks. | Technical Risk | High | Medium | open | — |
| SD-004 | Whether to introduce a shared `PROMPT_PATH` constant (e.g., `/march/prompt.txt`) in `src/spawn-config.ts` consumed by both `claudeCodeBackend.buildEntrypoint` (which embeds the path in the `sh -c` command) and Task 4's Stage 5 handoff helper (which writes the prompt to that same path inside the container). Assumption: yes — introduce `PROMPT_PATH` in `spawn-config.ts` and import it in both call sites so the entrypoint and the handoff destination cannot drift. A reviewer may prefer to keep the literal in two places to avoid a cross-module dependency, given the contracts already parameterize `buildEntrypoint`. | Scope Edges | Medium | Medium | open | — |
| SD-005 | Stdin reading on TTY is unspecified. When neither `--prompt-file` nor `--prompt` is provided, an attempt to read stdin from a TTY would block waiting for the operator. Assumption: detect via `process.stdin.isTTY` and treat a TTY-attached stdin with no flag as a usage error (exit 2), matching US1's "fail fast when no prompt source is provided" behavior. The pattern is already used in `src/cli.ts` for the `update` command's downgrade flow. An alternative is the Unix convention (always attempt the read; let the operator Ctrl-D). | Technical Risk | Medium | Medium | open | — |
| SD-006 | Buffer size limits for stdin reads and prompt-file reads are unspecified. Very large prompts (e.g., multi-megabyte transcripts) will succeed in Node but may overflow Claude Code's `-p` flag or the `sh -c` command line via `ARG_MAX`. Assumption: no explicit cap in US6 — rely on the OS `ARG_MAX` and Claude CLI's own limits to surface a failure downstream. Low impact in practice; flagged for completeness. | Technical Risk | Low | Medium | open | — |
| SD-007 | Shell-special characters in the operator's raw prompt may break the `sh -c 'claude -p "$(cat /march/prompt.txt)" ...'` entrypoint because `$(cat ...)` substitutes the file contents into the shell's argument-parsing pass. A prompt containing `"`, `$(...)`, or backticks will mis-parse. Assumption: not a US6 concern — the contracts mandate the exact `sh -c` form, so any sanitization or invocation-form change would alter the contract. Reviewers may disagree about whether a sanitization step or alternative invocation form (e.g., reading the file in Node and passing `-p` inline) is appropriate. | Technical Risk | Medium | Low | open | — |
| SD-008 | Within Slice 1, the dependency graph among the five tasks is documented in the `## Dependency Order` section below but the granularity may be debated. Assumption: Tasks 1 and 2 are independent and parallel-eligible; Task 3 depends on Task 1's raw-prompt type; Task 4 depends on Tasks 2 and 3 (needs the finalized prompt and the agreed `PROMPT_PATH`); Task 5 depends on Task 1 only. Reviewers may prefer folding Task 3 into Task 1 (single read-and-finalize function) or shipping Task 5 as a separate PR closing SD-004 from US3. | Implementation Order | Medium | Medium | open | — |

---

## Dependency Order

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | Finalize Prompt and Define Backend Contract | — | — |

Within Slice 1, Tasks 1 (prompt resolution) and 2 (`SpawnBackend` interface and Claude Code implementation) are independent and parallel-eligible — the prompt-ingestion module knows nothing about the backend interface, and `buildEntrypoint` returns the contracts' fixed array regardless of how the prompt is read. Task 3 (finalize prompt) consumes Task 1's raw-prompt type and references the Dockerfile `WORKDIR` declared in the snapshot module, so it can land any time after Task 1. Task 4 (Stage 5 handoff helper) consumes Task 3's finalized prompt and the path defined alongside Task 2's interface (see SD-004), so it lands after both; it does NOT touch `src/snapshot.ts` or `src/snapshot-build.ts`. Task 5 (`updateSpawnRecordPrompt` and dispatch wiring) consumes Task 1's raw prompt and is independent of Tasks 2–4 at the module level, but its integration tests in `src/cli.test.ts` exercise the dispatch action through Stage 3 with a populated `prompt` field, so it lands last. All five tasks belong to the same PR.

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Spawn Dispatch CLI Surface | depends on | US1 owns the Commander subcommand-group refactor for `march spawn dispatch`. The refactor is described in `01-spawn-dispatch-cli-surface.tasks.md` (with checked-off tasks) but is not reflected in `src/cli.ts` at HEAD — `--prompt-file` and `--prompt` are silently swallowed by `.allowUnknownOption()` today. Task 1 is authorized to either register Commander options on the existing flat `spawn [subcommand]` command or parse `process.argv` directly, but must not redo US1's structural refactor. The state inconsistency is feature-level debt for someone to reconcile, not US6 work. |
| User Story 3: Create Isolated Worktree and Branch per Spawn | depends on | US3's initial SpawnRecord write deliberately omits the data-model-required `prompt` field per its own SD-004. Task 5 closes that debt by populating `prompt` before the dispatch action would proceed into Stage 4 (Launch). |
| User Story 4: Snapshot Worktree into Docker Image | depends on | Task 4 (Stage 5 handoff helper) does NOT modify `src/snapshot.ts` or `src/snapshot-build.ts` — the Image Build template (`FROM/COPY/WORKDIR`), `createBuildContext`, and the Snapshot Exclusion List remain unchanged. Existing US4 unit and integration tests must pass unmodified. The reverse-order cleanup chain established by US4 (image → worktree → branch + `markSpawnRecordFailed`) is invoked from Task 5's wiring of `updateSpawnRecordPrompt` and (later) from Story 5's wiring of the handoff helper. |
| User Story 5: Launch Container with Hardcoded Security Configuration | depends on | Per the spec's Dependency Order table, US6 depends on US5. US5 owns Stage 4 Launch (the `docker run`/`docker create`+`docker start` invocation with `--cap-drop=ALL`, `--user march`, memory/CPU limits, and the env whitelist sourced from `claudeCodeBackend.requiredEnvVars`), the post-Stage-3 fallthrough removal in `src/cli.ts`, and the wiring that calls Task 4's Stage 5 handoff helper between Stage 4 (running container) and Stage 6 (Wait). US5 also picks the launch sequence (`docker run` vs `docker create`+handoff+`docker start`) referenced in SD-003; Task 4's helper signature must match the chosen sequence. US6 in turn provides every artifact US5 consumes from this layer: the `SpawnBackend.buildEntrypoint` output (Task 2), the finalized prompt string (Task 3), the Stage 5 handoff helper that writes the prompt into the running container (Task 4), and the populated `prompt` field on the SpawnRecord (Task 5). The `cli.test.ts` "march spawn is not yet implemented" assertion remains valid for US6; US5 updates it. |
| User Story 7: Container Lifecycle: Wait for Exit | depended upon by | US7 blocks on the container US5 starts and updates the SpawnRecord through `running → stopped/failed`. The `prompt` field US6 writes via Task 5 remains populated through all subsequent transitions. |
| Feature 3: Multi-Backend Execution Interface | depended upon by | The `SpawnBackend` interface introduced by Task 2 in `src/spawn-config.ts` is the contract boundary Feature 3 polymorphically extends with a Gemini implementation and a backend-selection mechanism. Feature 2 ships the interface plus a single hardcoded Claude Code implementation per the contracts. |
| Feature 5: Spawn Output Extraction | depended upon by | Feature 5 reads the SpawnRecord to locate the stopped container and extract output. The `prompt` field Task 5 populates is required for Feature 6 (PR Integration) but already has to be present once the record reaches `"running"` for downstream consumers to be data-model-conformant. |
