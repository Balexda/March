# Analysis: Claude Swarms vs. March RFC

**Date**: 2026-03-28 | **Status**: Complete

## Purpose

This document analyzes the relationship between **Claude Swarms** (Anthropic's multi-agent coordination feature in Claude Code, also called "Agent Teams") and the **March Orchestration Platform** as described in [RFC 2026-001](../rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md). It answers the question: is Swarms a replacement for March, a tool March could use, or something orthogonal?

---

## What Each System Is

### Claude Swarms (Agent Teams)

Claude Swarms is a built-in Claude Code feature that enables multi-agent coordination for software development. Its architecture:

- **Team lead model**: One Claude Code session acts as team lead. It plans, delegates, and coordinates but does not write code directly.
- **Specialist agents**: The team lead spawns specialized Claude Code instances (frontend, backend, testing, docs, architecture). Each specialist gets an independent Claude Code session with its own full context window.
- **Git worktree isolation**: Each agent operates in an independent git worktree. Changes merge to main only after passing tests.
- **Inter-agent communication**: Shared task list with dependency tracking. Inbox-based messaging via the TeammateTool API (13 distinct operations). Agents can self-claim work as they complete prior tasks.
- **Single authority for side effects**: The team lead is the policy engine — one agent coordinates all integration decisions.
- **Claude-native**: Runs entirely within Claude Code's ecosystem. No Docker, no external infrastructure.

### March Orchestration Platform

March is a standalone orchestration control plane for safely dispatching parallel AI-assisted development work. Its architecture consists of five components delivered incrementally:

1. **Spawn** — Disposable, one-shot sandboxed executor. Pure function: finalized prompt + snapshotted worktree → structured JSON result. Runs in a Docker container with no outbound network access.
2. **Hatchery** — Non-LLM container profile manager. Declarative, version-controlled profiles for any containerized March component.
3. **Brood** — Non-LLM session lifecycle manager. Tracks the full arc: worktree creation → branch → container → PR → review → merge → cleanup.
4. **Herald** — Non-LLM event bus. Routes events (spawn completion, errors, escalations) between components via first-class clients.
5. **Legate** — LLM-powered intelligent orchestrator. Owns planning, dispatch, monitoring, escalation, and integration. Prototyped incrementally via smithy-style skills until Milestone 5.

March is model-agnostic ("prompt in, structured JSON out") and treats sandbox integrity as an existential requirement.

---

## Comparison

| Dimension | Claude Swarms | March |
|-----------|---------------|-------|
| **Scope** | Multi-agent feature within Claude Code | Full orchestration platform with dedicated infrastructure |
| **Backend** | Claude Code only | Model-agnostic (Gemini, Claude, others) |
| **Isolation** | Git worktrees; Claude Code's permission system | Docker containers + worktrees; no network; snapshot-based |
| **Security model** | Trust Claude Code's approval/permission modes | Zero-trust sandbox; enumerated threat model (Appendix A) |
| **Coordination** | Shared task list + inbox messaging (LLM-mediated) | Event bus (Herald) + session manager (Brood) — deterministic |
| **Agent autonomy** | Agents self-claim, collaborate, challenge each other | Pure-function spawns; no inter-spawn communication |
| **Observability** | Claude Code session output | CLI + Herald events + tmux attachment for interactive components |
| **Output model** | Agents write code directly to worktrees | Structured JSON envelope with optional git patch |
| **Integration** | Leader merges worktrees | Deterministic extraction → PR creation → human review |
| **State management** | Ephemeral (session lifetime) | Managed lifecycle (Brood owns create → PR → merge → cleanup) |
| **Availability** | Available today | RFC stage; no implementation yet |

---

## The Verdict: Swarms Is a Potential Backend, Not a Replacement

### Swarms does not replace March

March and Swarms operate at different layers of the stack.

**1. March solves infrastructure; Swarms solves coordination.**
Swarms answers "how do multiple Claude Code agents collaborate on a task?" March answers "how does a solo operator safely dispatch, monitor, lifecycle-manage, and integrate work from any AI backend?" These are related but distinct problems. Swarms assumes the infrastructure exists (Claude Code sessions, worktrees, permissions). March *is* the infrastructure.

**2. March's security model is fundamentally stricter.**
Swarms trusts Claude Code's permission system — agents operate with whatever approval mode the user sets. March treats every spawn as untrusted: Docker containers with `--network=none`, snapshot-based worktrees (copied, not mounted), sequential handoff (LLM terminates before extraction begins), and an eight-category threat model with enumerated mitigations. Running an LLM in yolo mode without March's isolation model is what the RFC calls "catastrophically unsafe."

**3. March is model-agnostic; Swarms is Claude-native.**
March's spawn interface abstracts the backend: "prompt in, structured JSON out." The rest of the system (Brood, Herald) sees only a stopped container with a JSON file — it never needs to know which backend ran. Swarms is inherently bound to Claude Code.

**4. March's deterministic infrastructure has no Swarms equivalent.**
Herald, Brood, and Hatchery are explicitly non-LLM functional systems with predictable behavior. Swarms' coordination is entirely LLM-mediated — the team lead *reasons* about what to delegate and when. This is powerful but non-deterministic. March deliberately restricts non-deterministic decisions to execution (Spawn) and orchestration (Legate), keeping everything else predictable.

**5. March manages full lifecycle; Swarms sessions are ephemeral.**
Brood tracks the full arc: worktree creation → container setup → execution → extraction → PR → review → merge → cleanup. Swarms sessions exist for the duration of the conversation and leave worktrees/branches for the user to manage.

### Swarms is not orthogonal to March

Despite the different layers, both systems are motivated by the same problem. The RFC's motivation section could serve as Swarms' product brief:

> *"Modern AI-assisted development breaks down as complexity and parallelism increase... The human operator is forced to manually coordinate multiple terminals, worktrees, sandbox environments, agents, and review loops."*

Both use worktree-per-agent isolation. Both have a planning/dispatch/execution model. Both aim to let a developer scale output through parallel AI work. They are clearly in the same problem space — just at different altitudes.

### Swarms is a tool March could use

The most productive framing: **Swarms is a candidate backend and design influence for March, not a competitor.**

- **Swarms as a Spawn backend**: Claude Code with Swarms could serve as a spawn backend, with March wrapping it in Docker for stronger isolation. A Swarms team lead inside a March container would get the collaboration benefits of inter-agent messaging while inheriting March's security guarantees.
- **Swarms as Legate inspiration**: March's Legate (Milestone 5) is an LLM-powered orchestrator that plans, dispatches, and monitors. Swarms' team-lead pattern — where a coordinator breaks down work, delegates to specialists, and integrates results — is essentially what Legate aspires to be. The difference is that Legate sits above deterministic infrastructure (Brood, Herald) rather than coordinating directly.
- **Herald could learn from TeammateTool**: Swarms' 13-operation TeammateTool API for inter-agent communication could inform Herald's event protocol design, particularly for scenarios where March evolves beyond pure-function spawns into more interactive session types.
- **Swarms for non-spawn sessions**: March acknowledges that some sessions need interactivity (tmux-based, SSH-attachable). Swarms' collaboration model could be valuable for these interactive components where pure-function isolation is too restrictive.

---

## Where Swarms Excels Over March's Current Design

Honest assessment of what Swarms does better:

1. **Rich inter-agent collaboration** — Swarms agents communicate, challenge each other's approaches, and share findings in real time. March spawns are isolated pure functions with zero inter-spawn communication. This is a deliberate March design choice (isolation > collaboration), but it means March cannot achieve the emergent problem-solving that comes from agents debating approaches.

2. **Dynamic task claiming** — Swarms agents self-claim work from a shared task list as they finish prior tasks. March dispatches statically via Legate. Swarms' model adapts naturally to agents that finish at different speeds.

3. **Immediate availability** — Swarms works today in Claude Code. March is an RFC. This is the most significant practical difference.

4. **Lower operational overhead** — No Docker daemon, no container management, no profile configuration, no event bus setup. A user types a prompt and gets parallel agents. March requires infrastructure.

---

## Where March Excels Over Swarms

1. **Security guarantees** — March's sandbox model provides actual containment. Swarms relies on Claude Code's permission system, which is configurable but not a security boundary in the same way Docker network isolation is.

2. **Auditability and reproducibility** — Structured JSON output, deterministic extraction, and event logging make March spawns auditable. Swarms sessions produce code changes but the reasoning and coordination is ephemeral.

3. **Backend flexibility** — When a different model is better for a specific task (Gemini for large codebases, Claude for reasoning-heavy work), March can dispatch to the right backend. Swarms is locked to Claude.

4. **Lifecycle management** — March doesn't leave worktrees, branches, and containers for the user to clean up. Brood owns the full lifecycle.

5. **Deterministic coordination** — Herald and Brood provide predictable infrastructure. LLM-mediated coordination (Swarms' model) is powerful but can exhibit the same non-deterministic behaviors that make single-agent sessions unreliable at scale.

---

## Conclusion

**Swarms and March are complementary, not competitive.** Swarms is a multi-agent coordination feature that lives inside Claude Code. March is an orchestration control plane that could *contain* Claude Code (with or without Swarms) as one of several backends.

The right mental model:

```
┌──────────────────────────────────────────┐
│              March (Control Plane)         │
│                                           │
│  Legate → plans, dispatches, monitors     │
│  Herald → routes events deterministically │
│  Brood  → manages session lifecycles      │
│  Hatchery → configures container profiles │
│                                           │
│  ┌─────────────┐  ┌─────────────┐        │
│  │ Spawn:      │  │ Spawn:      │        │
│  │ Gemini CLI  │  │ Claude Code │  ...   │
│  │ (headless)  │  │ (+ Swarms?) │        │
│  └─────────────┘  └─────────────┘        │
└──────────────────────────────────────────┘
```

March provides the safety, lifecycle management, and deterministic infrastructure. Swarms (or any other multi-agent system) provides the execution intelligence within a spawn. They solve different problems at different layers, and the most powerful system would use both.

The practical implication for March development: **Swarms validates the problem space** (multi-agent coordination for development is real and valuable) **without obsoleting the solution** (safe, model-agnostic orchestration infrastructure is still needed). If anything, Swarms' existence strengthens the case for March — it proves that multi-agent work produces value, which makes the infrastructure to manage it safely even more important.
