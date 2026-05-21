# Tasks: CLI Command Structure and Dispatch

**Source**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.spec.md` — User Story 4
**Data Model**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.data-model.md`
**Contracts**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.contracts.md`
**Story Number**: 04

---

## Slice 1: No-Args Output Completeness

**Goal**: The `march` no-args invocation verifiably lists the M1 foundation commands — `init`, `update`, `help`, `version`, and the `spawn` system stub — in its combined output, locking the two-tier listing contract against regression.

> **Note (2026-05):** "all five registered commands" was the M1 surface. The realized
> CLI (`src/cli/program.ts`) registers additional system namespaces — `hatchery`,
> `brood`, `herald`, `castra`, `legate` — added by later milestones. The
> contains-assertions below should be read as a **non-exhaustive subset check**
> (these names are present), not a closed "exactly five" enumeration.

**Justification**: Commander's `program.outputHelp()` already outputs all registered commands when no args are given. The existing test checks exit code 2 and that the output matches `/usage|Usage/i` but asserts no specific command names. This slice adds content assertions that make the two-tier structure a machine-verified property of the CLI — it delivers a working, regression-guarded behavioral contract rather than disconnected scaffolding.

**Addresses**: FR-006, FR-009; Acceptance Scenario 4.1

### Tasks

- [x] In `src/cli.test.ts`, extend the "march with no args exits 2 with usage" test to assert that the combined stdout+stderr output contains each of the strings: `init`, `update`, `help`, `version`, and `spawn`. The no-args behavior (Commander's `outputHelp()` listing all registered commands, gated by the `!commandHandled` fallthrough in `src/cli.ts`) is already implemented — no production code change is needed. This task locks the AS 4.1 two-tier listing contract (setup commands + spawn system namespace) as a regression-guarded assertion.

**PR Outcome**: The no-args output content is pinned. Removing or renaming any registered command will cause this test to fail, preserving the two-tier command listing required by FR-006.

---

## Slice 2: Per-Command --help Coverage and Spawn Stub Alignment

**Goal**: Every registered command (`init`, `update`, `version`, `help`, `spawn`) responds to `--help` with exit 0 and command-specific output, and the spawn stub's dependency-gate behavior is documented in both production code and tests to resolve the spec-vs-implementation conflict identified in the consistency scan.

**Justification**: FR-008 requires every command to support `--help`. Only `march init --help` is currently tested, and only for exit code — not output content. The other four commands have no `--help` tests. Separately, the spawn stub's `checkSpawnDependencies()` pre-check conflicts with the contracts.md description of an unconditional stub — the decision to include the gate is intentional but undocumented. This slice delivers both gaps as a coherent unit: complete `--help` coverage naturally requires understanding the spawn command's behavior, and that understanding drives the alignment comment.

**Addresses**: FR-007, FR-008, FR-009; Acceptance Scenarios 4.2, 4.3; two implementation/spec divergences: (a) `src/cli.ts` calls `checkSpawnDependencies()` before the "not yet implemented" message, but `march-cli-foundation.contracts.md` describes `march spawn` as a pure pass-through stub with no dependency gate; (b) the existing spawn tests in `src/cli.test.ts` validate a two-branch gated behavior (git-missing → error; git-present → stub message), while AS 4.2 describes an unconditional stub

### Tasks

- [x] In `src/cli.test.ts`, add integration tests for `march update --help`, `march version --help`, `march help --help`, and `march spawn --help`. Each test must assert exit code 0 and that stdout contains the command's own name (e.g., the `update --help` test asserts stdout contains "update"). Use the existing `run()` helper without an isolated PATH — Commander processes `--help` before dispatching to `.action()`, so `march spawn --help` does not trigger `checkSpawnDependencies()`. Also extend the existing `march init --help` test to assert that stdout contains both "init" and the command's description text (e.g., "Initialize"), beyond the current exit-code-only assertion.

- [x] In `src/cli.ts`, add a comment to the spawn command's action block (the block that calls `checkSpawnDependencies()` before the "not yet implemented" message) documenting that this pre-check is intentional: spawn requires git even at the stub stage, and the dependency error provides a more actionable response than the stub message would for users whose environment lacks the prerequisite. Note that the contracts.md stub description omits this guard because it describes the logical contract, not the implementation detail.

- [x] In `src/cli.test.ts`, add a comment to the spawn test group (the "march spawn with git missing" and "march spawn with git present" tests) linking the two behavioral branches to Acceptance Scenario 4.2 and documenting that the dependency-gated behavior is the accepted implementation of the spec's unconditional stub — the git-present branch satisfies AS 4.2's "not yet implemented" message requirement; the git-missing branch surfaces a prerequisite error before the stub message.

**PR Outcome**: All five registered commands have `--help` tests asserting exit 0 and command-specific content, satisfying FR-008. The spawn stub's two-branch behavior (dependency-gated in code; unconditional in contracts.md) is documented in code and tests, making the intentional deviation explicit.

---

## Slice 3: Invalid Command Error Message

**Goal**: `march nonexistent` emits an error message naming the invalid command token on stderr before displaying the valid-command help listing on stdout, and exits 2.

**Justification**: AS 4.4 requires "an error message is printed suggesting valid commands" — two elements: an error indicator naming the invalid input, and valid command suggestions. The current `!commandHandled` block calls `program.outputHelp()` (which lists valid commands on stdout) but emits no error message naming the invalid token. Only the second element is satisfied. A targeted stderr write before `program.outputHelp()` delivers the first element without disrupting existing behavior. This slice stands alone because it makes a self-contained, observable behavioral change to the CLI's unrecognized-command path.

**Addresses**: FR-006, FR-009; Acceptance Scenario 4.4

### Tasks

- [x] In `src/cli.ts`, modify the `!commandHandled` fallthrough block at the end of the file to detect when an unrecognized command was given. Scan `process.argv.slice(2)` for the first argument that does not start with `-`. Only if such a token is found, write `error: unknown command '<token>'\n` to stderr (using `process.stderr.write`, matching the format already used in the `march help nonexistent` handler) before calling `program.outputHelp()`. If no non-flag token is found — e.g., `march --yes` where every extra argv entry is a flag — emit no error message and call `program.outputHelp()` directly. Set `process.exitCode = USAGE_ERROR` in all branches. This ensures option-only invocations never produce a spurious "unknown command 'undefined'" message.

- [x] In `src/cli.test.ts`, extend the "march with unrecognized command exits 2" test to assert that stderr contains the string "nonexistent" and that the combined stdout+stderr contains at least one valid command name. Retain the existing exit code 2 assertion.

**PR Outcome**: `march nonexistent` emits a clear error message naming the invalid command before listing valid alternatives. AS 4.4 is fully satisfied: the invalid token appears on stderr as an error signal, and the help listing on stdout provides the valid-command suggestions.

---

## Dependency Order

| ID | Title                                                | Depends On | Artifact |
|----|------------------------------------------------------|------------|----------|
| S1 | No-Args Output Completeness                          | —          | —        |
| S2 | Per-Command --help Coverage and Spawn Stub Alignment | —          | —        |
| S3 | Invalid Command Error Message                        | S1, S2     | —        |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Initialize March Environment | depends on | US1 established the project skeleton, Commander framework, `exit-codes.ts`, and the `commandHandled` pattern that Story 4 tests and extends. All implementation in US4 builds on `src/cli.ts` as established by US1. |
| User Story 5: Help and Version Output | depended upon by | US5 owns the content and format of `march help` and `march version` output. Story 4 verifies the dispatch mechanism and `--help` flag routing; Story 5 owns the help text content quality and version string format. |
| User Story 6: Dependency Warnings at Init Time | depended upon by | US6 AS 6.4 ("march spawn fails with a clear error about the missing dependency") builds on the spawn dependency-gate behavior that Story 4's Slice 2 documents. |
