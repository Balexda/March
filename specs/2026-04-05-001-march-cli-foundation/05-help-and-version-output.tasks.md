# Tasks: Help and Version Output

**Source**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.spec.md` — User Story 5
**Data Model**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.data-model.md`
**Contracts**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.contracts.md`
**Story Number**: 05

---

## Slice 1: Version Subcommand

**Goal**: Register an explicit `march version` subcommand that prints the CLI version string to stdout and exits 0, with byte-for-byte output parity with `march --version`.

**Justification**: Commander's `.version()` already handles `--version`, but there is no `march version` subcommand. This slice adds the subcommand so both invocation forms work identically. A parity assertion in the test suite locks in the equivalence contract.

**Addresses**: FR-013, FR-009; Acceptance Scenarios 5.2, 5.4

### Tasks

- [x] In `src/cli.ts`, register a `version` subcommand after the existing `init` command:
  - `.command("version").description("Display the installed CLI version")`
  - Action sets `commandHandled = true`, calls `console.log(CLI_VERSION)`, sets `process.exitCode = SUCCESS`.
- [x] In `src/cli.test.ts`, add tests:
  - `march version` exits 0 and stdout contains the current package version string.
  - `march version` stdout is byte-for-byte identical to `march --version` stdout (capture both with `run()` and assert `===`).
- [ ] Run `npm test` to confirm all existing tests pass alongside the new ones.

**PR Outcome**: `march version` is a working subcommand that prints the bare version string (e.g., `0.1.0`) and exits 0, with parity guaranteed against `march --version`.

---

## Slice 2: Help Subcommand with Argument Validation

**Goal**: Register an explicit `march help [command]` subcommand that exits 0 for valid invocations, exits 2 for unknown command names, and produces byte-for-byte identical output to `march --help`.

**Justification**: Commander 13 auto-adds a `help` subcommand but does not guarantee exit code 2 when an invalid command name is passed — the contracts document (`march-cli-foundation.contracts.md`) explicitly requires it. An explicit subcommand validates the argument against `program.commands` and enforces the correct exit code. The parity test ensures `march help` and `march --help` remain equivalent as commands are added.

**Addresses**: FR-008, FR-009; Acceptance Scenarios 5.1, 5.3

### Tasks

- [ ] In `src/cli.ts`, register an explicit `help` subcommand after `version` (before `parseAsync`):
  - `.command("help [command]").description("Display help for a command")`
  - Action sets `commandHandled = true`.
  - If a `command` argument is provided, look it up via `program.commands.find(c => c.name() === cmd)`.
    - If not found: write an error to stderr (`error: unknown command '<cmd>'`), call `program.outputHelp()`, set `process.exitCode = USAGE_ERROR`, and return.
    - If found: call `found.outputHelp()`.
  - If no argument: call `program.outputHelp()`.
  - In both valid cases, set `process.exitCode = SUCCESS`.
- [x] In `src/cli.test.ts`, add tests:
  - `march help` exits 0 and stdout lists `init`, `version`, and `help` in the command listing.
  - `march help` stdout is byte-for-byte identical to `march --help` stdout.
  - `march help init` exits 0 and stdout contains init-specific help text.
  - `march help version` exits 0 and stdout contains version-specific help text.
  - `march help nonexistent` exits 2.
  - `march init --help` exits 0 (FR-008 coverage — Commander provides this automatically; this test confirms it is not broken).
- [ ] Run `npm test` to confirm all existing tests pass alongside the new ones.

**PR Outcome**: `march help` is a first-class subcommand with correct exit codes for all invocations (0 for no-arg or valid command, 2 for invalid command name), output identical to `march --help`, and the command listing reflects all registered commands including `version` from Slice 1.

---

## Dependency Order

Recommended implementation sequence:

1. **Slice 1** — `version` must be registered before Slice 2 so that the `march help` listing includes `version` and Slice 2's listing assertion passes.
2. **Slice 2** — Depends on Slice 1; the `march help version` test and the listing assertion both require `version` to already be registered.

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 4: CLI Command Structure and Dispatch | depended upon by | US-4 scenario 1 requires the no-args listing to include `help` and `version`; both subcommands registered here must exist before US-4 can fully satisfy its no-args output requirement. |
