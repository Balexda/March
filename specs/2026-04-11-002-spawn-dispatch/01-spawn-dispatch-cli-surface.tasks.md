# Tasks: Spawn Dispatch CLI Surface

**Source**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.spec.md` — User Story 1
**Data Model**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.data-model.md`
**Contracts**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.contracts.md`
**Story Number**: 01

---

## Slice 1: Replace Spawn Stub with Commander Subcommand Group

**Goal**: Transform the Feature 1 `spawn` flat stub into a proper Commander subcommand group with a registered `dispatch` child command. All four acceptance scenarios pass: `--help` prints usage, no verb exits 2, unknown verb exits 2, and missing prompt source exits 2.

**Justification**: The entire user story touches two files (`src/cli.ts` and `src/cli.test.ts`) and requires no new modules or dependencies. The production code change and the test replacement are tightly coupled — the existing tests assert behavior that is intentionally replaced, so they must be updated atomically to keep the test suite green at every commit boundary.

**Addresses**: FR-001, FR-002, FR-022; Acceptance Scenarios 1.1, 1.2, 1.3, 1.4

### Tasks

- [x] Replace the `program.command("spawn [subcommand]")` flat stub in `src/cli.ts` with a Commander subcommand group. Register a `spawn` parent command via `program.command("spawn")` with a description of "Spawn operations". Register a `dispatch` child command under the spawn parent with `--prompt-file <path>`, `--prompt <string>`, and `--base <ref>` options. The `dispatch` action must: (a) set `commandHandled = true`, (b) call the existing `checkSpawnDependencies()` as the first gate to preserve the current git-check behavior and avoid a regression, (c) validate that at least one of `--prompt-file` or `--prompt` was provided — if neither flag is present, print a usage error to stderr (mentioning all three sources: `--prompt-file`, `--prompt`, and stdin) and exit with `USAGE_ERROR` (code 2), (d) otherwise print a placeholder message indicating the dispatch pipeline is not yet implemented and exit with `ERROR` (code 1). The `spawn` parent must have an explicit `.action()` that sets `commandHandled = true` and handles two cases: if an unknown verb argument was passed (e.g., `march spawn nonexistent`), print an error message following the existing codebase pattern (cf. the `help` command's unknown-command handling in the same file) and exit with `USAGE_ERROR`; if no verb was passed, output spawn-level help and exit with `USAGE_ERROR`. Remove the `.allowUnknownOption()` call that currently causes unknown subcommands to be silently swallowed. In `src/cli.test.ts`, replace the existing spawn stub tests (the block asserting "not yet implemented" behavior and "behaves same as bare spawn" assertions) with tests for all four acceptance scenarios: (1) `march spawn dispatch --help` exits 0 and stdout contains usage information including option names, (2) `march spawn` with no verb exits 2 and output lists `dispatch` as an available verb, (3) `march spawn nonexistent` exits 2 and output indicates the unknown verb, (4) `march spawn dispatch` with no prompt flags exits 2 with a usage error message. Update the existing `march spawn --help` test if the output format changes due to the subcommand group restructuring.

**PR Outcome**: `march spawn dispatch` is a discoverable, well-structured CLI entry point with argument parsing. `march spawn --help` and `march spawn dispatch --help` print accurate usage. `march spawn` with no verb and `march spawn nonexistent` both exit 2. `march spawn dispatch` without a prompt argument exits 2. The Feature 1 "not yet implemented" stub is fully replaced. All CLI tests pass.

---

## Dependency Order

| ID | Title                                              | Depends On | Artifact |
|----|----------------------------------------------------|------------|----------|
| S1 | Replace Spawn Stub with Commander Subcommand Group | —          | —        |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Dependency Validation at Dispatch Time | depended upon by | Story 2 adds full dependency validation (git, docker, base image, repo context) inside the `dispatch` action. Story 1 preserves the existing `checkSpawnDependencies()` git-only check as a transitional measure; Story 2 expands or replaces it. |
| User Story 6: Finalize Prompt and Hand Off to Backend | depended upon by | Story 6 implements actual prompt reading (file, inline, stdin) and finalization. Story 1 only validates that at least one prompt flag was provided; it does not read or process the prompt content. Stdin detection is deferred to Story 6. |
