# Tasks: Update March Installation

**Source**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.spec.md` — User Story 3
**Data Model**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.data-model.md`
**Contracts**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.contracts.md`
**Story Number**: 03

---

## Slice 1: `march update` Command

**Goal**: A working `march update` command that reads an existing manifest, compares versions, deploys new skill files, removes stale manifest-tracked files, preserves untracked user files, updates the manifest, and handles all edge cases (no installation, same version, downgrade warning).

**Justification**: The update module is structurally parallel to init — the same function handles all four acceptance scenarios and the edge case. All scenarios test the same core logic (read manifest, compare, diff files, act). Splitting further would create a PR where the module exists but the command is unreachable, which is not a working increment.

**Addresses**: FR-004, FR-005, FR-006 (partial — registering `update` as a setup command), FR-008, FR-009; Acceptance Scenarios US3-1, US3-2, US3-3, US3-4; edge case (update before init)

### Tasks

- [ ] Create `src/update.ts` exporting `UpdateError`, `UpdateResult`, and `updateMarch()` — implement the no-installation guard and version comparison logic. `UpdateError` should mirror `InitError` from `src/init.ts`. `UpdateResult` should include `summary: string`, `warnings: string[]`, `added: string[]`, `removed: string[]`, `skipped: boolean` (true when already up-to-date), and `downgrade: boolean`. The function should accept an optional `homeDir` parameter (defaulting to `os.homedir()`) for test isolation, matching `initMarch()`'s signature. The function must: (a) read and validate `~/.march/march-manifest.json` — throw `UpdateError` directing the user to run `march init` if the manifest is absent (ENOENT/ENOTDIR), and throw `UpdateError` describing the corruption if the file contains invalid JSON or fails `isValidManifest()`; (b) compare `manifest.marchVersion` against `CLI_VERSION` from `src/version.ts` using inline semver tuple comparison (split on `.`, compare major/minor/patch as integers — no external semver dependency). Before comparing, validate that both version strings match the `MAJOR.MINOR.PATCH` pattern (three dot-separated non-negative integers with no prerelease or build metadata); if either version contains a prerelease suffix (e.g., `0.2.0-beta.1`) or build metadata (e.g., `0.2.0+build.42`), throw `UpdateError` with a message explaining that only `MAJOR.MINOR.PATCH` versions are supported for comparison — if versions are equal, return early with `skipped: true` and an informational "already up to date" summary; if the installed version is newer than the CLI version, set `downgrade: true` and include a downgrade warning in `warnings[]` but do not perform file operations yet — return the result so the CLI layer can prompt for confirmation before re-invoking with a force option.

- [ ] Implement the file diffing, deployment, removal, and manifest rewrite logic in `updateMarch()`. The function needs a mechanism (e.g., a `force` option) to distinguish between "check only" mode (for downgrade detection) and "proceed" mode. When proceeding, the function must: (a) call `getM1Skills()` from `src/skills.ts` to obtain the current deployment set and compute the diff between the manifest's `files.claude` array and the new deployment paths — identify added paths (in new set but not in manifest), removed paths (in manifest but not in new set); (b) deploy new skill files by writing them to their target directories under the home directory (creating directories as needed with `fs.mkdir`), throwing `UpdateError` on write failure; (c) delete stale files — those tracked in the old manifest but absent from the new set — by removing them from disk, throwing `UpdateError` on deletion failure (fail fast on first error); (d) never touch files on disk that are not tracked in the manifest, ensuring untracked user customizations are preserved (FR-005); (e) rewrite `~/.march/march-manifest.json` with `marchVersion` set to `CLI_VERSION` and `files.claude` set to the full new deployment path list — write the manifest last, after all filesystem operations succeed, to prevent partial state; (f) return an `UpdateResult` with a human-readable summary listing added, removed, and unchanged files (per the contracts doc's "List of added, removed, and unchanged files" output requirement), and any collected warnings.

- [ ] Register the `update` command in `src/cli.ts` and implement the downgrade confirmation flow. Import `updateMarch` and `UpdateError` from `src/update.ts`. Add a `program.command("update")` block following the same pattern as the `init` command registration: set `commandHandled = true` in the action, call `updateMarch()`, print `result.summary` to stdout, write each entry in `result.warnings` to stderr. Map `UpdateError` to `process.exitCode = ERROR` (printing `err.message` to stderr). On success, set `process.exitCode = SUCCESS`. For the downgrade flow: if the initial `updateMarch()` call returns `result.downgrade === true` and `program.opts().yes` is not set, prompt the operator for confirmation before re-invoking `updateMarch()` with force enabled. Guard against non-TTY environments — if `process.stdin.isTTY` is false and `--yes` is not passed, print a message instructing the user to pass `--yes` to force the downgrade and exit 0 without performing the update. If `--yes` is set, bypass the prompt and proceed directly with the forced update.

**PR Outcome**: `march update` is fully functional. Operators can upgrade from a prior version (new files deployed, stale files removed, manifest updated, exit 0), receive an "up to date" message when the version matches (exit 0), get warned about downgrades with a confirmation prompt bypassed by `--yes` (exit 0), and have their untracked customizations preserved. The command appears in `march help` output and responds to `--help`.

---

## Dependency Order

Recommended implementation sequence:

1. **Slice 1** — This is the only slice. It depends on the already-merged init infrastructure (`src/manifest.ts`, `src/skills.ts`, `src/init.ts`, `src/cli.ts`, `src/version.ts`, `src/exit-codes.ts`).

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Initialize March Environment | depends on | US1 establishes the manifest schema (`createManifest`, `isValidManifest`), the skill definitions (`getM1Skills`), and the CLI dispatch pattern that US3 reuses. The manifest created by `march init` is the input to `march update`. |
| User Story 2: Deploy Spawn-Interaction Skills | depends on | US2 validates skill file discoverability format (filename pattern, H1 heading). The same format invariants apply to files deployed by `march update`. |
| User Story 4: CLI Command Structure and Dispatch | depended upon by | US4 scenario 1 requires the no-args usage listing to include `update`. The `update` command registered here must exist before US4 can fully satisfy its acceptance criteria. |
| User Story 5: Help and Version Output | depended upon by | US5 requires `update` to be registered for `march help` listing completeness. |
