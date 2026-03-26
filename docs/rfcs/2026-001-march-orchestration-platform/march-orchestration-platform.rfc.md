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

## Goals

- **Safe parallel execution**: Dispatch work to sandboxed AI sessions that cannot cause damage beyond their designated scope, with sandbox integrity treated as an existential requirement.
- **Model-agnostic orchestration**: Support multiple AI backends (Gemini for headless spawns, Claude Code for interactive sessions, others as needed) through a common interface.
- **Deterministic coordination**: Build the event bus (Herald), session management (Brood), and profile configuration (Hatchery) as functional, non-LLM systems — reliable infrastructure, not vibed behavior.
- **Incremental capability delivery**: Each milestone produces a usable component, with smithy-style skills deployed alongside to provide a pseudo-legate until the full orchestrator exists.
- **Observable and attachable**: All sessions run in tmux containers that the operator can SSH into and attach to directly.

## Proposal

March consists of five major components, delivered incrementally:

**Spawn** — The disposable, one-shot sandboxed executor. A spawn is a pure function: one input (the prompt and snapshotted context), one output (the result). It runs a headless AI session (initially Gemini) inside a Docker container with no outbound network access and no ability to write to disk outside the sandbox. The LLM must terminate before output extraction occurs — there is no concurrent access to results while the agent is running. A deterministic extraction process retrieves the output only after the spawn has fully stopped.

**Hatchery** — The session profile manager. A non-LLM functional system that configures sandbox profiles: what base image to use, what files to mount, what tools are available, what permissions are granted. Profiles are declarative and version-controlled.

**Brood** — The session lifecycle manager. A non-LLM functional system that interacts with the Hatchery to spin up, track, and tear down spawn sessions. Provides the operator with visibility into what's running, what's completed, and what needs attention.

**Herald** — The event bus. A deterministic, non-LLM system that routes events (spawn completion, errors, escalations, status changes) between components. First-class clients are built from the outset rather than relying on message-passing heuristics.

**Legate** — The intelligent orchestrator. An LLM-powered interactive shell that owns the full March workflow — planning, dispatch, monitoring, escalation, and integration. Leverages an LLM (likely Claude Code) for reasoning. Much of its behavior is prototyped incrementally via smithy-style skills deployed with each preceding milestone.

**March CLI** — Scaffolded from the start, following the SmithyCLI pattern. `march init` bootstraps the working environment, deploying skills and prompts co-incident with each completed milestone. The CLI serves as both the deployment mechanism and the user's primary interface until Legate is fully realized.

## Design Considerations

- **Sandbox integrity is the highest priority.** A spawn is an isolated pure function: one input, one output, no side effects. Spawns run in Docker containers with no outbound network access and no write access outside the sandbox. The only data entering is the prompt and a snapshotted context; the only data leaving is the extracted result. The LLM must fully terminate before output extraction begins — there is no window where the agent and the extraction process access the sandbox concurrently. If this isolation model is compromised, running an LLM in yolo mode is catastrophically unsafe.
- **Deterministic systems where possible.** Herald, Hatchery, and Brood are explicitly not LLM-powered. They are functional programs with predictable behavior. This reduces the surface area of non-deterministic decisions to Spawn (execution) and Legate (orchestration).
- **tmux as the session substrate.** Building on patterns from agent-deck, sessions live in tmux, giving the operator the ability to SSH in and attach directly. Docker provides the isolation layer; tmux provides the observability and interactivity layer.
- **Output extraction over network access.** Spawns never initiate outbound communication. Output is written to a designated location within the sandbox, and extraction occurs only after the LLM process has terminated. This is a sequential, non-concurrent handoff: run → stop → extract. The spawn cannot influence the extraction process because it is no longer running when extraction begins.
- **SmithyCLI as the template for CLI and skill delivery.** The single-source, multi-agent template pattern from SmithyCLI (one markdown file deployed to agent-specific locations) carries forward. Each milestone ships skills that cover interactions with newly built components, accumulating into Legate's eventual behavior. The `march init` command bootstraps the environment, mirroring the `smithy init` model.
- **Code review via GitHub.** Spawns produce patches or branches. Integration tooling (part of Brood or a dedicated component) takes spawn output and creates PRs or applies patches so the operator can review through standard GitHub workflows. Spawns do not get outside internet access, so this integration is handled by the deterministic infrastructure layer.
- **Persistent state via Docker and tmux.** Running sessions in Docker containers and tmux sessions provides natural durability. State persists across interactions without requiring a separate persistence layer in the early milestones.

## Open Questions

- **Naming**: `march` vs `the-march` for the CLI binary and package name.
- **Spawn output schema**: The output is structured JSON, which may include a git patch as a payload field. This gives Herald a consistent format to consume regardless of content. The exact schema (required fields, optional payload types, metadata) needs to be defined.
- **Hatchery profile schema**: Profiles lean heavily on opinionated defaults. `march init` materializes those defaults as editable files so the operator can see exactly what they're getting and adjust as needed. The exact schema (file format, field structure, override mechanics) needs to be defined.
- **Herald protocol**: What event format and transport does the Herald use? File-based events, Unix sockets, or something else within the Docker/tmux environment?
- **Multi-backend spawn interface**: What is the common abstraction that lets a spawn be backed by Gemini, Claude Code, or Codex without the rest of the system caring?

## Milestones

### Milestone 1: Spawn

**Description**: Build the ability to dispatch a prompt to a sandboxed headless AI session and retrieve the response. This is the first usable component — a human can send work to an isolated executor and get output back safely.

**Success Criteria**:
- A prompt and snapshotted context can be dispatched to a headless AI session running inside a Docker container with no outbound internet access and no write access outside the sandbox.
- The spawn writes its output as structured JSON (which may include a git patch as a payload field) to a designated location within the sandbox.
- The LLM process fully terminates before output extraction begins — no concurrent access.
- A deterministic extraction process retrieves the output from the stopped container.
- The operator can verify that the spawn had no network access and no disk access beyond the sandbox.
- March CLI is scaffolded with `march init` deploying initial skills for spawn interaction.

### Milestone 2: Hatchery

**Description**: Build the session profile configuration system. The Hatchery is a non-LLM functional system that manages declarative sandbox profiles — base images, mounted files, available tools, and permissions.

**Success Criteria**:
- Sandbox profiles can be defined declaratively and version-controlled.
- Profiles specify base image, file mounts, tool availability, and permission boundaries.
- Spawn (Milestone 1) consumes Hatchery profiles to configure its containers.
- Profiles can be listed, inspected, and validated via the March CLI.
- Skills updated to cover Hatchery interactions.

### Milestone 3: Brood (Basic)

**Description**: Build the session lifecycle manager. The Brood is a non-LLM functional system that interacts with the Hatchery to spin up, track, and tear down spawn sessions, giving the operator visibility into all active and completed work.

**Success Criteria**:
- Multiple spawn sessions can be launched and tracked concurrently.
- Session status (running, completed, failed, needs-attention) is visible via the March CLI.
- The operator can SSH into the host and attach to any active session via tmux.
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
- Integration tooling can take spawn output and create GitHub PRs or apply patches for code review.

### Milestone 5: Legate

**Description**: Build the intelligent orchestrator. The Legate is an LLM-powered interactive shell that owns the full March workflow — planning, dispatch, monitoring, escalation, and integration. It absorbs and extends the pseudo-legate skills accumulated across prior milestones.

**Success Criteria**:
- The Legate can accept a goal and break it into dispatchable work.
- It monitors the Brood and Herald to track progress and surface issues.
- It escalates decisions to the operator when intervention is needed.
- It can coordinate multi-step workflows (plan → dispatch → review → integrate).
- The accumulated smithy-style skills are integrated as core Legate capabilities.
