# Tasks: Dependency Warnings at Init Time

**Source**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.spec.md` — User Story 6
**Data Model**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.data-model.md`
**Contracts**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.contracts.md`
**Story Number**: 06

---

## Slice 1: Spawn Command Dependency Guard

**Goal**: `march spawn` exists as a registered CLI command that checks whether git is on PATH before proceeding. If git is missing, it exits with a clear, human-readable error naming the missing dependency. If git is present, it prints the "not yet implemented" stub message. Both paths exit with code 1.

**Justification**: Acceptance Scenarios 1-3 (init-time dependency warnings) are already fully implemented and tested in `src/deps.ts`, `src/init.ts`, `src/cli.ts`, and `src/init.test.ts`. The only unimplemented acceptance criterion is Scenario 4, which requires `march spawn` to perform a runtime dependency pre-check. The `march spawn` command does not yet exist in `cli.ts` — this slice creates it with the dependency guard as a single deliverable unit. The dependency-check function is placed in `deps.ts` alongside the existing dependency utilities so it is reusable by future spawn subcommands.

**Addresses**: FR-010 (runtime enforcement of dependency checking); FR-007 (spawn stub); Acceptance Scenario 6.4

### Tasks

- [ ] Add an exported function to `src/deps.ts` that checks whether git is available on PATH and returns a structured result indicating either success or a descriptive error message suitable for stderr output. The function should use the existing `isFinderAvailable()` and `isOnPath()` helpers. When `isFinderAvailable()` returns false, the function should treat this as a blocking failure (cannot confirm git is present — fail safe) and return an appropriate error message, rather than silently skipping the check. This "fail safe" behavior differs from the init-time path, which emits a soft warning, because spawn actually requires git to function.

- [ ] Register a `march spawn` command in `src/cli.ts` that accepts an optional subcommand argument (so `march spawn dispatch` does not produce a Commander unknown-argument error). The command handler should: (1) call the dependency-check function from `deps.ts`, (2) if dependencies are missing, write the error to stderr and set exit code 1, (3) if dependencies are satisfied, print the stub message "march spawn is not yet implemented. It will be available after Feature 2: Spawn Dispatch." to stdout and set exit code 1. Follow the existing command registration conventions: use the `commandHandled` flag and set `process.exitCode` rather than calling `process.exit()`. Note: if Story 4 has already landed and registered a spawn command, augment the existing handler with the dependency pre-check rather than re-registering.

- [ ] Add tests for the spawn command covering: (a) `march spawn` with git missing from PATH exits 1 and stderr contains a message identifying git as the missing dependency — not the "not yet implemented" stub message, (b) `march spawn` with git present on PATH exits 1 with the "not yet implemented" stub message on stdout, (c) `march spawn dispatch` (with a subcommand) behaves the same as the bare command. Integration tests for the CLI surface go in `src/cli.test.ts` using the existing test infrastructure. Use the `makeFakeBin()` pattern from `src/init.test.ts` (or equivalent) to create controlled PATH environments — do not rely on the host machine having or lacking git. Unit tests for the dependency-check function itself go in `src/deps.test.ts` alongside the existing `isOnPath` and `isFinderAvailable` tests.

**PR Outcome**: `march spawn` is a registered CLI command. Running it with git absent from PATH produces a clear dependency error on stderr and exits 1. Running it with git present produces the "not yet implemented" stub message and exits 1. The dependency-check function in `deps.ts` is reusable by future spawn subcommands (Feature 2+). All existing tests continue to pass.

---

## Dependency Order

Recommended implementation sequence:

1. **Slice 1** — This is the only slice. It is self-contained and builds on existing, already-tested infrastructure in `deps.ts` and `cli.ts`.

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Initialize March Environment | depends on | Story 1 implemented the init-time dependency checking (`deps.ts`, `init.ts`) that this story's Scenarios 1-3 rely on. Story 6 extends `deps.ts` with a spawn-time check. |
| User Story 4: CLI Command Structure and Dispatch | depends on | Story 4 owns the `march spawn` stub (FR-007). This story creates the spawn command registration as a prerequisite for Scenario 4. If Story 4 has already landed, the implementing agent should augment the existing spawn handler rather than re-registering it. |
