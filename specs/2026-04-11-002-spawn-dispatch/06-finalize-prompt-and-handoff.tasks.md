# Tasks: Finalize Prompt and Hand Off to Backend

**Source**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.spec.md` — User Story 6
**Data Model**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.data-model.md`
**Contracts**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.contracts.md`
**Story Number**: 06

---

## Slice 1: Finalize Prompt and Define Backend Contract

**Goal**: `march spawn dispatch` reads the operator's raw prompt from `--prompt-file`, `--prompt`, or stdin (in that precedence order); finalizes it with spawn context (spawn ID and the container working directory); persists the raw prompt onto the SpawnRecord written by Story 3; bakes the finalized prompt into the spawn's Docker image at the path the Claude Code backend will read; and exposes a `SpawnBackend` interface plus a hardcoded Claude Code implementation whose `buildEntrypoint(promptFilePath)` returns the contracts' exact entrypoint command. The dispatch action still falls through to the existing post-Stage-3 placeholder after this slice — Story 5 owns removing that placeholder and invoking `docker run`.

**Justification**: The five tasks below operate on a single end-to-end data flow (raw prompt → finalized prompt → image + SpawnRecord + backend entrypoint) and share one dispatch-action call site, the existing Stage-3 rollback chain, and the contracts' single-`docker run` Container Launch template. Splitting them across PRs would either fragment the data flow (e.g., a SpawnBackend interface with no consumer, or a prompt-ingestion module with no caller) or stage disconnected scaffolding. Bundling them produces a standalone working increment that is verifiable post-Stage-3 — the built image contains the finalized prompt at `/march/prompt.txt`, the SpawnRecord carries the operator's raw prompt, and `claudeCodeBackend.buildEntrypoint("/march/prompt.txt")` returns the contracts' exact array — without preempting Story 5's launch design or expanding scope into Story 1's pending Commander subcommand-group refactor.

**Addresses**: FR-014, FR-015, FR-016, FR-019 (`prompt` field write), FR-021, FR-022; Acceptance Scenarios 6.1, 6.2, 6.3, 6.4 (entrypoint construction; backend invocation gated on Story 5), 6.5; closes SD-004 from `03-isolated-worktree-and-branch.tasks.md`.

### Tasks

- [ ] **Resolve raw prompt from `--prompt-file`, `--prompt`, or stdin**

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

- [ ] **Define `SpawnBackend` interface with hardcoded Claude Code implementation**

  Extend `src/spawn-config.ts` (per the file's existing header comment, which already pre-announces this growth) with the `SpawnBackend` interface from the contracts' SpawnBackend Interface section and a single hardcoded Claude Code implementation. The implementation's `buildEntrypoint(promptFilePath)` must return the exact command array specified in the contracts' Claude Code Implementation block. `BASE_IMAGE` must remain consistent with `claudeCodeBackend.baseImage` so existing imports from `src/cli.ts` and `src/snapshot-build.ts` continue to work. AS 6.5 is satisfied by the entrypoint this implementation returns.

  _Acceptance criteria:_
  - The exported interface shape matches the contracts' SpawnBackend Interface section: `name`, `baseImage`, `requiredEnvVars`, `buildEntrypoint(promptFilePath: string): string[]`
  - The Claude Code implementation's `name`, `baseImage`, `requiredEnvVars`, and `buildEntrypoint` output match the contracts' Claude Code Implementation block exactly, including the explicit `sh -c` shell form and all four flags listed in AS 6.5
  - Existing consumers of `BASE_IMAGE` (dispatch action, Dockerfile generator) continue to compile and pass tests without import-path churn
  - Unit tests assert the entrypoint array returned for a representative prompt path and the field values for `name`, `baseImage`, and `requiredEnvVars`

- [ ] **Finalize raw prompt with spawn ID and container working directory**

  Add a pure finalization helper alongside the prompt-ingestion module that takes the raw prompt plus the spawn context (spawn ID, container working directory) and returns the finalized prompt string the backend will see. The container working directory must be derived from the Dockerfile `WORKDIR` declared in `src/snapshot-build.ts` rather than hardcoded as a separate literal. AS 6.3 is satisfied by the finalization output.

  _Acceptance criteria:_
  - AS 6.3 holds: the finalized prompt contains the operator's raw prompt verbatim plus spawn context metadata (spawn ID and container working directory)
  - The function is pure — no filesystem, network, or clock side effects beyond its inputs — so it composes cleanly with Tasks 1, 4, and 5
  - The container working directory referenced in the finalized prompt matches the Dockerfile's `WORKDIR` (single source of truth)
  - Unit tests assert the finalized output contains all three required pieces (raw prompt, spawn ID, working directory) for representative inputs

- [ ] **Bake finalized prompt into Docker image via build context**

  Extend the snapshot stage so the finalized prompt is written into the temp build context produced by `createBuildContext` in `src/snapshot.ts` and the generated Dockerfile produced by `writeSpawnDockerfile` in `src/snapshot-build.ts` `COPY`s it into the image at the path consumed by `claudeCodeBackend.buildEntrypoint`. The contracts' Container Launch template (a single `docker run`) must remain intact — do not split into `docker create` + `docker cp` + `docker start`. The build context's existing tracked-file copy and Snapshot Exclusion List behavior must be unchanged for worktree files; the prompt file is added separately and is not subject to the exclusion list. AS 6.4's "container has the finalized prompt available at the entrypoint path" is satisfied here; the actual backend invocation is exercised end-to-end once Story 5 wires the `docker run`.

  _Acceptance criteria:_
  - The built image contains the finalized prompt at the path embedded in `claudeCodeBackend.buildEntrypoint`
  - The generated Dockerfile remains compatible with the contracts' single `docker run` Container Launch template (no create/cp/start split)
  - Existing worktree-file copy semantics and the Snapshot Exclusion List continue to apply unchanged to tracked files (prior US4 unit + integration tests pass without modification)
  - The temp build context is cleaned up on both the success and failure paths, matching the existing AS 4.x parity in `src/cli.ts`
  - Failures injecting the prompt into the build context surface as a clear error and trigger the existing reverse-order cleanup chain (image → worktree → branch) plus the SpawnRecord `created → failed` transition per FR-021
  - Unit tests cover both the build-context placement (the prompt file appears in the temp directory) and the generated Dockerfile (the new `COPY` directive appears with the correct destination)

- [ ] **Persist raw prompt onto SpawnRecord before backend handoff**

  Add an `updateSpawnRecordPrompt` helper to `src/spawn-record.ts` alongside the existing `updateSpawnRecordImageId` helper. The helper reads the existing record, sets the `prompt` field to the operator's raw prompt, and writes the record back atomically (temp file + rename) following the existing helpers' pattern. Wire the call into the dispatch action in `src/cli.ts` between prompt resolution (Task 1) and Stage 4 (Launch — owned by Story 5) so the record is data-model-conformant before any downstream consumer reads it. This closes SD-004 from `03-isolated-worktree-and-branch.tasks.md`.

  _Acceptance criteria:_
  - The SpawnRecord at `~/.march/spawns/<spawn-id>.json` contains the operator's raw prompt before the dispatch action would proceed into Stage 4
  - The atomic-write pattern (temp file + rename) matches `updateSpawnRecordImageId` and `markSpawnRecordFailed`
  - The helper does NOT modify `status` or any other field on the record
  - A missing record file surfaces a `SpawnRecordError` with a clear message
  - Failure to persist the prompt triggers the same reverse-order cleanup as a snapshot/build failure and transitions the SpawnRecord to `"failed"` per the data-model `created → failed` transition (FR-021)
  - SD-004 from `03-isolated-worktree-and-branch.tasks.md` is closed: any record reaching `"running"` or beyond carries a populated `prompt` field
  - Unit tests cover the happy path, the missing-record error path, and assert that no other fields are mutated; an integration test in `src/cli.test.ts` asserts the post-Stage-3 record on disk includes `prompt`

**PR Outcome**: `march spawn dispatch --prompt-file <path>` (and the `--prompt <string>` and piped-stdin variants) from inside a valid repo runs Stages 1–3 unchanged, reads and finalizes the operator's prompt, persists the raw prompt onto the SpawnRecord, bakes the finalized prompt into the spawn's tagged Docker image at the path the Claude Code backend will read, and exposes a `SpawnBackend` interface plus Claude Code implementation whose `buildEntrypoint` returns the contracts' exact entrypoint command array. The dispatch action still falls through to the existing "march spawn is not yet implemented" placeholder after Stage 3 (Story 5 removes it). All five US6 acceptance scenarios are satisfied at the layer this slice owns; AS 6.4's full end-to-end execution is exercised once Story 5 wires `docker run`.

---

## Specification Debt

_Upstream spec debt could not be parsed — inheritance skipped._

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Finalized prompt format is unspecified. FR-014 requires the finalized prompt to "include the operator's raw prompt plus spawn context metadata (spawn ID, container working directory)" but does not define the structure (header block prepended, trailing footer, key-value preamble, JSON envelope). Assumption for this slice: prepend a short header block (`Spawn ID: <id>` and `Working Directory: <path>` lines) followed by a blank line and the raw prompt verbatim. Multiple defensible formats exist; flag for operator validation once a real spawn runs end-to-end (post-Story 5). | Scope Edges | High | Medium | open | — |
| SD-002 | Verification strategy for Task 4's "prompt lands at `/march/prompt.txt` in the image" without a running container (Story 5 not yet shipped) is undefined. Assumption: unit tests assert (a) the temp build context contains the prompt file at the expected name and (b) the generated Dockerfile contains the new `COPY` directive with the correct destination. An optional integration test gated behind a "docker available" check round-trips through `docker run --entrypoint cat` to confirm the file is at the expected path inside a built image, mirroring US4's docker-stub-vs-real-daemon pattern. Reviewers may disagree about whether the integration check belongs in US6 or US5. | Testing Strategy | High | Medium | open | — |
| SD-003 | Whether the prompt-file `COPY` in the generated Dockerfile should use `--chown=march:march` to match the existing worktree `COPY` directive. The base image runs as the non-root `march` user (per `--user march` in the contracts and US4's SD-003). A prompt file owned by root could fail to read inside the container depending on the base image's permission setup. Assumption: yes, use `--chown=march:march` for symmetry with the worktree `COPY` and to avoid permission surprises. The spec is silent; revisit with the base-image maintainers if the assumption proves wrong. | Scope Edges | High | Medium | open | — |
| SD-004 | Whether to introduce a shared `PROMPT_PATH` constant (e.g., `/march/prompt.txt`) in `src/spawn-config.ts` consumed by both `claudeCodeBackend.buildEntrypoint` (which embeds the path in the `sh -c` command) and the snapshot Dockerfile generator (which writes the `COPY` destination). Assumption: yes — introduce `PROMPT_PATH` in `spawn-config.ts` and import it in both call sites so the entrypoint and the Dockerfile cannot drift. A reviewer may prefer to keep the literal in two places to avoid a cross-module dependency, given the contracts already parameterize `buildEntrypoint`. | Scope Edges | Medium | Medium | open | — |
| SD-005 | Stdin reading on TTY is unspecified. When neither `--prompt-file` nor `--prompt` is provided, an attempt to read stdin from a TTY would block waiting for the operator. Assumption: detect via `process.stdin.isTTY` and treat a TTY-attached stdin with no flag as a usage error (exit 2), matching US1's "fail fast when no prompt source is provided" behavior. The pattern is already used in `src/cli.ts` for the `update` command's downgrade flow. An alternative is the Unix convention (always attempt the read; let the operator Ctrl-D). | Technical Risk | Medium | Medium | open | — |
| SD-006 | Buffer size limits for stdin reads and prompt-file reads are unspecified. Very large prompts (e.g., multi-megabyte transcripts) will succeed in Node but may overflow Claude Code's `-p` flag or the `sh -c` command line via `ARG_MAX`. Assumption: no explicit cap in US6 — rely on the OS `ARG_MAX` and Claude CLI's own limits to surface a failure downstream. Low impact in practice; flagged for completeness. | Technical Risk | Low | Medium | open | — |
| SD-007 | Shell-special characters in the operator's raw prompt may break the `sh -c 'claude -p "$(cat /march/prompt.txt)" ...'` entrypoint because `$(cat ...)` substitutes the file contents into the shell's argument-parsing pass. A prompt containing `"`, `$(...)`, or backticks will mis-parse. Assumption: not a US6 concern — the contracts mandate the exact `sh -c` form, so any sanitization or invocation-form change would alter the contract. Reviewers may disagree about whether a sanitization step or alternative invocation form (e.g., reading the file in Node and passing `-p` inline) is appropriate. | Technical Risk | Medium | Low | open | — |
| SD-008 | Within Slice 1, the dependency graph among the five tasks is documented in the `## Dependency Order` section below but the granularity may be debated. Assumption: Tasks 1 and 2 are independent and parallel-eligible; Task 3 depends on Task 1's raw-prompt type; Task 4 depends on Tasks 2 and 3 (needs the finalized prompt and the agreed `PROMPT_PATH`); Task 5 depends on Task 1 only. Reviewers may prefer folding Task 3 into Task 1 (single read-and-finalize function) or shipping Task 5 as a separate PR closing SD-004 from US3. | Implementation Order | Medium | Medium | open | — |

---

## Dependency Order

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | Finalize Prompt and Define Backend Contract | — | — |

Within Slice 1, Tasks 1 (prompt resolution) and 2 (`SpawnBackend` interface and Claude Code implementation) are independent and parallel-eligible — the prompt-ingestion module knows nothing about the backend interface, and `buildEntrypoint` returns the contracts' fixed array regardless of how the prompt is read. Task 3 (finalize prompt) consumes Task 1's raw-prompt type and references the Dockerfile `WORKDIR` declared in the snapshot module, so it can land any time after Task 1. Task 4 (bake into image) consumes Task 3's finalized prompt and the path defined alongside Task 2's interface (see SD-004), so it lands after both. Task 5 (`updateSpawnRecordPrompt` and dispatch wiring) consumes Task 1's raw prompt and is independent of Tasks 2–4 at the module level, but its integration tests in `src/cli.test.ts` exercise the full pipeline, so it lands last. All five tasks belong to the same PR.

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Spawn Dispatch CLI Surface | depends on | US1 owns the Commander subcommand-group refactor for `march spawn dispatch`. The refactor is described in `01-spawn-dispatch-cli-surface.tasks.md` (with checked-off tasks) but is not reflected in `src/cli.ts` at HEAD — `--prompt-file` and `--prompt` are silently swallowed by `.allowUnknownOption()` today. Task 1 is authorized to either register Commander options on the existing flat `spawn [subcommand]` command or parse `process.argv` directly, but must not redo US1's structural refactor. The state inconsistency is feature-level debt for someone to reconcile, not US6 work. |
| User Story 3: Create Isolated Worktree and Branch per Spawn | depends on | US3's initial SpawnRecord write deliberately omits the data-model-required `prompt` field per its own SD-004. Task 5 closes that debt by populating `prompt` before the dispatch action would proceed into Stage 4 (Launch). |
| User Story 4: Snapshot Worktree into Docker Image | depends on | Task 4 extends `src/snapshot.ts` and `src/snapshot-build.ts`. The reverse-order cleanup chain established by US4 (image → worktree → branch + `markSpawnRecordFailed`) must continue to cover prompt-injection failures. Existing US4 unit and integration tests must pass unchanged. |
| User Story 5: Launch Container with Hardcoded Security Configuration | depends on | US5 owns the actual `docker run` invocation, the post-Stage-3 fallthrough removal in `src/cli.ts`, and the security flags (`--cap-drop=ALL`, `--user march`, memory/CPU limits, env whitelist sourced from `claudeCodeBackend.requiredEnvVars`). US6 produces every input US5 needs (image with prompt baked in, `SpawnBackend.buildEntrypoint` output, env whitelist via `requiredEnvVars`). The `cli.test.ts` "march spawn is not yet implemented" assertion remains valid for US6; US5 updates it. |
| User Story 7: Container Lifecycle: Wait for Exit | depended upon by | US7 blocks on the container US5 starts and updates the SpawnRecord through `running → stopped/failed`. The `prompt` field US6 writes via Task 5 remains populated through all subsequent transitions. |
| Feature 3: Multi-Backend Execution Interface | depended upon by | The `SpawnBackend` interface introduced by Task 2 in `src/spawn-config.ts` is the contract boundary Feature 3 polymorphically extends with a Gemini implementation and a backend-selection mechanism. Feature 2 ships the interface plus a single hardcoded Claude Code implementation per the contracts. |
| Feature 5: Spawn Output Extraction | depended upon by | Feature 5 reads the SpawnRecord to locate the stopped container and extract output. The `prompt` field Task 5 populates is required for Feature 6 (PR Integration) but already has to be present once the record reaches `"running"` for downstream consumers to be data-model-conformant. |
