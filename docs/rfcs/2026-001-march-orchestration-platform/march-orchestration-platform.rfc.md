# RFC: March — Coordinated AI Development Control Plane

**Created**: 2026-03-26  |  **Status**: Amended 2026-05-16

> **Status note (2026-05-16)** — Implementation has jumped ahead of the milestone plan during bootstrap testing. Pieces of Legate (a deterministic `legate-loop` processor and a Claude-backed `legate-agent`), a spawn → **steward** handoff, the Codex backend, and a Legate container under Hatchery have been built provisionally. See [Accelerated Work & Reordering](#accelerated-work--reordering-2026-05) for the current shape of the system, and per-milestone status labels in [Milestones](#milestones). Status labels used throughout this RFC:
>
> - **Done (realized)** — concept fully implemented as described
> - **Done (provisional)** — works in practice but vibe-coded during bootstrap; needs hardening or replacement by a planned successor
> - **Partial** — some pieces shipped, gaps remain
> - **Not started** — no implementation yet

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
- **Model-agnostic orchestration**: Support multiple AI backends through a common interface. Claude Code CLI and Codex CLI are the two supported spawn backends (see Appendices B and C; Gemini was dropped 2026-05-16 — see [Accelerated Work & Reordering](#accelerated-work--reordering-2026-05)). The operator selects per-spawn based on capability needs, cost model, or preference. Interactive components (Legate, Steward) use any backend that supports conversational interaction.
- **Deterministic coordination**: Build the system-state observation service (Herald), session management (Brood), and profile configuration (Hatchery) as functional, non-LLM systems — reliable infrastructure, not vibed behavior.
- **Incremental capability delivery**: Each milestone produces a usable component, with smithy-style skills deployed alongside to provide a pseudo-legate until the full orchestrator exists.
- **Observable and attachable**: Interactive components (Legate, future session types) run in tmux sessions that the operator can SSH into and attach to directly. Spawns are headless and non-interactable but their status and output are observable via the March CLI.

## Operating Philosophy

March is the execution counterpart to Smithy's planning loop. Together they form a complete idea-to-merged-code pipeline whose central goal is **high-quality output with minimum operator intervention at the points where intervention does not add value**.

> The canonical statements of this philosophy live outside this RFC, in two long-lived repo-level documents:
>
> - [`docs/vision.md`](../../vision.md) — the high-level "what and why" of March (ideas in, quality out; Smithy decomposes, March executes). Stable; rarely revised. Carries the operator-facing promise and the day-in-the-life narrative.
> - [`docs/operating-philosophy.md`](../../operating-philosophy.md) — the implementation-level "how": per-component intervention-avoidance table and the three rules of thumb (no interactive surfaces in autonomous components; minimum required access; failures are clean exits). Living; expected to evolve as we learn.
>
> This RFC section is a stable summary anchored to those two docs. If the docs and this section drift, the docs win — the RFC's job is to make architectural decisions for this milestone series; the docs' job is to anchor *why* those decisions are shaped the way they are across milestone series.

### Smithy decomposes; March executes

Smithy turns a vague idea into a mergeable change set through a cyclical expand-then-segment process:

```
idea → PRD → RFC → feature maps → specs → tasks → finished code
   └─ expand ──┘└─ expand ─┘└─ expand ─┘└─ expand ──┘
        └─ group/segment ─┘└─ group/segment ─┘└─ group/segment ─┘
```

Each step expands the prior artifact (more detail, more concrete questions answered), then groups and segments the result into the next layer's discrete units. Lots of touch points by design — every cycle is a chance to catch ambiguity, surface debt, and produce something a reader can act on without re-deriving the prior cycle. The output is high-quality, but the *artifact lineage itself is high-touch*: each artifact needs review, each segmentation is a decision.

March exists to take Smithy's output — a fully decomposed plan, down to actionable task slices — and execute it across a coordinated system **without making the operator the constant point of intervention**. Smithy is high-touch by design; March is low-touch by design. The combination is what makes the pipeline economically viable for a solo operator.

### Per-component intervention-avoidance

Every March component eliminates operator intervention at a specific layer of execution:

| Component | The intervention it eliminates |
|-----------|-------------------------------|
| **Spawn** | Intervention in *execution of individual steps*. The operator does not babysit a session, approve commands, or watch progress — the spawn runs to completion (or to a clean failure) and emits a structured result. |
| **Hatchery** | Intervention in *setting up to run the steps*. The operator does not assemble container args, juggle credentials, or hand-tune security posture per session — profiles declare the configuration once and every spawn / steward / legate / future role consumes the same declarative source. |
| **Brood** | Intervention in *cleanup and lifecycle*. The operator does not manually remove containers, prune worktrees, archive logs, or reconcile orphaned branches — Brood owns the full cradle-to-grave path for every containerized session. |
| **Herald** | Intervention in *checking whether anything is ready yet*. The operator does not refresh `gh pr view`, poll `smithy status`, or context-switch to ask "is it done? is it done? what do I need to do next?" — Herald watches deterministic state (PRs, sessions, queues) and fires events on transitions so the next consumer reacts without the operator looking. |
| **Legate** | Intervention in *managing parts of the system*. The operator does not pick what to run next, monitor for stalls across many parallel work items, or decide when to retry vs. escalate — Legate runs the orchestration loop and only surfaces decisions that genuinely require operator judgment. |
| **Steward** | Intervention in *assembling and submitting the work*. The operator does not take the patch the spawn produced, apply it, run tests, commit, push, and open the PR — the Steward session does that and only escalates if something is genuinely ambiguous (merge conflict, failing test that needs judgment). |

The **March CLI** is the operator's *deliberate* intervention surface. When the operator does want to step in — to dispatch an ad-hoc spawn, inspect a stuck session, or override a decision — there are clear verbs to do so. The default path is autonomous; the intervention path is one command away.

### What this means for individual feature design

Three rules of thumb that fall out of the philosophy and should be applied across every spec, every feature map:

1. **No interactive surfaces inside an autonomous component.** No permission prompts reaching the spawn, no approval requests waiting on the operator inside a brood teardown, no questions the herald asks before routing an event. If a component genuinely needs operator judgment, it raises an escalation (via Herald / via SpawnRecord state) — it does not block.
2. **Minimum required access, not zero access.** Sandboxes start tight (F2's `bridge` network, F2's snapshot-only filesystem) and peel back deliberately as real backends require it (F4's per-backend egress allowlist, the accelerated `BackendCredentialMountSpec` for Codex). Every peel-back is declared on the component's interface (not operator-authored), so the structural enforcement holds even as the access surface grows.
3. **Failures are clean exits, not hangs.** Auto-mode and auto-review (in Claude Code, Codex, etc.) are powerful but imperfect — sessions occasionally stall, and alignment validation costs tokens. The sandbox cannot prevent stalls but it must prevent stalls from becoming hangs: timeouts kill the container, pre-flights fail fast before any artifact is created, herald events fire on transitions to terminal states. The operator should walk away and come back to *something* — either a green PR ready to merge or a SpawnRecord marked failed with a diagnostic. Never a hung session waiting for input it cannot receive.

These rules are referenced explicitly from feature specs (e.g., F4's [Design philosophy](../../specs/2026-05-12-004-spawn-sandbox-security/spawn-sandbox-security.spec.md#design-philosophy-2026-05-16) section) and apply wherever a March component is making the operator/automation trade-off.

## Out of Scope

The following are explicitly not part of this RFC:

- **Multi-user / team collaboration** — March is for a solo operator. Shared workspaces, role-based access, and multi-tenant concerns are not addressed.
- **Web UI** — March is CLI/TUI-first. A browser-based interface is not planned.
- **Plugin / extension system** — Third-party extensibility is not a goal. The system is opinionated and internally composable, not a platform for others to extend.
- **Automated CI/CD integration** — March produces PRs for code review. What happens after merge (CI pipelines, deployment) is outside March's scope.
- **Local / self-hosted LLM backends** — While theoretically compatible, March does not target Ollama or similar local inference as a backend. The supported backends are cloud-hosted Claude Code CLI and Codex CLI (see Appendices B and C).

## Proposal

March consists of the following major components, delivered incrementally.
Since 2026-05 the non-spawn subsystems (Hatchery, Brood, Herald, Castra, and
the legate loop) run as **containerized Fastify HTTP services** rather than
in-process libraries — each has a `march <component> serve` container entrypoint
and thin HTTP clients; consumers reach them over the shared `march` Docker
network. The original "five major components" framing predates that split:

**Spawn** — The disposable, one-shot sandboxed executor. A spawn is a pure function: one input (a finalized prompt and a snapshotted worktree), one output (a structured JSON result). Each spawn gets its own git worktree and associated branch, which is then snapshotted into a Docker container — the container holds a copy, not a mount, so the LLM agent cannot modify the host. The worktree-per-spawn model also ensures no branch race conditions between concurrent spawns and provides a ready-made location to apply the resulting patch for code review. The container has no outbound network access and no ability to write to disk outside the sandbox. The LLM must terminate before output extraction occurs — there is no concurrent access to results while the agent is running. A deterministic extraction process retrieves the JSON output only after the spawn has fully stopped. The multi-backend interface is prompt in, structured JSON out — backends differ only in completion signaling, and the rest of the system never needs to know which backend ran.

**Hatchery** — The container/profile policy authority and spawn-orchestration service. A non-LLM containerized Fastify service (`march hatchery serve`) that runs the spawn flow inside a container; `march hatchery spawn` is a thin HTTP client. It drives the Steward session through the Castra HTTP API (rather than mounting `agent-deck`) and registers each spawn with Brood at launch. It also owns the container-profile policy for any containerized March component — not just spawns. Profiles define base image, file mounts, available tools, permissions, and security posture, and are the single declarative source consumed by every role: a spawn runs fully sandboxed with no approvals needed; the Steward (`pr-management` profile) has GitHub access but limited filesystem scope; Legate, Brood, and Herald run in their own containers with their own profiles. Profiles are declarative, version-controlled, and initialized with opinionated defaults that `march init` materializes as editable files.

**Brood** — The session-state and lifecycle/teardown authority. A non-LLM containerized Fastify service (`march brood serve`) that tracks every spawn / steward / legate in a SQLite registry (`~/.march/brood`) behind a swappable `SessionRepository` interface (sqlite default; a typed `postgres` backend is a not-yet-implemented SaaS extension point selected via `MARCH_BROOD_STORE`). The Hatchery registers spawns with it at launch; the legate loop **requests** teardown via `march brood teardown` rather than pruning anything itself. Brood **owns teardown**: it removes the container, asks Castra to remove the steward, then removes the worktree/branch by **exact tracked path — never a blanket `git worktree prune`** (issue #155). The container + worktree call-outs sit behind a swappable `TeardownSubstrate` adapter (default `hostTeardownSubstrate`, issue #169) so the substrate can be retargeted (host docker socket → orchestrator API; host worktree → ephemeral volume). It also provides the operator with visibility into what's running, what's completed, and what needs attention.

**Herald** — The system-state observation service. A deterministic, non-LLM containerized Fastify service (`march herald serve`) that observes the world each tick (the shared sense I/O in `src/observe/sense-io.ts`: `gh`/`git`/`smithy` + Castra) and records change events into an append-only, seq-ordered **event log** (`node:sqlite` at `~/.march/herald`). The system state is **event-sourced**: current state is the fold of the log (the shared taxonomy + reducer in `src/herald/events.ts`, imported by both Herald and the legate). Herald appends *observation* events; the legate appends *transition* events and drains the inbox via `GET /events?after=<cursor>`. Herald is the single sequencer (it owns every `seq`, including legate `POST /events`), is **read-only by default** (`MARCH_HERALD_SYNC=1` enables the git sync), and never touches Docker. This is the heartbeat + data-collection responsibility calved off the legate loop; it replaces the earlier "event bus" framing.

**Legate** — The intelligent orchestrator. As of 2026-05 Legate is composed of two siblings (see [Accelerated Work & Reordering](#accelerated-work--reordering-2026-05)):

- **`legate-agent`** — the Claude-backed interactive shell originally described in this RFC. Owns planning, escalation, and decisions that need an LLM.
- **`legate-loop`** — a deterministic processor that runs the heartbeat-driven dispatch loop, watches steward sessions (via the Castra API), and reconciles PRs. Non-LLM. It now runs as an SDK-instrumented **container service** with an HTTP API: it drains the Herald inbox via `GET /events?after=<cursor>`, appends *transition* events via `POST /events`, and requests teardown via `march brood teardown`. This is responsibility the RFC originally assigned to M5 Legate; it was pulled forward into M2/M3 so the system could run end-to-end before full Legate landed.

Much of the agent's behavior is still prototyped incrementally via smithy-style skills deployed with each preceding milestone.

**Castra** — The interactive-sessions host. A containerized Fastify service (one shared `march-castra` host on the `march` network) that fronts the single tmux server / `agent-deck` install over a small bearer-token HTTP API. Consumers (the Hatchery, the legate loop) call Castra's API to launch / send-to / output-from / remove interactive sessions instead of shelling out to `agent-deck` or bind-mounting it, so `agent-deck` lives in exactly one place. The Steward and the interactive Legate session are quartered here. See [`docs/Castra.md`](../../Castra.md).

**Steward** — The PR-management role. An interactive `agent-deck` session **hosted in Castra** (launched per spawn via `src/hatchery/spawn-handoff.ts`, which calls the Castra HTTP API) that receives the spawn's extracted patch and drives review, test, commit, push, and PR creation. Runs under the `pr-management` Hatchery profile in auto-mode steered by skills. Named in this RFC 2026-05-16; previously referred to as "manager" in code. Brood owns its teardown (it asks Castra to remove the session — see the Brood entry and backlog).

**March CLI** — Scaffolded from the start, following the SmithyCLI pattern. `march init` bootstraps the working environment, deploying skills and prompts co-incident with each completed milestone. The CLI serves as both the deployment mechanism and the user's primary interface until Legate is fully realized.

## Design Considerations

- **Sandbox integrity is the highest priority.** A spawn is an isolated pure function: one input, one output, no side effects. Spawns run in Docker containers with no outbound network access and no write access outside the sandbox. The only data entering is the finalized prompt and a snapshot of a git worktree (copied into the container, not mounted); the only data leaving is the extracted result. The LLM must fully terminate before output extraction begins — there is no window where the agent and the extraction process access the sandbox concurrently. If this isolation model is compromised, running an LLM in yolo mode is catastrophically unsafe. See **Appendix A: Spawn Sandbox Threat Model** for the enumerated attack surface.
- **Worktree-per-spawn isolation.** Each spawn gets its own git worktree and dedicated branch. The worktree is snapshotted into the Docker container so the LLM cannot modify the host filesystem. When a result comes back, the worktree provides a ready-made location to apply the patch and trigger code review. This also eliminates branch race conditions — concurrent spawns never compete for the same branch.
- **Worktree lifecycle.** A worktree is created for the spawn, lives through the PR → review → merge cycle (handed off to the Steward session in Castra to close the loop), and is disposed of by Brood along with the associated branch and sandbox container. Brood owns cleanup of the full spawn lifecycle and tears down in order — remove the container, ask Castra to remove the steward, then remove the worktree/branch by **exact tracked path (never a blanket `git worktree prune`** — issue #155). The container + worktree call-outs sit behind a `TeardownSubstrate` adapter (default `hostTeardownSubstrate`).
- **Deterministic systems where possible.** Herald, Hatchery, and Brood are explicitly not LLM-powered. They are functional programs with predictable behavior. This reduces the surface area of non-deterministic decisions to Spawn (execution) and Legate (orchestration).
- **tmux for interactive components, not spawns.** Spawns are headless and non-interactable — they run as pure Docker containers with no tmux session. tmux is the substrate for interactive components (Legate, and potentially future session types) where the operator needs to SSH in and attach directly. Building on patterns from agent-deck, tmux provides the observability and interactivity layer for components that benefit from it.
- **Output extraction over network access.** Spawns never initiate outbound communication. Output is written to a designated location within the sandbox, and extraction occurs only after the LLM process has terminated. This is a sequential, non-concurrent handoff: run → stop → extract. The spawn cannot influence the extraction process because it is no longer running when extraction begins.
- **SmithyCLI as the template for CLI and skill delivery.** The single-source, multi-agent template pattern from SmithyCLI (one markdown file deployed to agent-specific locations) carries forward. Each milestone ships skills that cover interactions with newly built components, accumulating into Legate's eventual behavior. The `march init` command bootstraps the environment, mirroring the `smithy init` model.
- **Code review via GitHub.** Spawns produce patches or branches. The **Steward** (an interactive `agent-deck` session hosted in Castra) takes spawn output and applies the patch, runs tests, commits, pushes, and opens the PR so the operator can review through standard GitHub workflows. Spawns do not get outside internet access, so this integration is handled outside the sandbox by the Steward session, which the Hatchery drives via the Castra HTTP API.
- **Persistent state via Docker and tmux.** Running sessions in Docker containers and tmux sessions provides natural durability. State persists across interactions without requiring a separate persistence layer in the early milestones.

## Decisions

- **Spawn output format**: Structured JSON envelope, which may include a git patch as a payload field. This gives Herald a consistent format to consume regardless of content. The exact schema (required fields, optional payload types, metadata) will be defined during Milestone 1 specification.
- **Hatchery profile approach**: Profiles lean heavily on opinionated defaults. `march init` materializes those defaults as editable files so the operator can see exactly what they're getting and adjust as needed. The exact schema (file format, field structure, override mechanics) will be defined during Milestone 2 specification.
- **Multi-backend spawn interface**: The common abstraction is prompt in, structured JSON out. Supported backends (Claude Code CLI, Codex CLI) provide headless execution with process-exit completion signaling. Authentication differs by backend — Claude Code uses env-var (`ANTHROPIC_API_KEY`) or OAuth/session (Claude Max), while Codex uses a **credential-mount** pattern: the host's `CODEX_HOME` is bind-mounted read-only into the container at `/march/codex-auth` and copied into the in-container home at entrypoint time. This makes the `SpawnBackend` contract accommodate both env-var and credential-mount auth shapes. **Gemini** was originally listed here but has been cut (2026-05-16) — Claude + Codex covers the operator's needs and Gemini's env-var-only auth model has no consumer. Appendix B should be read as historical context for the multi-backend contract, not as a live backend commitment.

## Open Questions

- **Naming**: `march` vs `the-march` for the CLI binary and package name.
- ~~**Herald protocol**: What event format and transport does the Herald use?~~ **Resolved (2026-05):** Herald is a containerized Fastify HTTP service backed by a `node:sqlite` append-only, seq-ordered event log; consumers poll `GET /events?after=<cursor>` and append via `POST /events`. Herald is the single sequencer; the event taxonomy + reducer live in `src/herald/events.ts`.

## Accelerated Work & Reordering (2026-05)

Bootstrap testing surfaced enough end-to-end pain that we vibe-coded portions of M2 and M5 ahead of schedule rather than wait for the milestone order. What landed:

- **`legate-loop` processor** (originally M5 Legate scope): a deterministic, heartbeat-driven dispatch loop that reads `smithy status --format json`, launches steward sessions for ready slices, and reconciles their output. Lives in `src/legate/init.ts`. Sibling to the Claude-backed `legate-agent`.
- **Spawn → Steward handoff** (`src/hatchery/spawn-handoff.ts`): completed spawns hand their patch off to the Steward — an interactive `agent-deck` session hosted in Castra (launched via the Castra HTTP API) running under a `pr-management` profile. The steward owns review/test/commit/push/PR. Replaces what the RFC originally implied would be a deterministic CLI script.
- **Legate container under Hatchery** (`src/hatchery/legate-container.ts`): one concrete Hatchery profile shipped — for the Legate container — without the broader declarative profile system.
- **Codex backend** (`src/spawn/backends.ts`): added alongside Claude Code with a credential-mount auth pattern. Gemini was dropped.

What this reordering **defers** (now tracked as Stage B backlog — see [Backlog of follow-on specs](#backlog-of-follow-on-specs-stage-b)):

- Declarative hatchery profile schema + `march hatchery list/inspect/validate` CLI (M2 originally) — spec drafted (`specs/2026-05-12-003-profile-schema-and-validation-library/`).
- ~~Mini-herald daemon~~ **Realized (2026-05):** Herald shipped as the containerized, event-sourced observation service (`march herald serve`), replacing the mini-herald precursor and the "message bus" framing; the legate loop now drains the Herald inbox instead of polling `smithy status` directly. (The file-based `mini-herald` precursor spec has been removed as superseded.)
- ~~Brood CLI surface (M3)~~ **Realized (2026-05):** Brood shipped as the containerized session-state + teardown authority (`march brood serve`, with `march brood teardown` as the request verb). Operator-facing `list/status` verbs are HTTP clients of that service; Brood owns steward and container teardown (via Castra + the `TeardownSubstrate`).
- A7 network policy enforcement — spawn containers still run on the default Docker bridge; the hardened per-spawn network model is specified in `specs/2026-05-12-004-spawn-sandbox-security/`.

The accelerated pieces are deliberately marked **Done (provisional)** below. They work in practice but were shaped by whatever issues we hit during bootstrap, not by spec; the Stage B specs will harden or replace them.

## Milestones

### Milestone 1: Spawn — **Done (realized)**

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

### Milestone 2: Hatchery — **Partial** (Legate container shipped provisionally; F1 profile schema spec drafted at `specs/2026-05-12-003-profile-schema-and-validation-library/`; declarative loader/CLI not implemented)

**Description**: Build the container profile configuration system. The Hatchery is a non-LLM functional system that manages declarative profiles for any containerized March component. Different roles require different security postures — from fully sandboxed spawns to more permissioned agents that handle PR management or orchestration. The Hatchery formalizes the hardcoded container configuration from Milestone 1 into a general-purpose, editable profile system.

**Success Criteria**:
- Container profiles can be defined declaratively and version-controlled.
- Profiles specify base image, file mounts, tool availability, network access, and security posture.
- Multiple security profiles can coexist (e.g., fully sandboxed spawn vs. a more permissioned PR-management agent).
- Spawn (Milestone 1) consumes Hatchery profiles to configure its containers, replacing the hardcoded configuration.
- Profiles can be listed, inspected, and validated via the March CLI.
- Skills updated to cover Hatchery interactions.

### Milestone 3: Brood (Basic) — **Partial** (record-keeping primitives exist in `src/brood/`; feature map drafted at `docs/rfcs/2026-001-march-orchestration-platform/03-brood.features.md`; no specs cut, no CLI surface yet)

**Description**: Build the session lifecycle manager. The Brood is a non-LLM functional system that interacts with the Hatchery to spin up, track, and tear down spawn sessions, giving the operator visibility into all active and completed work.

**Success Criteria**:
- Multiple spawn sessions can be launched and tracked concurrently.
- Session status (running, completed, failed, needs-attention) is visible via the March CLI.
- The operator can SSH into the host and attach to interactive sessions (e.g., Legate) via tmux. Spawn sessions are headless and observable via CLI only.
- Sessions can be torn down cleanly, with output preserved.
- Skills updated to cover Brood management. The accumulated skill set forms a functional pseudo-legate.
- **MVP complete**: the system is usable for dispatching, configuring, and managing parallel sandboxed AI work.

### Milestone 4: Herald — **Realized (provisional)** as the event-sourced observation service (`march herald serve`); the file-based mini-herald precursor spec has been removed as superseded

**Description**: Build the deterministic system-state observation service. Herald is a non-LLM containerized Fastify service that observes the world each tick and records change events into an append-only, seq-ordered **event log** (`node:sqlite`). The system state is **event-sourced** — current state is the fold of the log — so components coordinate by reading the shared log rather than via direct component-to-component communication. Herald appends *observation* events and is the single sequencer; the legate appends *transition* events and drains the inbox via `GET /events?after=<cursor>`. (The earlier "event bus that routes events" framing was superseded by this event-sourced design.)

**Success Criteria**:
- Change events (observation + transition) are appended to a single, seq-ordered event log; Herald is the sole sequencer.
- The legate (and other consumers) drain the inbox via `GET /events?after=<cursor>` and append transitions via `POST /events`.
- The operator can observe current system state (the fold of the log) and the event stream via the March CLI / HTTP surface.
- Components react to state derived from the log rather than polling `smithy status`/`gh` directly; Herald is read-only by default and never touches Docker.

### Milestone 5: Legate — **Done (provisional, accelerated)**

**Description**: Build the intelligent orchestrator.

**Accelerated status (2026-05-16)**: Implemented as a split — `legate-agent` (Claude-backed interactive shell) + `legate-loop` (deterministic processor that handles dispatch, worker monitoring, PR reconciliation). The loop consumes the shipped Herald observation service's event log rather than polling `smithy status --format json` directly (this replaced the earlier mini-herald plan). See [Accelerated Work & Reordering](#accelerated-work--reordering-2026-05). The Legate is an LLM-powered interactive shell that owns the full March workflow — planning, dispatch, monitoring, escalation, and integration. It absorbs and extends the pseudo-legate skills accumulated across prior milestones.

**Success Criteria**:
- The Legate can accept a goal and break it into dispatchable work.
- It monitors the Brood and Herald to track progress and surface issues.
- It escalates decisions to the operator when intervention is needed.
- It can coordinate multi-step workflows (plan → dispatch → review → integrate).
- The accumulated smithy-style skills are integrated as core Legate capabilities.

## Dependency Order

Recommended implementation sequence:

| ID | Title    | Depends On     | Artifact                                                                       |
|----|----------|----------------|--------------------------------------------------------------------------------|
| M1 | Spawn    | —              | docs/rfcs/2026-001-march-orchestration-platform/01-spawn.features.md           |
| M2 | Hatchery | M1             | docs/rfcs/2026-001-march-orchestration-platform/02-hatchery.features.md        |
| M3 | Brood    | M1, M2         | —                                                                              |
| M4 | Herald   | M1, M2, M3     | —                                                                              |
| M5 | Legate   | M1, M2, M3, M4 | —                                                                              |

## Backlog of follow-on specs (Stage B)

These specs build *on top of* the as-built code rather than replacing it. They are the next wave of stabilization work after the 2026-05 acceleration. Ordered by priority.

| # | Spec | Replaces / hardens | Notes |
|---|------|--------------------|-------|
| 1 | Hatchery declarative profiles | Hardcoded `SPAWN_CONFIG` in `src/hatchery/spawn-config.ts`; ad-hoc `legate-container.ts` | YAML profile loader + `march hatchery list/inspect/validate`. Closes M2's stated scope. **In flight** — F1 spec drafted at `specs/2026-05-12-003-profile-schema-and-validation-library/`; F2–F6 still to cut. |
| 2 | ~~Mini-herald daemon~~ **Realized (2026-05)** | `legate-loop`'s direct `smithy status` polling | Herald shipped as the event-sourced observation service; `legate-loop` consumes Herald events. The file-based mini-herald precursor spec has been removed as superseded. |
| 3 | Brood lifecycle CLI | Ad-hoc container management spread across `legate-container.ts`, `spawn-handoff.ts`, and `src/brood/` primitives | `march brood list/status/clean`. Owns container/worktree lifecycle for legates, spawns, and stewards. Integrates with hatchery profiles + herald events. |
| 4 | Steward role formalization | Ad-hoc `launchAgentDeckManager()` path in `spawn-handoff.ts` | Names + specs the steward role: prompt contract, exit conditions, brood-managed lifecycle. |
| 5 | A7 network policy enforcement | Default Docker bridge on spawn containers | Firewall / proxy rules per backend profile; tied to hatchery profile schema so it's declarative. |

(Cut from scope as of 2026-05-16: **Gemini backend**. Claude Code + Codex covers operator needs.)

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
- LLM credentials (API keys or session tokens) are a special case (see A7). No other secrets should enter the container.
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

### A7. LLM Credentials and Network Access

**Threat**: The spawn needs credentials and network access to reach its LLM backend. Those credentials are inside the sandbox. If the sandbox has network access, the LLM could exfiltrate credentials or use them for unintended purposes.

**Reality**: A spawn cannot function without reaching its LLM server. The validated backends (Gemini CLI, Claude Code CLI) each require minimum network access to their respective API endpoints. A fully local LLM (e.g., Ollama) would not need this, but that is not the starting point.

**Authentication models differ by backend**:
- **API key auth** (Gemini, Anthropic API direct): A static API key (`GEMINI_API_KEY` or `ANTHROPIC_API_KEY`) is passed via environment variable. The key has broad access and is a high-value exfiltration target. Rotation and usage monitoring are essential mitigations.
- **OAuth/session auth** (Claude Code with Claude Max): An OAuth session token is passed into the container, either by mounting `~/.claude/` read-only or by setting the session token as an environment variable. Session tokens are scoped, rotatable, and the underlying Claude Max subscription enforces its own rate limits — providing defense-in-depth that a raw API key does not. This model has security advantages for sandbox use: even if the token is exfiltrated, the subscription's rate limiting and session scoping bound the blast radius.

**Mitigations to evaluate**:
- Restrict outbound traffic via firewall rules to only the specific endpoints the backend needs (IP-based, not DNS-based where possible). For Gemini: Gemini API endpoints. For Claude Code: `api.anthropic.com`.
- Block all other outbound traffic. The spawn should not be able to reach arbitrary internet hosts.
- For API key backends: keys should be rotatable and usage-monitored. Consider per-spawn ephemeral keys if the backend supports it.
- For OAuth/session backends: prefer short-lived or spawn-scoped sessions. Leverage the subscription's built-in rate limiting as a secondary control.
- Each backend's minimum network requirements should be documented and enforced individually in the Hatchery profile.
- A host-side proxy approach (piping LLM traffic through a controlled proxy that the container reaches via a local socket) remains a future option to further reduce exposure, but is not required for Milestone 1.

### A8. Resource Exhaustion

**Threat**: The LLM agent consumes excessive CPU, memory, disk, or time — either through runaway behavior or deliberately, as a denial-of-service against the host.

**Mitigations to evaluate**:
- Set container resource limits (CPU, memory, disk quota) via Docker.
- Enforce a maximum execution time per spawn. Kill the container if it exceeds the limit.
- Monitor resource consumption and surface it in spawn status reporting.

---

## Appendix B: Gemini CLI Headless Mode Validation — **Historical (Gemini cut 2026-05-16)**

> Gemini was dropped as a supported backend on 2026-05-16; Claude Code + Codex covers operator needs. This appendix is preserved as historical context for how the multi-backend contract was validated and what shape a future env-var-auth backend would take. Codex's credential-mount auth pattern (Appendix C, plus the multi-backend spec) is the live counterpart.

The RFC originally assumed headless Gemini as the initial spawn backend. This appendix documents the capabilities that support this choice, based on Gemini CLI's current feature set.

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

**Conclusion**: Gemini CLI's headless mode validates the spawn backend assumptions in this RFC. No blocking gaps have been identified. The double-sandboxing question (B6) is the primary item to resolve during early Milestone 1 implementation. See also Appendix C for validation of Claude Code CLI as a second headless backend.

---

## Appendix C: Claude Code CLI Headless Mode Validation

Claude Code CLI supports headless execution with structured output, making it a validated spawn backend alongside Gemini CLI. Notably, Claude Code works with Claude Max subscriptions (flat-rate, no per-token cost), providing an alternative cost model for spawn execution. This appendix documents the capabilities that support this choice.

### C1. Headless Dispatch

Claude Code CLI supports non-interactive execution via the `-p` / `--print` flag:

```bash
claude -p "Your task here" --output-format json --dangerously-skip-permissions
```

Headless mode activates automatically when:
- The `-p` / `--print` flag is provided
- Running in a non-TTY environment (e.g., Docker, piped input)

The `--dangerously-skip-permissions` flag auto-approves all tool executions, eliminating interactive prompts — equivalent to Gemini's `--approval-mode=yolo`.

Additional flags relevant to spawn execution:
- `--bare` — Minimal mode: skips hooks, LSP, plugin sync, auto-memory, background prefetches, and CLAUDE.md auto-discovery. Reduces startup overhead and attack surface.
- `--no-session-persistence` — Disables session persistence; sessions are not saved to disk and cannot be resumed. Appropriate for ephemeral spawn containers.
- `--model <model>` — Select specific models (e.g., `opus`, `sonnet`, or full model IDs like `claude-opus-4-6`). Allows the operator to match model capability to task complexity.
- `--max-budget-usd <amount>` — Cap per-spawn cost (relevant for API key auth; Max subscriptions are flat-rate).

### C2. Completion Signaling

Claude Code CLI blocks until completion and exits with standard exit codes:

| Exit Code | Meaning |
|-----------|---------|
| `0` | Successful execution |
| `1` | Error (API failure, tool error, etc.) |

No polling or completion hooks are needed — the process exits when done. This maps cleanly to the spawn model: launch container → process exits → extract output.

### C3. Structured Output

Three output formats are supported:

- **`text`** (default) — human-readable response on stdout
- **`json`** — single JSON object with rich metadata:
  ```json
  {
    "type": "result",
    "subtype": "success",
    "is_error": false,
    "result": "...",
    "duration_ms": 5816,
    "duration_api_ms": 5677,
    "num_turns": 1,
    "session_id": "...",
    "total_cost_usd": 0.047,
    "usage": {
      "input_tokens": 3,
      "output_tokens": 4
    },
    "modelUsage": { ... }
  }
  ```
- **`stream-json`** — newline-delimited JSON events for real-time streaming

The `json` format provides a richer envelope than Gemini's, including cost tracking, token usage, session ID, and duration metrics. The spawn's prompt augmentation can instruct Claude to include the git patch in its response, which the extraction process wraps into the structured spawn output schema.

### C4. Docker and Container Support

Claude Code CLI runs in Docker containers. Unlike Gemini, it does not have a native `--sandbox=docker` flag — the outer container managed by March provides the isolation layer directly.

**Authentication in containers** — Claude Code requires credentials to reach the Claude API. Two models are supported:

1. **API key auth**: Set `ANTHROPIC_API_KEY` as an environment variable. Standard per-token billing. Same security characteristics as Gemini's API key model (see A7).
2. **OAuth/session auth (Claude Max)**: Mount the host's `~/.claude/` directory read-only into the container, or extract and pass only the session token via environment variable. This enables flat-rate spawn execution under a Claude Max subscription — no per-token costs regardless of spawn count or output length.

**Network requirements**: The container must be able to reach `api.anthropic.com`. Restrict outbound traffic via firewall rules to only this endpoint (IP-based where possible), blocking all other outbound traffic.

### C5. Spawn Integration Model

The validated workflow for a Claude Code-backed spawn:

1. Create worktree and branch.
2. Snapshot worktree into a Docker container.
3. Inside the container, run:
   ```bash
   claude -p "<finalized prompt>" \
     --output-format json \
     --dangerously-skip-permissions \
     --bare \
     --no-session-persistence \
     --model sonnet
   ```
4. Process exits (exit code 0 = success).
5. Extract JSON output from stdout capture.
6. Parse result, extract patch, apply to worktree, push, create PR.

### C6. Known Limitations

- **Auth propagation**: Claude Code's OAuth session must be propagated into the container. The simplest approach (mounting `~/.claude/` read-only) exposes the full Claude config directory. A more surgical approach (extracting only the auth token) requires understanding the internal token storage format, which may change between releases.
- **Max subscription rate limits**: Claude Max subscriptions have usage-based rate limits. Under heavy parallel spawn workloads, rate limiting may throttle concurrent spawns. The exact limits depend on the subscription tier and are not publicly documented as fixed numbers. Brood should detect rate-limit responses (HTTP 429) and implement backoff/queuing.
- **No native sandboxing**: Unlike Gemini's `--sandbox=docker`, Claude Code relies entirely on the outer container for isolation. This is actually simpler — no double-sandboxing question to resolve (compare Gemini's B6).
- **Startup overhead**: Claude Code's full initialization includes hooks, LSP, plugin sync, and CLAUDE.md discovery. The `--bare` flag mitigates this, but startup time should be benchmarked against Gemini for spawn-heavy workloads.

### C7. Validation Status

| Capability | Required | Supported | Notes |
|-----------|----------|-----------|-------|
| Headless dispatch | Yes | Yes | `-p` / `--print` flag |
| Auto-approve all actions | Yes | Yes | `--dangerously-skip-permissions` |
| Structured JSON output | Yes | Yes | `--output-format json` (richer than Gemini) |
| Exit code on completion | Yes | Yes | Standard codes |
| Docker execution | Yes | Yes | Runs in containers; no native sandbox flag needed |
| Resource limits | Yes | Via Docker | Container-level limits via Docker (no CLI flag) |
| No interactive prompts | Yes | Yes | Automatic with `-p` or non-TTY |
| Model selection | Yes | Yes | `--model opus`, `--model sonnet`, etc. |
| Subscription auth | No | Yes | Claude Max — flat-rate, no per-token cost |

### C8. Agent SDK as Alternative Interface

Beyond CLI wrapping, the Claude Agent SDK provides a programmatic alternative for spawn execution:

- **TypeScript**: `@anthropic-ai/claude-code` — import and invoke Claude Code as a library
- **Python**: `claude_code_sdk` — same capabilities, Python interface

The Agent SDK gives finer-grained control over session lifecycle, tool availability, and output handling without parsing CLI output. However, it adds a runtime dependency (Node.js or Python) and is more complex to containerize than a single CLI binary.

**Recommendation**: Start with CLI wrapping for Milestone 1 simplicity. The Agent SDK is a natural optimization path for Milestone 3 (Brood) when programmatic session management becomes more valuable.

**Conclusion**: Claude Code CLI's headless mode fully validates the spawn backend requirements. The auth propagation question (C6) is the primary item to resolve during early Milestone 1 implementation. Claude Max subscription support provides a compelling cost model for high-volume spawn workloads — flat-rate execution regardless of token consumption.
