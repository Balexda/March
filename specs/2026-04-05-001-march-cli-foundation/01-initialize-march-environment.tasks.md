# Tasks: Initialize March Environment

**Source**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.spec.md` — User Story 1
**Data Model**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.data-model.md`
**Contracts**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.contracts.md`
**Story Number**: 01

---

## Slice 1: Project Skeleton and Minimal CLI Entry Point

**Goal**: Establish the TypeScript project with build tooling and a minimal `march` binary that routes `march init` to a stub handler.

**Justification**: Nothing can be implemented without a buildable project and entry point. This slice produces a runnable binary — not disconnected scaffolding — that accepts `march init` and exits with a placeholder message.

**Addresses**: FR-009 (exit codes); FR-006 (partial — minimal dispatch for init only)

### Tasks

- [x] Initialize the TypeScript project following the SmithyCLI pattern: `package.json` with `name` (`@balexda/march`), `version` (`0.1.0`), `type: "module"`, `bin: { "march": "./dist/cli.js" }`, and scripts mirroring SmithyCLI: `"pretest": "tsup src/cli.ts --format esm --clean"`, `"test": "vitest run"`, `"build": "tsup src/cli.ts --format esm --clean"`, `"start": "node dist/cli.js"`, `"typecheck": "tsc --noEmit"`. Add `"files": ["dist", "src/templates"]` for publishing.
- [x] Add dev dependencies: `typescript`, `tsup`, `vitest`, `@types/node`. Add runtime dependencies: `commander` (CLI framework — consistent with SmithyCLI), `picocolors` (terminal output).
- [x] Add `tsconfig.json` targeting ESNext/NodeNext with strict mode enabled.
- [ ] Create `src/cli.ts` as the CLI entry point using `commander`: define a top-level `march` program with version `0.1.0`. Register an `init` command that prints "not yet implemented" and exits 1. If no command or an unrecognized command, print usage and exit 2. Accept `--yes` flag at the program level without error (no-op).
- [x] Define exit code constants (`SUCCESS = 0`, `ERROR = 1`, `USAGE_ERROR = 2`) in `src/exit-codes.ts`.
- [ ] Write tests using vitest: `march init` exits 1 with stub message; `march` (no args) exits 2 with usage hint; `march nonexistent` exits 2; `--yes` flag is accepted without error.
- [x] Add `.gitignore` entries for `node_modules/`, `dist/`, and build artifacts.

**PR Outcome**: A buildable, testable TypeScript project using tsup + vitest (matching SmithyCLI conventions) that produces a `march` CLI binary via commander. Running `march init` prints a stub message and exits 1. Running `march` with no args or an invalid command exits 2.

---

## Slice 2: Manifest Creation and Pre-Flight Guards

**Goal**: Implement the core `march init` logic that creates `~/.march/march-manifest.json` after verifying the environment is safe to write to, with guards for existing installations and unwritable directories.

**Justification**: The manifest is the foundation of the March installation — every other command depends on it. The pre-flight guards prevent corrupted state and give clear error messages. This slice delivers a working `march init` that creates the manifest (without skills yet).

**Addresses**: FR-001 (create manifest); FR-003 (detect existing install); FR-011 (fail if unwritable); Acceptance Scenarios US1-1 (partial — manifest only), US1-4, US1-5

### Tasks

- [ ] Define the `MarchManifest` TypeScript interface in `src/manifest.ts` matching the data model: `version` (number), `marchVersion` (string), `deployLocation` (string), `agents` (string[]), `files` (Record<string, string[]>). Add a factory function `createManifest(cliVersion: string): MarchManifest` that returns a manifest with `version: 1`, `marchVersion` set to the passed `cliVersion`, `deployLocation: "user"`, `agents: ["claude"]`, and `files: { claude: [] }`.
- [ ] Implement `src/init.ts` with the init command handler. Accept a `homeDir` parameter (defaults to `os.homedir()`) to enable testing with temp directories. The handler orchestrates: (1) check for existing manifest, (2) check writability, (3) create dirs, (4) write manifest.
- [ ] Implement the already-installed guard: if `~/.march/march-manifest.json` exists and contains valid JSON, print "March is already installed. Run `march update` to upgrade." to stdout and exit 1 (FR-003).
- [ ] Implement corrupted manifest detection: if `~/.march/march-manifest.json` exists but is not valid JSON or fails schema validation, print a warning about the corrupted manifest and exit 1 with a message suggesting manual removal and re-init.
- [ ] Implement writability pre-checks: before creating anything, create `~/.march/` and `~/.claude/` directories if they don't exist (using `fs.mkdir` with `recursive: true`), then explicitly verify write permission on each directory using `fs.access` with `fs.constants.W_OK`. This two-step check is necessary because `mkdir` with `recursive: true` succeeds silently on pre-existing read-only directories. If directory creation fails or the writability check fails, print a clear error naming the unwritable directory and exit 1 (FR-011).
- [ ] On successful pre-checks, write `~/.march/march-manifest.json` with the manifest JSON (pretty-printed with 2-space indent). Print a success message to stdout listing what was created.
- [ ] Wire the init handler into `src/cli.ts` dispatch, replacing the stub from Slice 1.
- [ ] Write tests against a temporary HOME directory: (a) clean install creates manifest with correct schema and field values, (b) already-installed guard triggers on existing valid manifest (exit 1, correct message), (c) corrupted manifest detected (exit 1, warning), (d) unwritable directory fails with clear error (exit 1).

**PR Outcome**: `march init` creates `~/.march/march-manifest.json` on a clean system, or fails clearly if already installed or if directories are unwritable. No skill files deployed yet.

---

## Slice 3: Skill File Deployment

**Goal**: Deploy the 3 M1 placeholder skill files to `~/.claude/commands/` and `~/.claude/prompts/`, record them in the manifest, and write the manifest last to prevent partial state.

**Justification**: Skill deployment is the primary deliverable of the init command — without it, the CLI has no agent integration. Writing the manifest after skills are deployed ensures consistency.

**Addresses**: FR-002 (deploy skills, record in manifest); FR-012 (march. prefix); Acceptance Scenarios US1-1 (complete), US2-1, US2-2

### Tasks

- [ ] Define the skill list in `src/skills.ts`: a function (e.g., `getM1Skills()`) returning an array of skill definitions, each with `filename`, `category`, `deployTarget`, `agent`, and `content` (matching the MarchSkill entity in the data model). All M1 skills target `agent: "claude"`. The three M1 skills are:
  - `march.spawn-dispatch.md` → `~/.claude/commands/` (category: spawn-dispatch)
  - `march.spawn-status.md` → `~/.claude/commands/` (category: spawn-status)
  - `march.output-handling.md` → `~/.claude/prompts/` (category: output-handling)
- [ ] Author minimal placeholder markdown content for each skill file. Each should have a title (e.g., `# March: Spawn Dispatch`) and a one-line body stating it is a placeholder that will be authored during Features 2-6.
- [ ] Implement skill deployment in `src/init.ts` (or a `deploySkills` function called by init): iterate the skill list, create target directories if missing, write each file to its deploy target. All filenames must use the `march.` prefix (FR-012).
- [ ] After all skill files are written successfully, populate the manifest's `files.claude` array with the deployed paths relative to HOME using forward slashes and no leading `~/` (e.g., `.claude/commands/march.spawn-dispatch.md`). Then write the manifest to disk. This "write manifest last" ordering prevents partial state where the manifest claims files exist but they don't.
- [ ] Update the init success message to include the list of deployed skill files.
- [ ] Write tests: (a) after init, all 3 skill files exist at expected paths and are valid markdown, (b) manifest `files.claude` contains exactly 3 paths in the correct relative format (no `~/` prefix), (c) `~/.claude/commands/` and `~/.claude/prompts/` directories are created if absent, (d) all deployed filenames start with `march.`.

**PR Outcome**: `march init` now deploys 3 placeholder skill files to `~/.claude/commands/` and `~/.claude/prompts/`, records them in the manifest, and prints a summary. The full happy-path init flow works end-to-end (minus dependency warnings).

---

## Slice 4: Dependency Warnings and End-to-End Integration Tests

**Goal**: Add git and Docker PATH checks that print warnings to stderr without blocking init, and comprehensive end-to-end tests covering all 5 US1 acceptance scenarios.

**Justification**: Dependency warnings complete the init contract. End-to-end tests validate the full flow against all acceptance scenarios, closing out US1.

**Addresses**: FR-010 (git/Docker warnings); Acceptance Scenarios US1-2, US1-3; full coverage of US1-1 through US1-5

### Tasks

- [ ] Implement dependency checking in `src/deps.ts`: a function that checks whether a given executable is on PATH (e.g., using `child_process.execSync('which <name>')` or a cross-platform equivalent). Return a boolean indicating found/not-found.
- [ ] Define the init dependency requirements: `git` with warning message "git not found — required for spawn operations." and `docker` with warning message "Docker not found — required for spawn operations."
- [ ] Wire dependency checks into the init flow (in `src/init.ts`): after successful manifest and skill deployment, check for git and docker. Print any warnings to **stderr** (per contracts doc). Init still exits 0 regardless of warnings.
- [ ] Write unit tests for the dependency checker: mock or manipulate PATH to test found/not-found cases.
- [ ] Write end-to-end integration tests against a temporary HOME covering all 5 US1 acceptance scenarios:
  - Scenario 1: Clean install — manifest created, 3 skill files deployed, exit 0.
  - Scenario 2: git missing from PATH — init succeeds, warning on stderr.
  - Scenario 3: Docker missing from PATH — init succeeds, warning on stderr.
  - Scenario 4: Unwritable home directories — init fails with clear error, exit 1.
  - Scenario 5: Existing installation — init prints redirect to `march update`, exit 1.
- [ ] Verify that when both git and Docker are present on PATH, no warnings are printed (Acceptance Scenarios US6-1, US6-2).

**PR Outcome**: `march init` is feature-complete for US1. All 5 acceptance scenarios pass. Dependency warnings print to stderr without blocking init.

---

## Dependency Order

Recommended implementation sequence:

1. **Slice 1** — must come first; establishes the project and entry point that all other slices build on.
2. **Slice 2** — depends on Slice 1 dispatch; delivers manifest creation which Slice 3 depends on.
3. **Slice 3** — depends on Slice 2 manifest; deploys skills and populates the manifest's files mapping.
4. **Slice 4** — depends on Slices 2-3 for the full init flow; adds warnings and comprehensive e2e tests.

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Deploy Spawn-Interaction Skills | depended upon by | US2 replaces placeholder skill content with real instructions. US1 establishes the deployment mechanism and file slots that US2 builds on. |
| User Story 3: Update March Installation | depended upon by | US3's `march update` reads the manifest created by US1's `march init`. The manifest schema and file-tracking conventions established here are consumed by update logic. |
| User Story 4: CLI Command Structure and Dispatch | depends on | US4 establishes the full two-tier dispatch. US1 uses a minimal dispatcher; if US4 lands first, US1 plugs into it. If US1 lands first, US4 replaces the minimal dispatcher. |
| User Story 5: Help and Version Output | depends on | US5 owns `march help` and `march version`. US1 does not implement these. |
| User Story 6: Dependency Warnings at Init Time | depended upon by | US6 expands on the dependency warning behavior. US1 implements the basic git/Docker checks; US6 may add `march spawn` failure behavior for missing deps. |
