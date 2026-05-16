# Feature Map: Brood (Basic)

**Source RFC**: `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md`
**Milestone**: 3 — Brood (Basic)
**Created**: 2026-05-12
**Status (2026-05-16)**: **Not started** as written. Some primitives (`src/brood/spawn-record.ts`, `src/brood/worktree.ts`) exist from M1; ad-hoc container management for Legate + Steward currently lives in `src/hatchery/legate-container.ts` and `src/hatchery/spawn-handoff.ts` and should migrate here once the CLI surface (F2/F3) lands. Stage B spec #3 in the RFC backlog (brood lifecycle CLI) maps onto F2/F3 of this map and additionally formalizes Steward container lifecycle. See RFC [Accelerated Work & Reordering](march-orchestration-platform.rfc.md#accelerated-work--reordering-2026-05).

## Accelerated context (2026-05-16)

When this feature map was drafted (2026-05-12) it assumed Spawn was the only containerized session type Brood would manage in M3. Bootstrap acceleration has since introduced two additional containerized session types that Brood will also need to own:

- **Steward sessions** — Claude Code agent-deck sessions launched per spawn by `src/hatchery/spawn-handoff.ts`, running under the `pr-management` profile (when Hatchery profiles land). One steward per spawn; lifecycle bounded by review/test/commit/push/PR.
- **Legate containers** — the `legate-agent` + `legate-loop` pair, currently managed ad-hoc by `src/hatchery/legate-container.ts`. Long-lived; one per operator workspace.

These don't invalidate the F1–F6 decomposition below — Spawn-focused Brood is still the right Basic milestone — but they create a Stage B follow-on. Spec #4 in the RFC backlog ("steward role formalization") and the implicit migration of `legate-container.ts` into Brood will extend the `SpawnView` / `SessionRecord` shape with a discriminated `kind` (`spawn` | `steward` | `legate`) once a second session type actually needs CLI surface. Until then, F1–F6 stay scoped to spawns, and the additional session types are managed by their accelerated code paths.

F5 (Interactive Session Attach Helper) already anticipates this: its `march/<name>` tmux namespace is the documented attach surface, and Legate's agent-deck conductor session is the first concrete consumer. When Brood migrates Legate's container lifecycle in the Stage B follow-on, the F5 namespace contract is the seam.

## Features

### Feature 1: Brood Session Index

**Description**: A read-and-derive substrate over the per-spawn JSON files M1 already writes to `~/.march/spawns/`. Ships a new `src/brood-index.ts` module exposing `listSpawnRecords()`, `loadSpawnRecord(id)`, and `derivedStatus(record, dockerSnapshot?)`. Adds a `failureReason?: string` field to `SpawnRecord` (forward-compatible — no `version` bump) and wires `markSpawnRecordFailed`'s currently-dropped `error` argument through to disk (the existing JSDoc on `MarkSpawnRecordFailedOptions` in `src/spawn-record.ts` already declared this slot). Defines `SpawnView`, a derived view type that exposes `needsAttention`, `disposed`, and `containerLive` flags computed from the persisted record (optionally informed by a `docker inspect` snapshot the caller passes in). The persisted `SpawnStatus` enum stays `"created" | "running" | "stopped" | "failed"` — `"needs-attention"` and `"disposed"` are never written to disk. The reader uses a safe-read protocol (one retry on JSON parse failure, then skip-and-warn) so concurrent dispatch writes cannot fail a `list`.

**User-Facing Value**: Every downstream Brood verb (`list`, `inspect`, `logs`, `teardown`, `attach`) reads spawn state through one tolerant, well-defined API. Operators eventually see *why* a spawn failed in `inspect` output instead of just a bare `failed` status.

**Scope Boundaries**:
- Includes: `src/brood-index.ts` module with `listSpawnRecords()` / `loadSpawnRecord(id)` / `derivedStatus(record, dockerSnapshot?)`, the `SpawnView` derived-view type, the `failureReason?: string` field on `SpawnRecord`, the wiring of `markSpawnRecordFailed`'s `error` argument to the new field, safe-read protocol with one retry on parse failure, optional `docker inspect`-driven liveness reconciliation as a caller-controlled sub-capability, tolerance of records both with and without an M2-era `profile` field
- Excludes: any change to the persisted `SpawnStatus` enum (no `needs-attention` or `disposed` values), schema version bump (`version` stays 1), CLI surface (F2), teardown logic (F3), concurrent-dispatch audit (F4), tmux integration (F5), skill content (F6), adding a `profile` field (that work belongs to M2 F5)

### Feature 2: Brood CLI Read Surface

**Description**: Three operator-facing read verbs that consume F1's API. `march brood list` prints a table (id, status, age, branch, container) with a marker column for derived `needs-attention`, plus a `--json` mode for scripting. `march brood inspect <id>` prints the full SpawnRecord plus derived view fields, including `failureReason` when present. `march brood logs <id>` is a passthrough to `docker logs <containerId>` against the persisted container ID; if the container has been removed (post-teardown), the command falls back to the archived log captured by F3 (see F3's `container.log` archive step). All three verbs are pure reads — they never mutate disk, never mutate Docker state.

**User-Facing Value**: Satisfies the RFC's "Multiple spawn sessions can be launched and tracked concurrently" and "Session status … is visible via the March CLI" criteria with one predictable command surface.

**Scope Boundaries**:
- Includes: `march brood list` (table + `--json`), `march brood inspect <id>` (full record incl. `failureReason`), `march brood logs <id>` (Docker passthrough with archive fallback for torn-down containers), filter flag `--status` on `list`, docker-reconciliation flag (`--reconcile` / `--no-reconcile`) defaulting on for `inspect` and off for `list` per Critical Assumption
- Excludes: any write/mutation verb (F3), launching spawns (M1 owns), tmux attach (F5), Hatchery profile editing (M2 F4), Herald event subscription (M4), watch/follow mode

### Feature 3: Lifecycle Teardown

**Description**: `march brood teardown <id>` plus the `src/spawn-disposal.ts` library that owns success-path disposal of a spawn's runtime artifacts. Reuses the idempotent M1 helpers `removeSpawnContainer` (`src/container-launch.ts`) and `removeSpawnWorktree` (`src/worktree.ts`); deletes the spawn branch via the same git primitive M1's rollback path already uses. Cleanup order is **container → worktree → branch**. Before deleting the worktree, teardown captures `docker logs` output to `~/.march/spawns/archive/<id>/container.log`, snapshots the live SpawnRecord JSON to `~/.march/spawns/archive/<id>/record.json`, and copies the spawn's known structured-JSON output file (the M1 extraction artifact at its designated worktree-internal path) into `~/.march/spawns/archive/<id>/artifacts/` — no recursive copy of the worktree. The live SpawnRecord JSON at `~/.march/spawns/<id>.json` is left in place; "disposed" is *derived* in F1 from "JSON present, container/worktree absent" rather than persisted as a new status value. `--force` is required to tear down a `running` spawn; without it the verb refuses unless docker reports the container is already gone. Teardown is idempotent: a second invocation against an already-torn-down spawn is a no-op.

**User-Facing Value**: Satisfies "Sessions can be torn down cleanly, with output preserved." Operators reclaim disk, branches, and containers with one verb; the structured-JSON output the spawn produced (plus its container log snapshot) survives indefinitely in the archive directory.

**Scope Boundaries**:
- Includes: `march brood teardown <id>` verb, `src/spawn-disposal.ts` library, reverse-order disposal using the existing `removeSpawn*` helpers, `--force` flag for running spawns, archive sub-step writing `~/.march/spawns/archive/<id>/record.json` + `container.log` + `artifacts/`, idempotency, post-condition check that the container is actually gone (analogous to `warnIncompleteRollback`)
- Excludes: bulk teardown (`--all`, `--older-than`), archive retention/GC policy (deferred beyond Basic), automatic teardown triggers (operator-invoked only), introducing a `"disposed"` value on the persisted `SpawnStatus` enum, archiving the full worktree contents, PR/merge lifecycle (M1 F6 owns push/PR creation), tmux attach (F5)

### Feature 4: Concurrent Dispatch Audit

**Description**: An audit-and-test feature whose primary deliverable is *proof* (a written audit + a passing integration test) that M1+M2 dispatch produces non-colliding artifacts under concurrent invocation. Enumerates every shared resource the dispatch chain touches — spawn ID generation, branch name, worktree path, container name, image tag, SpawnRecord file path — and confirms each is collision-safe by construction (atomic rename, `wx` exclusive create, unique-ID prefixing). The existing branch-creation race comment inside `createSpawnWorktree` in `src/worktree.ts` is the precedent; F4 extends that reasoning to the full chain. Ships a single integration test that runs two `march spawn dispatch` invocations concurrently and asserts both succeed with distinct artifacts. Any collision the audit uncovers is filed as its own fix PR rather than silently folded into F4.

**User-Facing Value**: Satisfies the "Multiple spawn sessions can be launched and tracked concurrently" criterion beyond the indexer's visibility — gives the operator (and future Herald) ground truth that the dispatch path actually supports the parallelism Brood surfaces.

**Scope Boundaries**:
- Includes: written audit of every shared dispatch resource, one CI-visible integration test exercising two-at-once dispatch, regression-safety guarantee that M3 introduces no new collision surface
- Excludes: advisory lockfiles or any new concurrency primitive, the `--detach` flag (belongs to M1 dispatch ergonomics, not Brood), N-way stress testing beyond two (deferred), automatic backoff or queuing (M4 Herald territory), backend dispatch refactor (M4/M5)

### Feature 5: Interactive Session Attach Helper

**Description**: A thin tmux wrapper that establishes the `march/` tmux session namespace as a documented convention and gives the operator the verbs required by the RFC's tmux-attach criterion. `march brood attach <name>` execs `tmux attach -t march/<name>`. `march brood sessions` enumerates `march/*` tmux sessions via `tmux list-sessions` and prints them alongside the spawn list (joined in presentation only — no persistence). `march brood attach <spawn-id>` hard-errors with "spawns are headless; use `march brood logs <id>`". M3 ships no code that *creates* tmux sessions; the namespace is a forward contract that M5 (Legate) and any future agent-deck-conductor-based interactive runtime will register under.

**User-Facing Value**: Satisfies "The operator can SSH into the host and attach to interactive sessions (e.g., Legate) via tmux. Spawn sessions are headless and observable via CLI only." Gives the operator a concrete command to run today; future interactive components plug in by naming themselves `march/<something>`.

**Scope Boundaries**:
- Includes: `march brood attach <name>` (thin `tmux attach` wrapper), `march brood sessions` (presentation-only join of `tmux list-sessions` output with the spawn list), the documented `march/<name>` namespace convention, hard-error guard rail when attaching to spawn IDs, error handling for "tmux not installed" / "no sessions"
- Excludes: creating tmux sessions (no consumer exists in M3 — that's M5 Legate), introducing a `kind=interactive` `SessionRecord` or discriminated union (deferred until a second interactive runtime exists alongside Legate), persisting any interactive-session state, embedded TUI

### Feature 6: Brood Skills

**Description**: Skill markdown files deployed by `march init` covering Brood operator workflows: listing and triaging active spawns, inspecting a single spawn, reading logs at every lifecycle stage, tearing down completed work, attaching to interactive sessions, and interpreting `needs-attention`. Includes a top-level orientation skill that names the now-complete M1+M2+M3 workflow as the "pseudo-legate" the RFC promises, and an optional `brood.self-check` skill that runs `march brood list --reconcile` and reports any rows with derived `needsAttention=true`. Skill content references the verbs F2/F3/F5 ship; authoring can begin in parallel with F2–F5 once F1's reader signatures are committed, but skill content stabilizes last.

**User-Facing Value**: Satisfies "Skills updated to cover Brood management. The accumulated skill set forms a functional pseudo-legate." An operator running March under smithy-driven Claude Code (the pseudo-legate substrate) has end-to-end skill coverage for the plan → dispatch → monitor → teardown loop without Legate-the-component existing yet.

**Scope Boundaries**:
- Includes: skill markdown for each Brood verb (`brood.list`, `brood.inspect`, `brood.logs`, `brood.teardown`, `brood.attach`, `brood.sessions`), a pseudo-legate orientation skill that explicitly names the MVP-complete state, the optional `brood.self-check` skill, deployment via the existing `march init` skill-deployment pipeline (M1 F1 / M2 F6)
- Excludes: runtime CLI surface (F2–F5), schema (F1), Legate-class orchestration (M5 Legate), Herald-driven skill triggers (M4 Herald)

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | `--force` teardown semantics on a running container: should F3 invoke `docker rm -f` directly (immediate SIGKILL), or first `docker stop` (SIGTERM with default 10s grace) then remove? The former is faster and matches the "force" verb literally; the latter gives the spawn LLM a chance to flush its structured-JSON output before the container dies. Recommended answer: `docker stop` then `docker rm` for `--force` on a running container, with an additional `--kill` flag for true SIGKILL. Defer to F3's spec phase. | clarify:Integration Points | Medium | Medium | open | — |
| SD-002 | `march brood logs <id>` behavior after teardown is resolved by F3 capturing `docker logs` to `~/.march/spawns/archive/<id>/container.log` during teardown and F2 falling back to that file when the container is gone. The remaining open question is whether to *also* capture container logs continuously during spawn execution (touches M1 — out of scope), and whether the archived log should be compressed for long-running spawns. Recommended answer: ship the snapshot-on-teardown approach as scoped; treat compression and live capture as future work. | clarify:Overlap Between Features | High | Medium | open | — |
| SD-003 | Exact definition of "auxiliary output artifacts" inside a worktree for F3's archive step. The feature map specifies the SpawnRecord JSON snapshot and the M1 structured-JSON output file at its designated path. Open questions: what if M1 emits multiple output files in future? What if the operator's prompt instructed the spawn to write additional files? Recommended answer: archive *only* the file at M1's designated extraction path; future M1 changes that emit additional output paths must update F3's archive list. | clarify:Scope Within the Milestone | High | Medium | open | — |
| SD-004 | F4 (concurrent dispatch audit) viability as a standalone feature. If the audit finds no real collisions (likely — M1's dispatch path is already collision-aware by design), F4's shipped artifact is essentially one integration test plus a written audit. Options: keep F4 standalone (chosen — the audit document itself is load-bearing for the "concurrent" success criterion), fold into F1's spec, or expand to N-way stress. Recommended answer: keep standalone for now; revisit at spec phase if the audit reveals nothing. | clarify:Feature Boundaries | Medium | Medium | open | — |
| SD-005 | F1 size: F1 carries the data-model addition (`failureReason`), the wiring fix for `markSpawnRecordFailed`, the reader API (`listSpawnRecords`/`loadSpawnRecord`), the derived-view type (`SpawnView` and `derivedStatus`), the safe-read protocol, and optional docker reconciliation. Options: (a) keep F1 unified — concerns are tightly coupled; (b) split into F1a (data-model) and F1b (reader + derivation). Recommended answer: (a) — splitting creates a tiny F1a, but F1 is noticeably larger than F4/F5 so a split is defensible at spec phase. | clarify:Scope Within the Milestone | Medium | Medium | open | — |
| SD-006 | F2's Scope Boundaries qualifies the docker-reconciliation default with "per Critical Assumption", but the artifact has no `## Assumptions` section listing the Critical Assumption (sibling feature maps 01-spawn and 02-hatchery also lack one, so the convention is not yet established for this RFC). Either the assumptions need to be appended as an `## Assumptions` section the spec phase can lift, or the F2 reference needs to stand on its own without the pointer. Recommended answer: defer to the spec phase — the Critical Assumption is captured in the PR body's `## Assumptions` snippet today, and the convention can be settled across the RFC's feature maps as a follow-up. | plan-review:Assumption-output drift | Important | Low | open | — |

## Dependency Order

Recommended specification sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| F1 | Brood Session Index | — | — |
| F2 | Brood CLI Read Surface | F1 | — |
| F3 | Lifecycle Teardown | F1 | — |
| F4 | Concurrent Dispatch Audit | F1 | — |
| F5 | Interactive Session Attach Helper | — | — |
| F6 | Brood Skills | F1, F2, F3, F5 | — |

F2, F3, F4, and F5 can begin in parallel once F1 has landed (F5 is fully independent and could even start first). F6 ships last because skill content references the final verbs of F2/F3/F5; its authoring can run in parallel once F1's reader signatures are committed, but content stabilizes after F2–F5 merge.

## Cross-Milestone Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| Milestone 1: Spawn | depends on | F1 extends `SpawnRecord` (`src/spawn-record.ts`) with `failureReason` and reads the JSON files M1 writes. F3 reuses M1's `removeSpawnContainer` (`src/container-launch.ts`) and `removeSpawnWorktree` (`src/worktree.ts`) helpers. F6 deploys via M1 F1's `march init` skill-deployment pipeline. M3 does NOT redo M1 F6's PR-integration work — the RFC's "Code review via GitHub" design consideration ("Integration tooling (part of Brood or a dedicated component)") is satisfied entirely by M1 F6. |
| Milestone 2: Hatchery | depends on | Loose dependency: F1 tolerates SpawnRecords both with and without an M2 F5 `profile` field — M3 begins safely even if M2 F5 has not yet landed. F6's skill catalog accumulates onto the M2 F6 skill set; deployment plumbing is unchanged. |
| Milestone 4: Herald | depended upon by | F1's `docker inspect`-based liveness reconciliation is a poll-time approximation of what Herald will deliver as event-driven status transitions. When M4 lands, F1's reconciliation sub-capability can be replaced with Herald subscriptions; the `SpawnView` API need not change. |
| Milestone 5: Legate | depended upon by | F5's `march/` tmux namespace is the forward contract M5 will register Legate under. The first `march/<name>` tmux session in the system will be Legate's (as of 2026-05-16, the accelerated `legate-agent` already runs in a tmux/agent-deck conductor session — its container lifecycle currently lives in `src/hatchery/legate-container.ts` and will migrate into Brood in the Stage B follow-on described in the Accelerated context). F6's "pseudo-legate" orientation skill is replaced by real Legate orchestration when M5 lands. |
| Hatchery: Spawn-Handoff / Steward (2026-05 accelerated) | depended upon by | The Steward sessions launched by `src/hatchery/spawn-handoff.ts` are containerized Claude Code agent-deck sessions whose lifecycle Brood will eventually own (Stage B spec #4: steward role formalization). Out of scope for the M3 Basic milestone; in scope for the Stage B follow-on. |
