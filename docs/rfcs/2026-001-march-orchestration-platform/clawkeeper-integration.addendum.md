# Addendum: ClawKeeper Integration Exploration

**Parent RFC**: `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md`
**Created**: 2026-04-06  |  **Status**: Exploration
**Scope**: Future expansion — does not modify Milestones 1–5

---

## Summary

ClawKeeper is a security framework for autonomous AI agents that exists in two complementary forms: a host-level security scanner (RAD Security, [clawkeeper.dev](https://clawkeeper.dev/)) and a three-layer runtime safety framework (SafeAI-Lab-X, [arxiv 2603.24414](https://arxiv.org/abs/2603.24414)). Together they address the security gap that March's current architecture leaves open between fully-sandboxed Spawns and partially-permissioned components like Legate.

This addendum captures the integration opportunity for a future session to workshop into its own RFC (via `smithy.ignite`) or spec directly (via `smithy.mark`). Nothing here changes the current milestone plan.

---

## Motivation: The Partial-Access Security Gap

March's security model has a deliberate gradient:

| Component | Sandbox Model | LLM-Powered | Risk Profile |
|-----------|---------------|-------------|--------------|
| Spawn (M1) | Full isolation — `--cap-drop=ALL`, `--network=none`, snapshot copy, sequential handoff | Yes | **Low** — structurally constrained |
| Hatchery (M2) | Deterministic profile manager | No | Negligible |
| Brood (M3) | Deterministic lifecycle manager | No | Negligible |
| Herald (M4) | Deterministic event bus | No | Negligible |
| Legate (M5) | Partial access — GitHub API, git, Brood/Herald, tmux session | Yes | **High** — real permissions, LLM reasoning |

Spawn's security is solved by architecture. The container literally cannot do anything dangerous — no network, no host access, pure function semantics. The eight threat categories in Appendix A are addressed through structural isolation.

Legate is different. It is LLM-powered, has real permissions (GitHub API, git push to feature branches, spawn dispatch, event bus access), runs interactively in a persistent tmux session, and takes actions while running (no sequential handoff). March's current mitigation for Legate is static permission lists (`settings.json` allow/deny patterns), which prevent specific dangerous commands but cannot detect:

- **Goal drift** — Legate implementing something different from what was dispatched.
- **Anomalous action sequences** — unusual spawn dispatch volume, rapid PR creation, unexpected file modifications.
- **Escalation failures** — Legate retrying instead of escalating to the operator.
- **Contextual misuse** — valid operations used in unexpected combinations or contexts.

The same gap applies to any Hatchery profile with elevated permissions (e.g., a PR-management agent with GitHub access but limited filesystem scope). Static permission lists define what is *allowed* but cannot detect what is *anomalous within those allowances*.

**ClawKeeper addresses this gap at three levels: host hardening, runtime behavioral monitoring, and instruction-level policy injection.**

---

## ClawKeeper Capabilities

### RAD Security Scanner (clawkeeper.dev)

An open-source pure-bash security scanner for AI agent host machines. Zero dependencies. 42+ checks across 5 phases:

1. **Host Hardening** (16 checks) — OS-level misconfigurations: firewall, disk encryption, SSH hardening, auto-login, unnecessary services.
2. **Network** (6 checks) — Isolation and exposure: open ports, mDNS, screen sharing, remote SSH.
3. **Prerequisites** — Dependency verification: Docker, Node.js, essential packages.
4. **Installation** — Running agent detection in containers and bare-metal.
5. **Security Audit** (11 checks) — Container hardening: root user, Linux capabilities, privileged mode, port exposure, credential leakage in config/history/logs, `.env` permissions.

Outputs a letter grade (A–F). Supports auto-remediation, agent mode with hourly scans, dashboard upload, and fleet drift detection.

### SafeAI-Lab-X Runtime Framework (arxiv 2603.24414)

A three-layer runtime safety framework for autonomous agents:

1. **Skill-based protection** (instruction level) — Injects structured security policies into agent context as markdown documents. Constrains decision-making at the reasoning stage before action selection.
2. **Plugin-based protection** (runtime level) — Configuration hardening, proactive threat detection, and behavioral monitoring during the execution pipeline. Direct coupling to agent internals via plugin hooks.
3. **Watcher-based protection** (system level) — A decoupled security middleware that continuously monitors agent state evolution. Can halt high-risk actions or enforce human-in-the-loop confirmation without coupling to the agent's internal logic. System-agnostic — supports local and remote governance modes.

---

## Integration Surface Map

| ClawKeeper Capability | March Component | Integration Type | Priority |
|---|---|---|---|
| Host hardening checks | `march init` (M1) | Pre-flight validation | Medium |
| Container security audit | Hatchery (M2) | Profile validation | Medium |
| Credential leakage scanning | Spawn snapshot (M1) | Complement to A5 mitigation | Medium |
| Network isolation verification | Spawn + Legate containers | Enforcement validation | Medium |
| Drift detection (agent mode) | Brood (M3) | Lifecycle hook | Medium |
| Watcher — behavioral monitoring | Herald (M4) + Legate (M5) | Herald consumer | **High** |
| Watcher — dynamic escalation | Legate (M5) | Escalation triggers | **High** |
| Watcher — human-in-the-loop gates | Legate (M5) | Approval workflows | **High** |
| Skill-based policy injection | SmithyCLI skills | `smithy.guardian.md` | Low |

---

## Integration Tiers

### Tier 1: Host Scanner — Pre-Flight and Validation

**What**: Invoke the RAD Security scanner as a tool (not a plugin) at key March lifecycle points.

**`march init` pre-flight** — Before any containers launch, run `clawkeeper.sh scan --non-interactive`. If the host fails critical checks (firewall off, Docker misconfigured, credentials in shell history), March warns or blocks. This is a tool invocation — same as calling `docker` or `git` — consistent with March's "no plugin system" stance.

**Hatchery profile validation** — After Hatchery (M2) materializes a profile, run ClawKeeper's container-specific checks against the resulting Docker configuration. Verifies that profiles actually produce hardened containers, not just that they declare the right fields.

**Brood drift detection** — During long-running sessions (especially Legate), periodic ClawKeeper scans detect host configuration drift. Brood (M3) triggers these as a lifecycle hook, surfacing degradation before it becomes exploitable.

**Credential scanning for snapshots** — ClawKeeper's credential leakage checks complement March's A5 (Snapshotted Context Secrets) mitigation. Run against the worktree snapshot before it enters the container.

### Tier 2: Watcher Architecture — Legate Runtime Governance

**What**: Build a March Watcher as a first-class deterministic Herald (M4) consumer, inspired by ClawKeeper's watcher concept but built natively within March's architecture.

This is the highest-value integration. The Watcher would be a non-LLM functional system (matching March's design principle for Herald, Hatchery, and Brood) that:

1. **Consumes Legate's action stream via Herald** — Every tool call, git operation, spawn dispatch, PR action, and escalation decision is an observable event on the Herald event bus. The Watcher subscribes to these events without coupling to Legate's internals.

2. **Maintains behavioral baselines** — Learns what "normal" Legate activity looks like for this operator and project. Unusual patterns surface as anomalies.

3. **Enforces dynamic escalation triggers** — Goes beyond static permission lists to detect patterns that warrant human review:

   | Trigger | Action | Rationale |
   |---|---|---|
   | >N spawns dispatched in T minutes | Pause + escalate | Prevents runaway spawn loops |
   | Git push to unexpected branch pattern | Block + escalate | Scope enforcement |
   | PR created against main/master | Block + require confirmation | High-risk integration action |
   | Actions outside current plan scope | Alert operator | Goal drift detection |
   | Repeated failures without escalation | Force escalation | Legate should ask for help, not loop |
   | Credential-bearing API call to unexpected endpoint | Block | Network scope enforcement |

4. **Supports human-in-the-loop gates** — Certain action patterns require operator confirmation before proceeding, beyond static command-level approval. The Watcher pauses Legate's tmux session pending review.

**Design alignment with March principles**:
- **Deterministic** — The Watcher is a functional system, not LLM-powered. Matches the Herald/Hatchery/Brood pattern.
- **Decoupled** — Observes via Herald event stream. Never couples to Legate's internal logic.
- **Herald is the natural transport** — The event bus already routes events between components. A Watcher is simply another Herald consumer.
- **Escalation already planned** — Legate's M5 spec includes "escalates decisions to the operator when intervention is needed." The Watcher formalizes *when* escalation triggers fire, moving this from LLM judgment to deterministic rules.

**Applicability beyond Legate** — Any Hatchery profile with elevated permissions (PR-management agents, CI integration agents) benefits from Watcher monitoring. The Watcher is not Legate-specific — it monitors any Herald-connected component whose actions carry risk.

### Tier 3: Skill Enrichment — Guardian Policy Injection

**What**: Add a security-focused SmithyCLI skill that injects ClawKeeper-inspired policies into Legate's context at the instruction level.

March's current smithy skills are task-focused: `forge`, `ignite`, `audit`, `render`, `cut`. None address security policy. A `smithy.guardian.md` (or similar) skill would inject LLM-interpretable security constraints into Legate's context:

- Branch protection rules: never push to main, never force-push.
- Escalation mandates: always escalate before creating PRs against protected branches, always escalate after N consecutive failures.
- Scope constraints: only modify files within the current task's declared scope.
- Output hygiene: validate spawn output before applying patches.

This complements static `settings.json` permissions (which enforce at the command level) with reasoning-level constraints (which influence Legate's decision-making before it selects actions). ClawKeeper's skill-based protection demonstrates this pattern with structured markdown policy documents — the same format March already uses for SmithyCLI skills.

**Implementation**: A single `.claude/prompts/smithy.guardian.md` file deployed by `march init`. No infrastructure required. Lowest effort, immediate value.

---

## What March Already Covers

To avoid duplication, the following are already addressed by the current milestone plan and do not need ClawKeeper:

- **Spawn container isolation** — Appendix A threat model (A1–A8) comprehensively covers container escape, volume mounts, env leakage, network, secrets, output manipulation, credentials, and resource exhaustion. Structural isolation is the mitigation, not runtime monitoring.
- **Static permission enforcement** — `settings.json` allow/deny lists prevent specific dangerous commands. This works for known-bad operations.
- **Sequential handoff for Spawns** — LLM terminates before extraction. No concurrent access risk.
- **Deterministic infrastructure** — Herald, Hatchery, and Brood are non-LLM systems with predictable behavior.

ClawKeeper's value is specifically in the areas March's current design does **not** cover: host-level validation, runtime behavioral monitoring for partially-permissioned LLM agents, and instruction-level security policy injection.

---

## Sequencing

This integration does not modify Milestones 1–5. Recommended timing:

| Integration | When | Dependency |
|---|---|---|
| `smithy.guardian.md` skill | Anytime (no infrastructure needed) | None |
| `march init` pre-flight scan | During M1 implementation | RAD scanner installed on host |
| Hatchery profile validation | During M2 implementation | RAD scanner + Hatchery profiles |
| Brood drift detection | During M3 implementation | RAD scanner + Brood lifecycle |
| Herald event schema for Watcher | During M4 design | Herald event format decision |
| March Watcher component | Post-M4 or during M5 | Herald operational |

The M4 Herald design is the key inflection point. If the Herald event schema is designed with Watcher consumption in mind from the start (ensuring all Legate actions emit observable events), the Watcher can be built cleanly during or after M5. Retrofitting observability into Herald after the fact would be harder.

---

## Open Questions

- **Watcher as M6 or part of M5?** The Watcher could be a separate milestone (keeping M5 focused on Legate orchestration) or integrated into M5 (since Legate and its governance are tightly coupled). The separate-milestone approach is cleaner but delays protection.
- **Behavioral baseline bootstrapping** — How does the Watcher learn "normal" activity? Fixed rules first (the trigger table above), then adaptive baselines? Or start adaptive from day one?
- **Watcher governance of the Watcher** — If the Watcher is deterministic, who validates the Watcher's rules? Operator-editable config files (Hatchery-style)? Version-controlled rule sets?
- **RAD scanner as hard or soft dependency?** Should `march init` require ClawKeeper to be installed, or treat it as an optional enhancement with degraded-but-functional behavior when absent?
- **Remote vs. local governance mode** — ClawKeeper's Watcher supports both. March is designed for a solo operator on a single host. Local-only initially, with remote governance as a future expansion for multi-host deployments?

---

## References

- **RAD Security ClawKeeper** — [clawkeeper.dev](https://clawkeeper.dev/) | [github.com/rad-security/clawkeeper](https://github.com/rad-security/clawkeeper)
  - Open-source pure-bash security scanner, 42+ checks, 5 phases, auto-remediation, fleet drift detection.
- **SafeAI-Lab-X ClawKeeper** — [arxiv.org/abs/2603.24414](https://arxiv.org/abs/2603.24414) | [github.com/SafeAI-Lab-X/ClawKeeper](https://github.com/SafeAI-Lab-X/ClawKeeper)
  - Three-layer runtime safety: skill-based (instruction), plugin-based (runtime), watcher-based (system-level decoupled middleware).
- **Parent RFC** — `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md`
  - Appendix A: Spawn Sandbox Threat Model (A1–A8).
  - Milestone 5: Legate — escalation, monitoring, and orchestration spec.
