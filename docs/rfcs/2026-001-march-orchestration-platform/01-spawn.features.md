# Feature Map: Spawn

**Source RFC**: `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md`
**Milestone**: 1 — Spawn
**Created**: 2026-03-30
**Status (2026-05-16)**: M1 is **Done (realized)** for F1, F2, F5, F6. F3 (Multi-Backend) is **Done (provisional, diverged)** — Codex shipped instead of Gemini using credential-mount auth; see `specs/2026-05-10-003-multi-backend-execution-interface/` for the amended spec. F4 (Spawn Sandbox Security) has a **draft spec** at `specs/2026-05-12-004-spawn-sandbox-security/` that pre-dates the Gemini cut — its Gemini-egress story (SD-001) is now moot; treat its `allowedEgressHosts` work as applying to Claude Code + Codex only. Patch extraction + PR creation (F5/F6) is realized but extended in `src/hatchery/spawn-handoff.ts` with a Steward handoff that will be formalized in a Stage B spec (see RFC backlog).

## Features

### Feature 1: March CLI Foundation

**Description**: Build the March CLI with `march init` bootstrapping, command structure, and skill deployment following the SmithyCLI pattern. This is the operator's primary interface and a first-class deliverable.

**User-Facing Value**: The operator gets a working CLI that bootstraps their March environment, deploys spawn-interaction skills, and provides the command surface for all subsequent features.

**Scope Boundaries**:
- Includes: `march init` command, skill and prompt deployment, CLI command structure and argument parsing, help and usage output
- Excludes: Spawn execution logic, container management, Hatchery profile management (M2)

### Feature 2: Spawn Dispatch

**Description**: Dispatch a spawn from the CLI: create a git worktree and dedicated branch, snapshot the worktree into a Docker container with restricted outbound access (allowlisted to the LLM API endpoint only) and no host write access, and pass a finalized prompt to a headless AI session inside the container.

**User-Facing Value**: The operator can send a task to an isolated, sandboxed AI executor with a single CLI command. Each spawn gets its own branch and container — no manual worktree or Docker management required.

**Scope Boundaries**:
- Includes: Worktree and branch creation, worktree snapshot (copy, not mount) into Docker container, container launch with hardcoded security config, prompt finalization and handoff to the AI backend, container lifecycle (start, wait for exit)
- Excludes: Output extraction (Feature 5), PR creation (Feature 6), declarative profile configuration (M2 Hatchery), worktree cleanup (M3 Brood)

### Feature 3: Multi-Backend Execution Interface — **Done (provisional, diverged)**

**Description**: A common backend abstraction — prompt in, structured JSON out, exit-code completion signaling — with implementations for **Claude Code CLI** and **Codex CLI** as the two live spawn backends. (Originally specified with Gemini as the second backend; Gemini was cut 2026-05-16. Codex uses a credential-mount auth pattern that env-var-only Gemini did not require.)

**User-Facing Value**: The operator can choose which AI backend to use per spawn based on capability, cost model, or preference. Both backends work through the same interface with no difference in the rest of the workflow.

**Scope Boundaries**:
- Includes: Common backend interface definition, Claude Code CLI integration (`-p`, `--dangerously-skip-permissions`, `--bare`, `--output-format json`), Codex CLI integration (`--dangerously-bypass-approvals-and-sandbox`, credential-mount auth via `/march/codex-auth → CODEX_HOME`), backend-specific auth propagation (env-var for Claude Code; credential-mount for Codex), backend selection via CLI flag or configuration. (Gemini was originally listed here and was cut 2026-05-16.)
- Excludes: Agent SDK programmatic interface (deferred to M3+), local/self-hosted LLM backends

### Feature 4: Spawn Sandbox Security

**Description**: Evaluate and mitigate the known attack surfaces enumerated in Appendix A of the RFC. Ensure that spawn containers enforce the security guarantees the system depends on: no network exfiltration, no host filesystem access, no concurrent extraction, and no secret leakage.

**User-Facing Value**: The operator can trust that a spawn running an LLM in full-auto mode cannot cause damage beyond the sandbox. Verification commands confirm the sandbox posture.

**Scope Boundaries**:
- Includes: Evaluation and mitigation of all 8 Appendix A threat categories (A1–A8), container hardening (cap-drop, non-root user, network=none or restricted), environment variable whitelisting, worktree snapshot exclusion of secrets (.env, credentials), operator-facing verification that sandbox constraints are enforced
- Excludes: Hatchery-managed profile-based security configuration (M2), secondary isolation layers (gVisor, rootless Docker) unless the threat model demands them

### Feature 5: Spawn Output Extraction

**Description**: After the LLM process fully terminates, a deterministic extraction process retrieves the structured JSON output from the stopped container, validates it, and parses the git patch payload.

**User-Facing Value**: The operator gets a validated, structured result from the spawn — including the code changes as a git patch — without needing to interact with the container directly.

**Scope Boundaries**:
- Includes: Sequential handoff enforcement (LLM stopped before extraction begins), JSON retrieval from stopped container, JSON structure validation, git patch parsing, treating all spawn output as untrusted input (defense against A6: output manipulation)
- Excludes: Applying the patch to the worktree (Feature 6), streaming or real-time output observation (future capability)

### Feature 6: PR Integration

**Description**: Complete the spawn loop by applying the extracted patch to the spawn's worktree and branch, pushing the branch, and creating a GitHub PR for code review.

**User-Facing Value**: The operator gets a reviewable pull request on GitHub as the end product of a spawn — closing the full loop from prompt to PR without manual git operations.

**Scope Boundaries**:
- Includes: Patch application to the spawn's worktree/branch, branch push to remote, GitHub PR creation with spawn metadata (prompt summary, backend used, execution stats), CLI output confirming the PR URL
- Excludes: PR review workflows, merge automation, CI/CD integration, worktree cleanup after merge (M3 Brood)

## Dependency Order

| ID | Title                              | Depends On | Artifact                                     |
|----|------------------------------------|------------|----------------------------------------------|
| F1 | March CLI Foundation               | —          | `specs/2026-04-05-001-march-cli-foundation/` |
| F2 | Spawn Dispatch                     | F1         | `specs/2026-04-11-002-spawn-dispatch/`       |
| F3 | Multi-Backend Execution Interface  | F2         | `specs/2026-05-10-003-multi-backend-execution-interface/` |
| F4 | Spawn Sandbox Security             | F2         | `specs/2026-05-12-004-spawn-sandbox-security/` |
| F5 | Spawn Output Extraction            | F2         | —                                            |
| F6 | PR Integration                     | F5         | —                                            |

## Cross-Milestone Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| Milestone 2: Hatchery | depended upon by | Milestone 2 formalizes the hardcoded container configuration from Features 2 and 4 into declarative, editable profiles. The `SpawnConfig` constant and the security posture established here become the seed for the first Hatchery profile. |
| Milestone 3: Brood | depended upon by | Milestone 3 owns cleanup of the worktree, branch, and container lifecycle artifacts produced by Feature 2. Milestone 1 leaves stopped containers and worktrees in place for Feature 5 extraction; Brood later manages their disposal. |
