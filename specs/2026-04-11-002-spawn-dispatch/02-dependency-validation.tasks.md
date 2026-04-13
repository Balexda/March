# Tasks: Dependency Validation at Dispatch Time

**Source**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.spec.md` — User Story 2
**Data Model**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.data-model.md`
**Contracts**: `specs/2026-04-11-002-spawn-dispatch/spawn-dispatch.contracts.md`
**Story Number**: 02

---

## Slice 1: Extend Dependency Checks and Wire into Dispatch Action

**Goal**: `checkSpawnDependencies()` in `src/deps.ts` validates all four hard preconditions (git on PATH, docker on PATH, cwd inside a git repo, base container image accessible) and returns spec-exact error messages on failure. The `dispatch` action in `src/cli.ts` calls this extended function with the configured base image tag. All five acceptance scenarios pass.

**Justification**: The validation logic and its wiring into the dispatch action are tightly coupled — they share a single call site, a single return type (`DependencyCheckResult`), and cannot be delivered independently without breaking the test suite between commits. Delivering as one slice keeps every commit green.

**Addresses**: FR-003, FR-004, FR-022; Acceptance Scenarios 2.1, 2.2, 2.3, 2.4, 2.5

### Tasks

- [x] **Task 1**: Extend `checkSpawnDependencies()` in `src/deps.ts` to accept a required `baseImage: string` parameter and validate all four hard preconditions in order. (1) Keep the existing `isFinderAvailable()` gate. (2) Fix the git error message from `"git not found on PATH — required for spawn operations."` to `"git not found — required for spawn operations"` to match the spec's exact wording (remove "on PATH" and trailing period). (3) Add an `isOnPath("docker")` check returning `{ ok: false, error: "Docker not found — required for spawn operations" }` when docker is absent. (4) Add a git repository context check by running `git rev-parse --show-toplevel` via `execFileSync` — if it throws, return `{ ok: false, error: "Not inside a git repository — march spawn must be run from within a git repo." }`. (5) Add a base image availability check by running `docker image inspect <baseImage>` via `execFileSync` — if it fails (image not found locally), attempt `docker pull <baseImage>` as a fallback — if both fail, return an error that identifies the unavailable image by name. The check ordering must be: finder availability, git on PATH, docker on PATH, repo context, base image. In `src/deps.test.ts`, update the existing `checkSpawnDependencies` test suite: the `ok:true` test currently stubs only `["git"]` and must be updated to stub `["git", "docker"]` and account for the new `baseImage` parameter and repo-context check. Add unit test cases for: docker-missing (stubs `["git"]` only, expects error containing "Docker"), repo-context failure (stubs `["git", "docker"]`, runs check from a non-repo temp directory, expects error containing "git repository"), and base-image unavailable (stubs `["git", "docker"]` with a docker stub that fails on `image inspect` and `pull` subcommands, expects error containing the image name). Note: `INIT_DEPENDENCIES` warning text is out of scope — only the `checkSpawnDependencies()` error messages are updated. The Docker daemon-not-running vs. Docker-CLI-not-on-PATH distinction is out of scope per the spec's assumption that Feature 2 checks CLI on PATH only (spec line 217); daemon connectivity errors during the base image check will surface as the "image not available" error, which is acceptable.

- [x] **Task 2**: Update the `dispatch` action in `src/cli.ts` to call `checkSpawnDependencies(BASE_IMAGE)` where `BASE_IMAGE` is a hardcoded constant for the tagged base image with the backend CLI pre-installed (e.g., `"march-base:latest"`). This replaces the current call to the zero-argument `checkSpawnDependencies()`. Keep the existing error-to-stderr and `process.exitCode = ERROR` pattern for `!result.ok`. When the check passes, the dispatch action should continue to whatever placeholder behavior exists (the full dispatch pipeline is implemented by later stories). In `src/cli.test.ts`, replace the four tests that assert `spawn dispatch` behaves identically to bare `spawn` (the "behaves same as bare spawn" test cases) with five integration tests covering all Story 2 acceptance scenarios: (1) git missing — `makeFakeBin([])`, exit 1, stderr contains "git not found", stderr does NOT contain "Docker"; (2) docker missing — `makeFakeBin(["git"])`, exit 1, stderr contains "Docker not found"; (3) not in a git repo — `makeFakeBin(["git", "docker"])` with docker stub that succeeds for image inspect, run from a non-repo temp dir via `cwd`, exit 1, stderr contains "Not inside a git repository"; (4) base image unavailable — `makeFakeBin(["git", "docker"])` with docker stub that fails on `image inspect` and `pull` subcommands, run from inside a git repo, exit 1, stderr identifies the image name; (5) all dependencies present — `makeFakeBin(["git", "docker"])` with docker stub that succeeds for `image inspect`, run from inside a git repo, no dependency error on stderr (execution continues past validation to the placeholder). The `runWithEnv` helper must be extended to accept an optional `cwd` parameter and pass it through to `spawnSync` — this is needed for the repo-context test (Scenario 2.4) which must run the CLI from a temporary directory outside any git repository. For scenarios requiring smart docker stubs, use shell scripts that inspect their arguments (e.g., exit non-zero when `$1` is `image`) — this follows the established `makeFakeBin` pattern in the codebase.

**PR Outcome**: `march spawn dispatch` fails fast with spec-exact error messages when git is absent, docker is absent, the base image is unavailable, or the operator is outside a git repository. Each failure exits with code 1 and prints the prescribed message to stderr. When all checks pass, dispatch proceeds silently past the validation gate. All unit tests in `deps.test.ts` and integration tests in `cli.test.ts` pass. The conflicting Feature 1 stub behavior tests are replaced.

---

## Specification Debt

None — all ambiguities resolved. Four high-confidence assumptions were identified during clarification and incorporated into the task descriptions:

1. Acceptance scenario 2.5 ("dispatch proceeds") is tested by verifying no dependency error on stderr — the full dispatch pipeline is not implemented in Story 2.
2. Docker stubs follow the established `makeFakeBin` shell-script pattern with argument-aware exit codes.
3. `INIT_DEPENDENCIES` warning text is out of scope for Story 2.
4. The signature change (`baseImage` parameter) and call-site update are in the same slice and ship together.

---

## Dependency Order

| ID | Title                                                  | Depends On | Artifact |
|----|--------------------------------------------------------|------------|----------|
| S1 | Extend Dependency Checks and Wire into Dispatch Action | —          | —        |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Spawn Dispatch CLI Surface | depends on | Story 2 assumes the `dispatch` subcommand registered by Story 1 exists. Story 2's Task 2 updates the `dispatch` action's dependency check call. If Story 1 has not been merged, Story 2 must be developed on top of Story 1's branch. |
| User Story 3: Create Isolated Worktree and Branch per Spawn | depended upon by | Story 3 depends on Story 2's validation gate passing before worktree creation begins. Story 3 will call `checkSpawnDependencies()` (or invoke it transitively via the dispatch pipeline) before creating branches and worktrees. |
| User Story 4: Snapshot Worktree into Docker Image | depended upon by | Story 4 requires the base image to be accessible, which Story 2 validates. The `BASE_IMAGE` constant introduced by Story 2 will eventually be derived from the `SpawnBackend.baseImage` property when Story 4-5 wire the backend interface. |
