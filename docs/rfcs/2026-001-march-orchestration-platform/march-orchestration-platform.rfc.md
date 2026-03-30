# RFC: March — Coordinated AI Development Control Plane

**Created**: 2026-03-26  |  **Status**: Draft

## Summary

March is a standalone system for planning, orchestrating, and safely executing parallel AI-assisted software work across a coordinated brood of specialized sessions. It separates concerns into distinct roles — sandboxed executors (Spawn), session configuration (Hatchery), session management (Brood), event coordination (Herald), and intelligent orchestration (Legate) — so that a solo technical operator can dispatch, monitor, and integrate work from multiple AI backends without manually juggling terminals, worktrees, and review loops.

## Motivation / Problem Statement

Modern AI-assisted development breaks down as complexity and parallelism increase. A single chat session can help with ideation or implementation, but building real systems requires many kinds of concurrent work: planning architecture, dispatching implementation tasks, monitoring progress, handling approvals, constraining execution, and integrating results.

Today, these workflows are fragmented. The human operator is forced to manually coordinate multiple terminals, worktrees, sandbox environments, agents, and review loops. This creates:

1. **Approval fatigue** — the human becomes a bottleneck, repeatedly approving commands or babysitting execution.
2. **Poor parallel coordination** — multiple agents can work at once, but there is no clean system for dispatch, tracking, and reconciliation.
3. **Weak separation of concerns** — planning, orchestration, execution, and event handling are mixed together in fragile ways.
4. **Unsafe execution by default** — implementation agents frequently have broader access than they need, increasing the blast radius of bad decisions.
5. **Tooling mismatch** — the best tools for interacting with agents are often bad for code review, while traditional editors do not manage swarms.

The core problem is not "how do we use AI to write code" but **how do we make a coordinated system of AI workers usable, safe, observable, and efficient enough to be trusted for serious development work.**

Not solving this means AI-assisted development remains limited to single-session, single-task interactions — leaving the economic potential of parallel AI work unrealized.

## Personas

**The Operator** — A solo technical operator who is hands-on with code and wants to scale their own output using AI workers. Comfortable with CLI tooling, git workflows, Docker, and SSH. Currently managing the chaos of multiple terminals, worktrees, agents, and approval loops manually. March exists to give this person a system instead of a pile of tools.

The initial operator is the author. Making March usable for other solo technical operators is a secondary goal that follows naturally once the system works for the first user. Multi-user and team collaboration are not in scope.

## Goals

- **Safe parallel execution**: Dispatch work to sandboxed AI sessions that cannot cause damage beyond their designated scope, with sandbox integrity treated as an existential requirement.
- **Model-agnostic orchestration**: Support multiple AI backends (Gemini for headless spawns, Claude Code for interactive sessions, others as needed) through a common interface.
- **Deterministic coordination**: Build the event bus (Herald), session management (Brood), and profile configuration (Hatchery) as functional, non-LLM systems — reliable infrastructure, not vibed behavior.
- **Incremental capability delivery**: Each milestone produces a usable component, with smithy-style skills deployed alongside to provide a pseudo-legate until the full orchestrator exists.
- **Observable and attachable**: Interactive components (Legate, future session types) run in tmux sessions that the operator can SSH into and attach to directly. Spawns are headless and non-interactable but their status and output are observable via the March CLI.

## Out of Scope

The following are explicitly not part of this RFC:

- **Multi-user / team collaboration** — March is for a solo operator. Shared workspaces, role-based access, and multi-tenant concerns are not addressed.
- **Web UI** — March is CLI/TUI-first. A browser-based interface is not planned.
- **Plugin / extension system** — Third-party extensibility is not a goal. The system is opinionated and internally composable, not a platform for others to extend.
- **Automated CI/CD integration** — March produces PRs for code review. What happens after merge (CI pipelines, deployment) is outside March's scope.
- **Local / self-hosted LLM backends** — While theoretically compatible, March does not target Ollama or similar local inference as a backend. The starting point is cloud-hosted headless Gemini.

## Proposal

March consists of five major components, delivered incrementally:

**Spawn** — The disposable, one-shot sandboxed executor. A spawn is a pure function: one input (a finalized prompt and a snapshotted worktree), one output (a structured JSON result). Each spawn gets its own git worktree and associated branch, which is then snapshotted into a Docker container — the container holds a copy, not a mount, so the LLM agent cannot modify the host. The worktree-per-spawn model also ensures no branch race conditions between concurrent spawns and provides a ready-made location to apply the resulting patch for code review. The container has no outbound network access and no ability to write to disk outside the sandbox. The LLM must terminate before output extraction occurs — there is no concurrent access to results while the agent is running. A deterministic extraction process retrieves the JSON output only after the spawn has fully stopped. The multi-backend interface is prompt in, structured JSON out — backends differ only in completion signaling, and the rest of the system never needs to know which backend ran.

**Hatchery** — The container profile manager. A non-LLM functional system that configures profiles for any containerized March component — not just spawns. Profiles define base image, file mounts, available tools, permissions, and security posture. Different roles get different security profiles: a spawn runs fully sandboxed with no approvals needed; a PR-management agent might have GitHub access but limited filesystem scope; Legate, Brood, and Herald may also deploy in Docker containers with their own profiles. Profiles are declarative, version-controlled, and initialized with opinionated defaults that `march init` materializes as editable files.

**Brood** — The session lifecycle manager. A non-LLM functional system that interacts with the Hatchery to spin up, track, and tear down spawn sessions. Provides the operator with visibility into what's running, what's completed, and what needs attention.

**Herald** — The event bus. A deterministic, non-LLM system that routes events (spawn completion, errors, escalations, status changes) between components. Consumes the structured JSON output format produced by spawns. First-class clients are built from the outset rather than relying on message-passing heuristics.

**Legate** — The intelligent orchestrator. An LLM-powered interactive shell that owns the full March workflow — planning, dispatch, monitoring, escalation, and integration. Leverages an LLM (likely Claude Code) for reasoning. Much of its behavior is prototyped incrementally via smithy-style skills deployed with each preceding milestone.

**March CLI** — Scaffolded from the start, following the SmithyCLI pattern. `march init` bootstraps the working environment, deploying skills and prompts co-incident with each completed milestone. The CLI serves as both the deployment mechanism and the user's primary interface until Legate is fully realized.

## Design Considerations

- **Sandbox integrity is the highest priority.** A spawn is an isolated pure function: one input, one output, no side effects. Spawns run in Docker containers with no outbound network access and no write access outside the sandbox. The only data entering is the finalized prompt and a snapshot of a git worktree (copied into the container, not mounted); the only data leaving is the extracted result. The LLM must fully terminate before output extraction begins — there is no window where the agent and the extraction process access the sandbox concurrently. If this isolation model is compromised, running an LLM in yolo mode is catastrophically unsafe. See **Appendix A: Spawn Sandbox Threat Model** for the enumerated attack surface.
- **Worktree-per-spawn isolation.** Each spawn gets its own git worktree and dedicated branch. The worktree is snapshotted into the Docker container so the LLM cannot modify the host filesystem. When a result comes back, the worktree provides a ready-made location to apply the patch and trigger code review. This also eliminates branch race conditions — concurrent spawns never compete for the same branch.
- **Worktree lifecycle.** A worktree is created for the spawn, lives through the PR → review → merge cycle (potentially handed off to a human-interactable session to close the loop), and is disposed of by the Brood along with the associated branch and sandbox container. Brood owns cleanup of the full spawn lifecycle: worktree, branch, and container.
- **Deterministic systems where possible.** Herald, Hatchery, and Brood are explicitly not LLM-powered. They are functional programs with predictable behavior. This reduces the surface area of non-deterministic decisions to Spawn (execution) and Legate (orchestration).
- **tmux for interactive components, not spawns.** Spawns are headless and non-interactable — they run as pure Docker containers with no tmux session. tmux is the substrate for interactive components (Legate, and potentially future session types) where the operator needs to SSH in and attach directly. Building on patterns from agent-deck, tmux provides the observability and interactivity layer for components that benefit from it.
- **Output extraction over network access.** Spawns never initiate outbound communication. Output is written to a designated location within the sandbox, and extraction occurs only after the LLM process has terminated. This is a sequential, non-concurrent handoff: run → stop → extract. The spawn cannot influence the extraction process because it is no longer running when extraction begins.
- **SmithyCLI as the template for CLI and skill delivery.** The single-source, multi-agent template pattern from SmithyCLI (one markdown file deployed to agent-specific locations) carries forward. Each milestone ships skills that cover interactions with newly built components, accumulating into Legate's eventual behavior. The `march init` command bootstraps the environment, mirroring the `smithy init` model.
- **Code review via GitHub.** Spawns produce patches or branches. Integration tooling (part of Brood or a dedicated component) takes spawn output and creates PRs or applies patches so the operator can review through standard GitHub workflows. Spawns do not get outside internet access, so this integration is handled by the deterministic infrastructure layer.
- **Persistent state via Docker and tmux.** Running sessions in Docker containers and tmux sessions provides natural durability. State persists across interactions without requiring a separate persistence layer in the early milestones.

## Decisions

- **Spawn output format**: Structured JSON envelope, which may include a git patch as a payload field. This gives Herald a consistent format to consume regardless of content. The exact schema (required fields, optional payload types, metadata) will be defined during Milestone 1 specification.
- **Hatchery profile approach**: Profiles lean heavily on opinionated defaults. `march init` materializes those defaults as editable files so the operator can see exactly what they're getting and adjust as needed. The exact schema (file format, field structure, override mechanics) will be defined during Milestone 2 specification.
- **Multi-backend spawn interface**: The common abstraction is prompt in, structured JSON out. Backends differ only in completion signaling: Gemini and Codex use native headless mode with completion hooks that grab the patch and response; Claude uses prompt augmentation instructing it to write output to a designated location when finished, with external detection of completion. The rest of the system (Brood, Herald) sees only a stopped container with a JSON file at a known location — it never needs to know which backend ran.

## Open Questions

- **Naming**: `march` vs `the-march` for the CLI binary and package name.
- **Herald protocol**: What event format and transport does the Herald use? File-based events, Unix sockets, or something else within the Docker/tmux environment?

## Milestones

### Milestone 1: Spawn

**Description**: Build the end-to-end spawn loop and the March CLI that drives it. This is the first usable component — a human can send work to an isolated executor and get a reviewable PR back. The CLI is the primary interface and is a first-class deliverable, not scaffolding. Container configuration is hardcoded/minimal in this milestone — Hatchery (Milestone 2) will later formalize it into declarative, editable profiles.

**Success Criteria**:
- The March CLI is built with `march init` bootstrapping the working environment (deploying skills and prompts for spawn interaction, following the SmithyCLI pattern).
- The CLI can dispatch a spawn: create a git worktree and dedicated branch, snapshot (copy, not mount) the worktree into a Docker container with no outbound internet access and no write access outside the sandbox, and pass a finalized prompt to a headless AI session.
- The spawn writes its output as structured JSON (which may include a git patch as a payload field) to a designated location within the sandbox.
- The LLM process fully terminates before output extraction begins — no concurrent access.
- A deterministic extraction process retrieves the output from the stopped container.
- The operator can verify that the spawn had no network access and no disk access beyond the sandbox.
- The known attack surfaces enumerated in Appendix A have been evaluated and mitigated.
- The CLI completes the loop: applies the extracted patch to the spawn's worktree and branch, pushes, and creates a GitHub PR for code review. Full loop: prompt in → sandbox execution → patch out → reviewable PR.

### Milestone 2: Hatchery

**Description**: Build the container profile configuration system. The Hatchery is a non-LLM functional system that manages declarative profiles for any containerized March component. Different roles require different security postures — from fully sandboxed spawns to more permissioned agents that handle PR management or orchestration. The Hatchery formalizes the hardcoded container configuration from Milestone 1 into a general-purpose, editable profile system.

**Success Criteria**:
- Container profiles can be defined declaratively and version-controlled.
- Profiles specify base image, file mounts, tool availability, network access, and security posture.
- Multiple security profiles can coexist (e.g., fully sandboxed spawn vs. a more permissioned PR-management agent).
- Spawn (Milestone 1) consumes Hatchery profiles to configure its containers, replacing the hardcoded configuration.
- Profiles can be listed, inspected, and validated via the March CLI.
- Skills updated to cover Hatchery interactions.

### Milestone 3: Brood (Basic)

**Description**: Build the session lifecycle manager. The Brood is a non-LLM functional system that interacts with the Hatchery to spin up, track, and tear down spawn sessions, giving the operator visibility into all active and completed work.

**Success Criteria**:
- Multiple spawn sessions can be launched and tracked concurrently.
- Session status (running, completed, failed, needs-attention) is visible via the March CLI.
- The operator can SSH into the host and attach to interactive sessions (e.g., Legate) via tmux. Spawn sessions are headless and observable via CLI only.
- Sessions can be torn down cleanly, with output preserved.
- Skills updated to cover Brood management. The accumulated skill set forms a functional pseudo-legate.
- **MVP complete**: the system is usable for dispatching, configuring, and managing parallel sandboxed AI work.

### Milestone 4: Herald

**Description**: Build the deterministic event bus. The Herald is a non-LLM functional system that routes events between components, enabling coordination without requiring direct component-to-component communication.

**Success Criteria**:
- Events (spawn completion, errors, status changes) are published and routed through the Herald.
- First-class Herald clients are available for Spawn, Hatchery, and Brood.
- The operator can observe the event stream via the March CLI.
- Components react to events without polling or direct coupling.

### Milestone 5: Legate

**Description**: Build the intelligent orchestrator. The Legate is an LLM-powered interactive shell that owns the full March workflow — planning, dispatch, monitoring, escalation, and integration. It absorbs and extends the pseudo-legate skills accumulated across prior milestones.

**Success Criteria**:
- The Legate can accept a goal and break it into dispatchable work.
- It monitors the Brood and Herald to track progress and surface issues.
- It escalates decisions to the operator when intervention is needed.
- It can coordinate multi-step workflows (plan → dispatch → review → integrate).
- The accumulated smithy-style skills are integrated as core Legate capabilities.

---

## Appendix A: Spawn Sandbox Threat Model

The spawn sandbox is the single most critical security boundary in March. An LLM running in yolo mode with a compromised sandbox can cause arbitrary damage. This appendix enumerates the known attack surfaces that Milestone 1 must evaluate and mitigate.

### A1. Container Escape

**Threat**: The LLM exploits a Docker runtime vulnerability to break out of the container and access the host.

**Mitigations to evaluate**:
- Run containers with minimal capabilities (`--cap-drop=ALL`).
- Use a non-root user inside the container.
- Consider a secondary isolation layer (e.g., gVisor, rootless Docker) if the threat model warrants it.
- Keep the Docker runtime patched and up to date.

### A2. Volume Mount Misconfiguration

**Threat**: A misconfigured bind mount exposes host filesystem paths to the container, giving the LLM read or write access to host files.

**Mitigations to evaluate**:
- Spawns use a snapshot (copy), not a mount. Enforce this at the container creation layer — no bind mounts to host paths.
- Validate container configuration at launch time to reject any bind mounts.
- The Hatchery profile schema should make it structurally difficult to accidentally introduce a bind mount.

### A3. Environment Variable Leakage

**Threat**: Environment variables passed to the container expose secrets (API keys, tokens, host configuration) to the LLM.

**Mitigations to evaluate**:
- Explicitly whitelist environment variables passed to spawn containers. Default to passing nothing.
- The LLM API key is a special case (see A7). No other secrets should enter the container.
- Audit the container environment at launch time and log what was passed.

### A4. DNS and Network Information Leakage

**Threat**: Even with no outbound internet access, DNS queries can leak information about the host environment or be used as a covert data exfiltration channel.

**Mitigations to evaluate**:
- Use `--network=none` on spawn containers to disable all networking, including DNS.
- If the LLM backend requires network access to reach an API (see A7), use a firewall or proxy that restricts traffic to a single allowed endpoint with no DNS resolution (IP-only).

### A5. Snapshotted Context Contains Secrets

**Threat**: The git worktree snapshot copied into the container includes files containing credentials, API keys, `.env` files, or other secrets that the LLM can read and potentially embed in its output.

**Mitigations to evaluate**:
- Apply a configurable exclusion list when snapshotting the worktree (e.g., strip `.env`, `.secrets`, credential files).
- Respect `.gitignore` patterns during snapshot creation — if a file is not tracked, it should not be snapshotted.
- Consider scanning the snapshot for known secret patterns before container launch.
- The Hatchery profile should define what gets included in the snapshot, not just what gets excluded.

### A6. Output Manipulation

**Threat**: The LLM crafts its structured JSON output to exploit the extraction process — for example, including shell injection payloads in patch content, malformed JSON designed to crash the extractor, or patch content that modifies files outside the intended scope.

**Mitigations to evaluate**:
- The extraction process must treat all spawn output as untrusted input.
- Validate JSON structure before processing.
- Validate that git patches only touch files within the expected scope.
- Apply patches in the worktree (an isolated branch) — never directly to main or shared branches.
- The sequential handoff (LLM stopped before extraction) eliminates the risk of the LLM observing or interfering with extraction, but the output itself remains adversarial input.

### A7. LLM API Key and Network Access

**Threat**: The spawn needs an LLM API key and network access to its LLM backend in order to do work. That key is inside the sandbox. If the sandbox has network access, the LLM could exfiltrate the key or use it for unintended purposes.

**Reality**: A spawn cannot function without reaching its LLM server. The initial backend is headless Gemini, and the sandbox must have the minimum network access required for headless Gemini to operate. A fully local LLM (e.g., Ollama) would not need this, but that is not the starting point.

**Mitigations to evaluate**:
- Grant the minimum network access headless Gemini requires — restrict outbound traffic via firewall rules to only the specific endpoints Gemini needs (IP-based, not DNS-based where possible).
- Block all other outbound traffic. The spawn should not be able to reach arbitrary internet hosts.
- The API key should be rotatable and usage-monitored. Consider per-spawn ephemeral keys if the backend supports it.
- As additional backends are added, each backend's minimum network requirements should be documented and enforced individually in the Hatchery profile.
- A host-side proxy approach (piping LLM traffic through a controlled proxy that the container reaches via a local socket) remains a future option to further reduce exposure, but is not required for Milestone 1.

### A8. Resource Exhaustion

**Threat**: The LLM agent consumes excessive CPU, memory, disk, or time — either through runaway behavior or deliberately, as a denial-of-service against the host.

**Mitigations to evaluate**:
- Set container resource limits (CPU, memory, disk quota) via Docker.
- Enforce a maximum execution time per spawn. Kill the container if it exceeds the limit.
- Monitor resource consumption and surface it in spawn status reporting.

---

## Appendix B: Gemini CLI Headless Mode Validation

The RFC assumes headless Gemini as the initial spawn backend. This appendix documents the capabilities that support this choice, based on Gemini CLI's current feature set.

### B1. Headless Dispatch

Gemini CLI supports non-interactive execution via the `--prompt` (or `-p`) flag:

```bash
gemini --prompt "Your task here" --approval-mode=yolo --output-format json
```

Headless mode activates automatically when:
- The `--prompt` flag is provided
- Running in a non-TTY environment (e.g., Docker, piped input)
- Input is piped via stdin

The `--approval-mode=yolo` flag auto-approves all tool executions, eliminating interactive prompts — this is exactly the execution model spawns need.

### B2. Completion Signaling

Gemini CLI blocks until completion and exits with standard exit codes:

| Exit Code | Meaning |
|-----------|---------|
| `0` | Successful execution |
| `1` | General error or API failure |
| `42` | Invalid input |
| `53` | Turn limit exceeded |

No polling or completion hooks are needed — the process exits when done. This maps cleanly to the spawn model: launch container → process exits → extract output.

### B3. Structured Output

Three output formats are supported:

- **`text`** (default) — human-readable response on stdout
- **`json`** — single JSON object with response and stats:
  ```json
  {
    "response": "...",
    "stats": { "inputTokens": 1234, "outputTokens": 5678, "latencyMs": 1200 }
  }
  ```
- **`stream-json`** — newline-delimited JSON events (`init`, `message`, `tool_use`, `tool_result`, `error`, `result`)

The `json` format provides a natural foundation for the spawn output envelope. The spawn's prompt augmentation can instruct Gemini to include the git patch in its response, which the extraction process wraps into the structured JSON schema.

### B4. Docker Sandbox Support

Gemini CLI has native Docker sandbox support:

```bash
gemini --prompt "task" --sandbox=docker --approval-mode=yolo --output-format json
```

Additional sandbox options: `podman`, `runsc` (gVisor), `lxc`. Custom Dockerfiles can be placed at `.gemini/sandbox.Dockerfile`. Container resource limits can be set via the `SANDBOX_FLAGS` environment variable:

```bash
SANDBOX_FLAGS="--cpus=2 --memory=4g" gemini --prompt "task" --sandbox=docker
```

### B5. Spawn Integration Model

The validated workflow for a Gemini-backed spawn:

1. Create worktree and branch.
2. Snapshot worktree into a Docker container.
3. Inside the container, run:
   ```bash
   gemini --prompt "<finalized prompt>" \
     --output-format json \
     --approval-mode=yolo \
     --sandbox=docker
   ```
4. Process exits (exit code 0 = success).
5. Extract JSON output from stdout capture or designated file.
6. Parse response, extract patch, apply to worktree, push, create PR.

### B6. Known Limitations

- **Timeout handling**: Past versions have had issues with MCP timeout enforcement (60s) and API defaults (5 min). Spawns should enforce their own external timeout via container kill.
- **Double sandboxing**: Gemini's `--sandbox=docker` runs Docker-in-Docker. For spawns already running inside a Docker container, it may be simpler to omit Gemini's sandbox flag and rely on the outer container's isolation. This needs validation during Milestone 1.
- **API key requirement**: `GEMINI_API_KEY` must be set in the container environment (see Appendix A, section A7 for security implications).

### B7. Validation Status

| Capability | Required | Supported | Notes |
|-----------|----------|-----------|-------|
| Headless dispatch | Yes | Yes | `--prompt` flag |
| Auto-approve all actions | Yes | Yes | `--approval-mode=yolo` |
| Structured JSON output | Yes | Yes | `--output-format json` |
| Exit code on completion | Yes | Yes | Standard codes (0, 1, 42, 53) |
| Docker execution | Yes | Yes | Native `--sandbox=docker` |
| Resource limits | Yes | Yes | Via `SANDBOX_FLAGS` |
| No interactive prompts | Yes | Yes | Automatic in non-TTY |

**Conclusion**: Gemini CLI's headless mode validates the spawn backend assumptions in this RFC. No blocking gaps have been identified. The double-sandboxing question (B6) is the primary item to resolve during early Milestone 1 implementation.
