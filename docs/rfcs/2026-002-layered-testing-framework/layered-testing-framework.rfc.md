# RFC: Layered Testing Framework

**Created**: 2026-05-17  |  **Status**: Draft

## Summary

This RFC commits March to a two-axis test taxonomy — scope (L0–L3) crossed with determinism (deterministic vs. stochastic) — and to a cassette-replayed integration tier that makes cross-subsystem coverage affordable on a $0 PR gate. Execution is sequenced across eight vertical-slice milestones (M-A through M-H), each delivering an end-to-end working capability with explicit exit criteria. The strategy doc at [`docs/testing-strategy.md`](../../testing-strategy.md) remains the long-lived principles companion; this RFC is the commitment, sequencing, and per-milestone success criteria that turn those principles into shipped infrastructure.

## Motivation / Problem Statement

PR #126 surfaced four production bugs in a single review cycle, and every one of them was diagnosed the same way: the operator noticed nothing was happening, hours or days after the failure mode started. The Hatchery runner script had been syntactically invalid for months — every spawn silently failed on a `node -e` line-break escape, and the operator only caught it by inspecting a stalled session by hand. `launchAgentDeckManager` carried a race condition that let three concurrent dispatches attach to the same wrong session. The Legate loop's escalation path never notified the agent, so state.json piled up while the agent sat idle for 30+ hours. Stale stub archives silently blocked fresh dispatches. Each of these maps cleanly to a missing layer of automated coverage that would have caught the failure in seconds rather than days.

The cost is paid in operator time, and the operator is the sole human in the loop. There is no second pair of eyes to notice a stalled session faster; there is no team rotation absorbing the triage load. Every hour spent reconstructing "why did nothing happen between Tuesday and Thursday" is an hour not spent moving March forward. The four PR #126 incidents alone consumed enough manual triage to motivate this RFC — and they are not anomalies. They are the predictable output of a harness that has grown by accretion, where contracts between subsystems are tested implicitly (or not at all) until something breaks loudly enough that the operator notices.

This is the right time to commit to the framework because three structural pressures from [`docs/testing-strategy.md` §1](../../testing-strategy.md#1-why-this-strategy-exists) are all compounding at once. The subsystem count keeps growing — Spawn, Hatchery, Brood, Herald, Legate, Steward — and the interesting failures happen *between* subsystems, exactly where coverage is thinnest. Determinism and stochasticity now mix inside the same workflows, and tests that conflate the two either lie or break. Stochastic tests against real backends cost money and wall-clock that the PR gate cannot absorb. PR #126 was the forcing function: it surfaced the failure class all at once, and every incident traced to the same missing layer — cassette-replayed cross-subsystem coverage on a $0 PR gate, with a separate scheduled suite holding the line against backend drift.

Other roles the Operator plays (named in §Personas) are blocked by the same gap. As test author, there is no L2 scaffolding to write against — the first Spawn → Steward handoff test cannot exist until cassette infrastructure does. As CI failure triager, there is no staged pipeline that fails fast on L0 invariants before burning wall-clock on L3; today every test runs in one `npm test` bucket. As cassette refresher, there is no record/replay tooling, no quarantine flow, no cost visibility. As scheduled-suite signal reviewer, there is no scheduled suite at all — cassette-drift detection has nowhere to live. Each of these is a workflow the Operator already performs ad-hoc; the framework names them, sequences the infrastructure that makes them tractable, and ties the per-milestone exit criteria to the moment each one becomes real.

The eight milestones (M-A through M-H) are deliberately vertical slices rather than horizontal phases: M-A delivers test legibility and a staged CI pipeline; M-B adds the contract documentation that gives cassette-backed tests something explicit to assert against; M-C fuses cassette infrastructure with the first L2 vertical slice on the Spawn ↔ Steward boundary — the exact PR #126 hotspot; M-D fills the Hatchery L1 gap concurrent with M-C; M-E generalizes the cassette infrastructure for reuse; M-F adds the scheduled stochastic suite with recording mode, cost gating, and quarantine tooling; M-G lifts the first L3 vertical slice from `tests/Agent.tests.md` A1 into a runnable scenario; M-H delivers Herald-enabled trace-as-fixture (currently Blocked on Herald). Each slice produces working coverage rather than half-built infrastructure waiting on the next phase. This sequencing, the locked framework choices (vitest for L0/L1, Cucumber.js for L2/L3), and the $0 PR-gate constraint are the commitments this RFC carries that the strategy doc deliberately does not. It is a sibling RFC to [2026-001](../2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md) and inherits the same operator model and intervention-avoidance contract defined in [`docs/operating-philosophy.md`](../../operating-philosophy.md) — in particular [rule 3](../../operating-philosophy.md#3-failures-are-clean-exits-not-hangs), which the PR #126 incidents violated structurally by letting stalls become hangs the operator had to discover by hand.

The goal: a harness where every cross-subsystem contract has a deterministic test at the scope where it can break, a scheduled suite holds the line against backend drift, and an incident like any of the four from PR #126 fails the PR gate in seconds rather than burning operator-days in triage.

## Goals

- Every cross-subsystem contract has a deterministic test at the scope where it can break, with cassette-replayed L2 coverage of the Spawn ↔ Steward boundary delivered by M-C and the Hatchery L1 gap closed by M-D (operationalizes the strategy doc's *tests are the contract* principle).
- Every subsystem boundary the harness depends on at runtime has an explicit, freshness-checked contract artifact under `docs/subsystems/<name>/contract.md` that L2/L3 tests assert against, delivered by M-B before cassette-backed tests land in M-C (operationalizes *contracts are explicit artifacts*).
- The harness is tested deterministically end-to-end via cassette replay — including the first L3 vertical slice lifted from `tests/Agent.tests.md` A1 — with cassette infrastructure delivered by M-C, generalized by M-E, and exercised at L3 by M-G (operationalizes *deterministic core, stochastic edge*).
- Every test in the suite fails loudly within a bounded budget: L0 runs first as the fail-fast gate, L1/L2/L3-cassette run in parallel on L0 pass, and stochastic tests carry explicit `pass^k` thresholds with a one-week quarantine rule enforced by tooling delivered in M-A and M-F (operationalizes *fail loud, fail fast*).
- The PR gate stays at $0 with no live backend reachable from `npm test` or staged CI, while a weekly scheduled stochastic suite calls real backends behind a token budget gate with pre-flight cost estimation and structured cost-summary publishing, delivered by M-F (operationalizes *cost is a first-class budget*).

## Out of Scope

- Eval rubrics and per-scenario `pass^k` thresholds for agent output quality — deferred to a future Smithy spec under M-F or later; this RFC commits to the metric shape but not the numeric thresholds.
- Production observability and SLOs — lives in operations-doc territory, not in the testing framework.
- Smithy-side testing — `smithy test` covers slice-level test plans for individual specs and remains the authoritative Smithy-side surface; this RFC is March's harness-side complement, not a replacement.
- TTY-only H1–H2 tests in `tests/Manual.tests.md` — readline TTY behavior is genuinely human-test territory and stays as-is; this RFC does not propose automating them.
- Framework reselection — vitest for L0/L1 and Cucumber.js (`@cucumber/cucumber`) for L2/L3 are locked by `docs/testing-strategy.md` §5 and §7; revisiting that choice is explicitly out of scope for every milestone in this RFC.
- Herald implementation itself — M-H consumes Herald to convert real run traces into cassettes, but the Herald subsystem is built by its own RFC; M-H is Blocked on Herald and ships no Herald code.
- Rewriting existing L0/L1 tests — M-A tags them in place per the gap-analysis baseline migrated from strategy §8; no test file is restructured, ported, or rewritten under this RFC unless it is being re-labeled across scopes (e.g., a vitest L2 growing into a Cucumber.js L2 scenario in a later milestone).
- Re-deriving the strategy doc's principles, taxonomy, or cassette pivot — those remain authoritative in [`docs/testing-strategy.md`](../../testing-strategy.md) §2–§4; this RFC consumes them as inputs and commits only to sequencing, milestones, and per-milestone exit criteria.

## Personas

**The Operator** — A solo technical operator who is hands-on with code, owns the entire testing surface, and has no second pair of eyes to catch a stalled session, a silently-failing harness, or a backend that has quietly drifted out of contract. The same human plays four distinct roles against the test suite over the course of a week, and this RFC names each one explicitly so the per-milestone exit criteria can be tied to the moment that role becomes tractable. The framing is inherited directly from [RFC 2026-001](../2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md): one human in the loop, no team rotation, no review buddy. Codex and Claude agents act as secondary test authors when Smithy dispatches them, but the human Operator owns every decision about what gets tested, at what layer, and what a failure means.

### The Operator as Test Author

In this mode the Operator is sitting down to write a new test — usually because a feature spec calls for one or because a bug surfaced a missing assertion. They need to pick a scope (L0, L1, L2, or L3) and a framework (vitest or Cucumber.js) without re-deriving the taxonomy from first principles every time. Today, every cross-subsystem test requires inventing scaffolding from scratch — there is no L2 cassette harness to write against, so the test either does not get written or gets written as a brittle L1 with mocks that lie. This RFC gives the Test Author per-scope playbooks and locked framework choices, so the question collapses from "how do I even structure this?" to "which playbook applies?"

### The Operator as CI Failure Triager

In this mode the Operator is looking at a red PR check and needs to know, within seconds, what layer failed and what signal that failure represents. Today every test runs in one `npm test` bucket, so a red build is a black box requiring manual log archaeology to distinguish an L0 invariant violation from an L3 scenario regression. This RFC's staged CI workflow makes the failure layer obvious by construction: L0 invariants fail in seconds with a tight diff, L3 scenario failures fail differently and later, and the Triager can read the failure stage off the pipeline rather than the logs.

### The Operator as Cassette Refresher

In this mode the Operator is responding to a scheduled-suite drift failure — the real backend has moved, the cassette no longer matches, and someone has to decide whether the move was benign (re-record and commit the cassette diff) or whether it broke a contract (fix the harness or escalate). Today there is no record/replay tooling, no quarantine flow, and no explicit policy for what a cassette-diff PR even looks like, so drift either goes undetected or gets handled silently in a way that erodes the suite's trustworthiness. This RFC commits to a refresh-as-PR policy with PR templates, a quarantine workflow, and an explicit triage path, so the Refresher has a named procedure rather than an ad-hoc judgment call every time.

### The Operator as Scheduled-Suite Signal Reviewer

In this mode the Operator is reading the weekly stochastic-suite report — token cost, wall-clock per scenario, pass/fail trend — and deciding whether the real backend's behavior still matches the contract the cassettes encode. Today there is no scheduled suite at all, so the first signal that backend behavior has drifted arrives as a production incident rather than a Monday-morning report. This RFC delivers structured cost-summary publishing, a budget gate with overrun alerts, and an observable drift trend, so the Signal Reviewer can spot a backend moving out of contract while it is still cheap to respond.

## Proposal

This RFC commits March to a layered testing framework whose architecture is the **two-axis taxonomy** — scope (L0 unit, L1 subsystem, L2 cross-subsystem, L3 system) crossed with determinism (deterministic vs. stochastic) — concretized at the runner level via the test tags `@l0`, `@l1`, `@l2`, `@l3`, `@deterministic`, `@stochastic`, `@ci`, `@scheduled`. The tag vocabulary is the schema the entire harness keys on: CI job definitions, the `test:l0` / `test:l1` / `test:l2-cassette` / `test:l3-cassette` script split, the staged-pipeline gating rules, and the freshness checks all read these labels rather than file-path heuristics. M-A defines and applies the tags in place against today's vitest suite (per the gap-analysis baseline migrated from strategy §8) and wires the **staged CI workflow** as an extension of `.github/workflows/ci.yml`: L0 runs first as the fail-fast gate, then L1, cassette-replayed L2, and cassette-replayed L3 run in parallel on L0 pass, with the weekly **scheduled stochastic suite** carrying its own workflow for live-backend cassette-drift detection.

The load-bearing integration primitive is the **cassette substrate** — a record/replay engine, on-disk format, layout under `tests/cassettes/`, and redaction pipeline that turns previously stochastic backend exchanges into deterministic fixtures (per [`docs/testing-strategy.md`](../../testing-strategy.md) §4). M-C delivers cassette format v0 as a hard-capped proof-of-concept — one cassette, one `.feature` file, one concurrency variant — exercising the Spawn ↔ Steward handoff in `src/hatchery/spawn-handoff.ts`, which is the exact PR #126 hotspot. M-E generalizes the format with real consumer signal from M-C and M-D, and M-F adds **recording mode** to the scheduled suite where drift is most often detected. Three additional substrate primitives — the **throwaway-repo factory** (the shared L2/L3 fixture for git state), **deterministic Docker image pinning** by digest with an explicit refresh policy, and the **Cucumber.js step-definition library** shared across L2 and L3 — are owned in one place and stood up alongside the M-C cassette work so M-G's first L3 vertical slice (lifted from `tests/Agent.tests.md` A1) consumes the same scaffolding rather than re-inventing it.

Operationally, the framework commits to making cost, drift, and freshness visible by construction rather than by operator vigilance, per the behavior contract in [`docs/operating-philosophy.md`](../../operating-philosophy.md). The **cost tooling** (M-F) includes a pre-flight estimator that prints projected spend before a scheduled run invokes any backend, plus a structured per-run cost summary published to the GitHub Actions job summary and appended to `tests/cost-history.jsonl` for trend observation. The **cassette-refresh workflow** (M-F) turns drift response into an explicit reviewed PR with templates, issue templates, and a documented triage policy — never a silent re-record. The **quarantine suite** (M-A tooling, exercised from M-F onward) runs as a separate CI job with a one-week resolution SLA and a visible state; tests that exceed their `pass^k` budget move there but are never silenced. **Per-subsystem contract documentation** at `docs/subsystems/<name>/contract.md` (M-B) provides the explicit artifacts that L2/L3 tests assert against — covering Spawn, Hatchery, Brood, Herald-stub, Legate, and Steward — backed by a CI freshness check that flags when a subsystem's public surface changes without a corresponding contract-doc update.

In the same PR that lands this RFC, `docs/testing-strategy.md` shifts to a strategic-only companion: §8 (Gap analysis), §9 (Roadmap), and the operational specifics of §6 (staged-workflow gating, cassette-refresh policy, quarantine rule, cost-visibility publishing) migrate into this RFC where they become committed sequencing tied to milestone exit criteria. The principles authority — §2, §3, §4, §5 rationale, §6 principles, §7, and §10 — stays in the strategy doc as the long-lived companion this RFC cites rather than restates.

## Design Considerations

- **The tag vocabulary defined in M-A is the most consequential schema decision in the RFC.** Every downstream milestone's CI wiring, script split, quarantine routing, and freshness check keys on these labels, and renaming a tag after M-B is a workflow-wide migration. Milestone-spec authors after M-A should treat the tag set as a frozen vocabulary and extend by addition only — never repurpose `@deterministic` to also mean "cassette-replayed", and never let scope and determinism collapse into a single tag for convenience.
- **Cassette format v0 in M-C is a one-way door once cassettes are checked into `tests/cassettes/` and PRs start referencing them in diffs.** The M-C spec should pick the simplest viable format (the working assumption is raw JSONL HTTP capture with a redaction pass for API keys, auth headers, and token-shaped strings) and explicitly defer schema generalization to M-E, where real consumer signal from M-C and M-D inform the design. The M-E spec then owns the migration story — including whether v0 cassettes are re-recorded or transformed in place. M-C's spec is not the place to design format extensibility; that is M-E's job.
- **Throwaway-repo factory and deterministic Docker image pinning are substrate, not cassette concerns.** They are prerequisites for any L2 test, deterministic or stochastic, and must not be designed inside the cassette spec or scoped only to cassette-backed scenarios. M-C's spec needs both, but milestone-spec authors should treat them as separately ownable primitives whose interface should remain usable from a future non-cassette L2 test (e.g., a Brood-only L2 with no backend exchange at all). The Docker pinning refresh cadence is also a separable policy decision that should not be entangled with the cassette-refresh cadence.
- **The Cucumber.js step-definition library is a shared dependency between L2 (M-C) and L3 (M-G).** Designing it once in M-C and reusing it in M-G avoids re-invention, but it also means M-C's spec carries a forward-compatibility responsibility it would not otherwise have: step definitions written for the first Spawn ↔ Steward scenario must be shaped so a later L3 scenario that drives the full Legate loop can compose them. Milestone-spec authors should resist baking M-C-specific assumptions (e.g., single container, single subsystem boundary) into the step-definition surface.
- **M-C is a proof-of-concept milestone with a hard-capped scope: one cassette, one `.feature` file, one concurrency variant.** Anything that wants to be "while we're in here" is M-E. Milestone-spec authors writing M-C should treat scope creep as the primary risk to delivery — a second cassette, a second scenario, or a generalized format design all belong in M-E even when they look cheap from inside M-C.
- **The three existing vitest L2 tests — `src/spawn/snapshot-build.test.ts`, `src/spawn/container-launch.test.ts`, `src/hatchery/legate-container.test.ts` — get a "Cucumber-on-first-material-change" migration policy, not a preemptive port.** They are L2-shaped in the gap-analysis baseline but stay in vitest until the next material change touches them, at which point the change PR ports them to Cucumber.js. M-A's spec must define what "material change" means precisely enough that PR authors and reviewers do not relitigate it on every diff.
- **`src/hatchery/spawn-handoff.ts` — the M-C cassette target — is provisional code per [RFC 2026-001](../2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md).** Cassettes recorded against its current shape may need refresh if Steward is formalized into a distinct subsystem. M-C's spec should accept this as a known risk and document the expected refresh path; it is not a reason to delay M-C until Steward is formalized, because the proof-of-concept value of the first L2 vertical slice exceeds the cost of one cassette re-record.
- **The Operator is the sole human in the loop and every runner must be non-interactive** per [`docs/operating-philosophy.md`](../../operating-philosophy.md) rule 1. Milestone-spec authors must reject any cassette-recording flow, scheduled-suite invocation, or quarantine-triage tool that expects an interactive prompt — every operation must run unattended from CI or from a single non-interactive command on a dev box. Cassette recording in particular must not depend on a TTY-bound `y/N` confirmation.
- **Quarantine is a visible state with an SLA, not a hiding place.** The one-week resolution clock is the commitment that keeps the suite trustworthy. M-A's spec defines the quarantine tooling and M-F's spec wires the SLA timer and overrun escalation; both must treat "silence the failing test" as out-of-bounds. Milestone-spec authors should design the quarantine routing so the cost of moving a test there is bounded (cheap) but the cost of leaving it there past SLA is loud (alert, dashboard, blocked release).
- **Recording mode lives in M-F with the scheduled suite, not in M-C.** M-C is replay-only against a hand-recorded or hand-authored v0 cassette. This sequencing decision means the M-C spec does not own a recording UX, and the M-F spec inherits a real consumer (the scheduled suite catching drift) rather than designing recording in the abstract. The temptation to bundle recording into M-C "since we're touching the cassette code anyway" should be resisted.
- **The $0 PR gate is non-negotiable.** No live backend is reachable from `npm test` or from any staged CI job. Every milestone spec must verify its design preserves this — including M-F, whose scheduled suite must run on a separate workflow with its own credentials boundary so a misconfigured PR cannot accidentally invoke it. The pre-flight cost estimator is part of the defense-in-depth here, not a substitute for workflow isolation.
- **Cucumber.js parallelism characteristics are unknown relative to vitest's worker model, and Codex vs. Claude auth-shape divergence will affect the cassette redaction pipeline.** M-C's spec must measure Cucumber.js parallel-worker behavior against the L0/L1 vitest baseline before committing to a parallelism strategy in the staged CI workflow, and the redaction pipeline must be designed against both backends' auth-header shapes rather than a single one — M-E's format generalization should treat redaction-rule pluggability as a first-class concern, not an afterthought.

## Decisions

- **Framework choice per scope is locked.** vitest for L0 and L1; Cucumber.js (`@cucumber/cucumber`) for L2 and L3. Settled in [`docs/testing-strategy.md`](../../testing-strategy.md) §5 and §7 with explicit rationale against `@amiceli/vitest-cucumber` (ecosystem too thin) and `jest-cucumber` (we don't use Jest). This RFC does not reopen the choice; each milestone spec inherits it.
- **Stochastic-suite framework is PromptFoo.** The M-F scheduled suite uses **PromptFoo** (`promptfoo`) as the eval runner — TypeScript-native, CI-first, config-in-repo, npm-installable, no external runtime. Settled in [`docs/testing-strategy.md`](../../testing-strategy.md) §5 and §7 with explicit rationale against Phoenix (Arize) — Python-first, heavier infrastructure, optimized for notebook + online tracing rather than CI eval — and Braintrust (hosted; inconsistent with the strategy's OSS self-hostable posture). Phoenix may be revisited if a future RFC adopts it as a unified production AI-flow tracing platform, but eval framework choice for M-F is not blocked on that decision.
- **The PR gate stays at $0.** No live-backend invocation is reachable from `npm test`, the four `test:l*` scripts, or any staged CI job. Live backends run only from the M-F scheduled workflow on its own credentials boundary.
- **Milestones are vertical slices, not horizontal phases.** Each milestone (M-A through M-H) delivers an end-to-end working capability rather than building one infrastructure layer to completion before the next begins. Selected over a six-milestone horizontal restating of the strategy's phase list because vertical slicing forces the cassette format to be shaped by a real consumer (M-C) and unlocks concurrent M-A∥M-B and M-C∥M-D work.
- **`docs/testing-strategy.md` shifts to strategic-only in the same PR as this RFC.** §8 Gap analysis, §9 Roadmap, and the operational specifics of §6 (staged-workflow gating, cassette-refresh policy, quarantine rule, cost-visibility publishing) migrate into this RFC. The strategy doc keeps §2 Principles, §3 Two-axis taxonomy, §4 Cassette pivot, §5 framework rationale, §6 cost-policy principles, §7 Named exemplars, and §10. Bidirectional cross-links.
- **Contract documentation lives at `docs/subsystems/<name>/contract.md`.** One file per subsystem (Spawn, Hatchery, Brood, Herald-stub, Legate, Steward). M-B creates the tree; freshness CI check flags subsystem-source changes lacking a contract-doc update.
- **Cassettes live at `tests/cassettes/`.** Checked into the repo; refresh is an explicit reviewed PR with a PR template and a triage policy; never a silent re-record.
- **Tag vocabulary is fixed at M-A: `@l0`, `@l1`, `@l2`, `@l3`, `@deterministic`, `@stochastic`, `@ci`, `@scheduled`.** Extension by addition only — never repurpose an existing tag. CI workflow definitions, script splits, quarantine routing, and freshness checks all key on these labels rather than file-path heuristics.
- **CI workflow extends `.github/workflows/ci.yml` rather than creating a parallel workflow file** for the staged PR-gate pipeline. The M-F scheduled stochastic suite lives in a separate workflow with its own trigger and credentials boundary.
- **Staged CI shape: L0 runs first as the fail-fast gate; L1 + cassette-replayed L2 + cassette-replayed L3 run in parallel on L0 pass.** Wall-clock budget is "minutes, not tens of minutes," bounded by the slowest staged gate.
- **Scheduled stochastic suite cadence is weekly.** Cadence is a knob, not a commitment — tighten or loosen based on observed drift signal — but the initial commit is weekly per [`docs/testing-strategy.md`](../../testing-strategy.md) §6.
- **Quarantine SLA is one week.** A stochastic test that exceeds its `pass^k` budget moves to a quarantine suite within one week and must be resolved (re-recorded, fixed, or deleted) within one week of quarantine. Visibility, not silence.
- **Cassette recording mode lives in M-F, not M-C.** M-C is replay-only against a hand-prepared v0 cassette. Recording is most needed when drift is detected — co-locating it with the drift-detector keeps the loop tight and prevents M-C from designing recording UX in the abstract.
- **The three existing vitest L2 tests (`src/spawn/snapshot-build.test.ts`, `src/spawn/container-launch.test.ts`, `src/hatchery/legate-container.test.ts`) get a "Cucumber-on-first-material-change" migration policy.** They are not preemptively ported; the next material change touching them is the trigger.
- **M-C scope is hard-capped at one cassette, one `.feature` file, one concurrency variant.** The concurrent-dispatch variant counts as one scenario with two execution modes (sequential and concurrent) sharing the same cassette, not as a second scenario — keeps the cap honest while delivering the race-coverage M-C exists for.
- **Cost-summary publishing target: GitHub Actions job summary + append-only `tests/cost-history.jsonl` committed by the scheduled workflow.** Herald-event integration is deferred to a follow-on once Herald lands.
- **M-D L1 Hatchery gap-fill has no hard dependency on M-B contract docs.** M-D writes tests against the current public TypeScript surface; the Hatchery `contract.md` is drafted concurrently in M-B and the tests retro-link to it.
- **M-H carries `Status: Blocked` on Herald (RFC 2026-001 M4 — Not started)** rather than being deferred to a backlog. Keeps the strategy commitment visible without overpromising sequencing; status flips to `In progress` once Herald M4 reaches `Done`.

## Open Questions

- **Should the staged CI workflow gate L2-cassette and L3-cassette on L1 pass as well, or only on L0?** The current decision is "L0 fail-fast, then L1∥L2-cassette∥L3-cassette in parallel," but if Cucumber.js parallel-worker behavior turns out to interact badly with vitest workers running concurrently, the gating shape may need to revert to "L0+L1 gate, then L2-cassette∥L3-cassette." M-A's spec measures the interaction and decides.
- **Where does cassette refresh code live — in `src/testing/` (treated as production code) or `tests/support/` (treated as test-only code)?** Cassette tooling is testing infrastructure but ships in operator-facing CLI verbs once it grows beyond M-C. M-A or M-C spec resolves.
- **Does the framework eventually grow a per-subsystem "smoke test" tier between L1 and L2** for "this subsystem starts up cleanly and exposes its public surface" without crossing a subsystem boundary? Not in scope for any current milestone, but the taxonomy may need a fifth scope label if M-D's Hatchery work surfaces the need. Revisit after M-D.
- **How does this RFC coordinate with a future `smithy test` integration on the Smithy side?** Strategy doc §10 declares Smithy-side testing out of scope, but the per-slice test plans Smithy generates and the per-scope tests this framework runs share an output surface (passing tests, gating PRs). Coordination spec is deferred; this RFC just names that the coordination will eventually be needed.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Initial M-F token budget cap (USD per weekly run). Working recommendation: $5 soft cap with alert on overrun, $20 hard kill, revisit after four runs. No prior cost data exists. | clarify:Constraints | High | Medium | open | — |
| SD-002 | Contract-freshness CI mechanism: TypeScript AST diff against last-committed `contract.md` vs. Smithy-agent directive that flags drift on PR review. Recommendation: start with the Smithy-agent directive (low infra cost, fits operating philosophy of "Smithy decomposes; March executes") and add structural AST diff only if drift slips through. M-B spec resolves. | clarify:Risks | Medium | Medium | open | — |
| SD-003 | Cassette format v0 shape: JSONL HTTP capture (raw request/response pairs) vs. structured envelope (prompt + backend-typed response). Working assumption: JSONL HTTP at the proxy layer — survives backend SDK churn, matches `vcr-langchain` precedent. Codex credential-mount vs. Claude env-var split may force a higher-level envelope; M-C spec resolves. | clarify:Risks | High | Medium | open | — |
| SD-004 | Quarantine SLA escalation path when the operator misses the one-week deadline. Strategy §6 says "quarantine is a visible state, not a hiding place" but does not define day-8 behavior. Recommendation: weekly stochastic-suite report posts an "overdue quarantine" line item; no automated escalation beyond visibility (escalation-to-whom is undefined for a solo operator). M-F spec resolves. | clarify:Constraints | Medium | Medium | open | — |
| SD-005 | M-C must measure Cucumber.js parallel-worker behavior against the L0/L1 vitest baseline and commit a staged-CI parallelism strategy. The first Open Question (staged-gate shape — does L2/L3-cassette gate on L0 alone or also on L1) is the downstream decision that depends on this measurement. The Codex-vs-Claude redaction-shape divergence raised in Design Considerations bullet 12 is a related M-E concern that may require expanding SD-003 rather than a separate debt row. | plan-review:Debt completeness | Medium | Low | open | — |

## Milestones

### Milestone M-A: Test Legibility & Staged CI

**Description**: Make the existing test corpus legible by tagging every test file per the gap-analysis baseline migrated from strategy §8, split `npm test` into staged scripts that filter by tag, and restructure `.github/workflows/ci.yml` into a fail-fast L0 gate followed by parallel L1/L2/L3 cassette jobs. Day-one startable; no prerequisites.

**Success Criteria**:
- Every test file in the repo carries one scope tag from `{@l0, @l1, @l2, @l3}` and one determinism tag from `{@deterministic, @stochastic}` plus an execution-channel tag from `{@ci, @scheduled}`; tagging coverage verified by a CI lint that fails on untagged files.
- `package.json` declares four new scripts — `test:l0`, `test:l1`, `test:l2-cassette`, `test:l3-cassette` — each filtering by tag and exiting non-zero on any untagged-but-matched file.
- `npm test` remains as a local convenience alias that runs all four staged scripts in sequence and exits non-zero on the first failure.
- `.github/workflows/ci.yml` defines a `l0` job that runs first as a fail-fast gate, and three jobs `l1`, `l2-cassette`, `l3-cassette` that fan out in parallel on `l0` success; each job runs only its corresponding `npm run test:*` script.
- The "material change" policy for the three pre-existing vitest L2 tests is recorded in `CONTRIBUTING.md` under a "Test Layer Migration" heading and enumerates the triggering conditions verbatim.
- A `tests/quarantine/` directory plus a `quarantine.ts` (or equivalent) routing primitive exists; quarantined tests are excluded from the four staged scripts and listed in a generated `tests/quarantine/INDEX.md`. (SLA timer is wired in M-F.)
- `CONTRIBUTING.md` references the four staged scripts, the tag taxonomy, and the quarantine routing primitive; `docs/testing-strategy.md` is trimmed to strategic-only content in the same PR.

### Milestone M-B: Subsystem Contract Documentation Track

**Description**: Establish a per-subsystem contract-documentation track and a CI freshness check that flags public-surface drift. Concurrent with M-A — touches `docs/subsystems/**` and a new check, no dependency on M-A's CI plumbing.

**Success Criteria**:
- Six contract documents exist: `docs/subsystems/spawn/contract.md`, `docs/subsystems/hatchery/contract.md`, `docs/subsystems/brood/contract.md`, `docs/subsystems/herald-stub/contract.md`, `docs/subsystems/legate/contract.md`, `docs/subsystems/steward/contract.md`.
- Each `contract.md` contains three required sections — `## Public Interface`, `## Invariants`, `## Error Modes` — verified by a presence-check script.
- For each subsystem whose public surface is typed in TypeScript, the `## Public Interface` section includes an auto-extracted block delimited by `<!-- BEGIN AUTOGEN -->` / `<!-- END AUTOGEN -->`; the extraction tool is committed and runnable via `npm run docs:contracts:extract`.
- A `.github/workflows/contract-freshness.yml` job (or equivalent Smithy agent directive per SD-002) fails any PR that modifies a subsystem's public-source paths without touching the corresponding `contract.md`; the mapping of source globs to contract paths lives in `docs/subsystems/contract-freshness.config.json`.
- Running `npm run docs:contracts:check` locally reproduces the CI freshness verdict.

### Milestone M-C: First L2 Vertical Slice — Spawn → Steward

**Description**: Land one end-to-end L2 cassette-driven Cucumber.js slice exercising the Spawn → Steward handoff in both sequential and concurrent modes, and establish the cassette format v0, throwaway-repo factory, and Docker pinning policy that downstream milestones generalize. Depends on M-A (staged CI to land in) and M-B (Spawn + Steward contracts to assert against).

**Success Criteria**:
- `docs/testing/cassette-format-v0.md` records the JSONL HTTP capture format, the redaction pass rules for API keys, auth headers, and token-shaped strings, and the file layout under `tests/cassettes/`.
- A throwaway-repo factory utility exists at `tests/support/throwaway-repo.ts` (or equivalent) and is exercised by at least one test that asserts a freshly-seeded repo is produced per invocation.
- `docs/testing/docker-pinning-policy.md` documents digest-locked base images; at least one image referenced by the L2 slice is pinned by SHA-256 digest and the digest is checked into the repo.
- Exactly one cassette file exists at `tests/cassettes/spawn-steward/handoff.jsonl` capturing a real Spawn → Steward exchange against `src/hatchery/spawn-handoff.ts`.
- Exactly one feature file exists at `tests/l2/spawn-steward.feature` with two scenarios — sequential dispatch and concurrent dispatch — both replaying the single cassette.
- A Cucumber.js step-definition library lives under `tests/l2/steps/` with a documented composition contract (`tests/l2/steps/README.md`) describing how M-G's L3 scenarios reuse the same steps.
- `npm run test:l2-cassette` executes the slice green in under 30 seconds with no network egress (verified by a network-deny wrapper).

### Milestone M-D: L1 Gap-Fill (Hatchery)

**Description**: Close the highest-priority L1 gap identified in the gap-analysis baseline migrated from strategy §8 by writing vitest L1 tests for Hatchery's public surface, and sweep any other L1 holes surfaced by M-A's tagging pass. Concurrent with M-C — vitest vs. Cucumber, different files, no cassette dependency. Depends on M-A only.

**Success Criteria**:
- New vitest L1 test files under `src/hatchery/` cover (a) profile-policy schema validation, (b) environment material assembly, and (c) credential-mount spec validation; one named test file per concern.
- Each new test file is tagged `@l1 @deterministic @ci` and is picked up by `npm run test:l1`.
- The L1 suite for `src/hatchery/` grows by at least 20 new test cases relative to the pre-milestone baseline, recorded in the PR description against `npm run test:l1 -- --reporter=verbose` output.
- Any additional L1 holes flagged by M-A's tagging pass are either closed in this milestone or filed as tracked issues referenced from `docs/testing/l1-gap-backlog.md`.
- `npm run test:l1` runs green in CI's `l1` job introduced by M-A.

### Milestone M-E: Cassette Infrastructure Generalization

**Description**: Generalize the cassette substrate informed by M-C and M-D consumer signal, add redaction-rule pluggability for Codex vs. Claude divergence, and land two additional L2 scenarios that exercise the generalized substrate. Depends on M-C (real consumer signal) and M-D (vitest-L1 contract surface for non-cassette comparison).

**Success Criteria**:
- `tests/support/cassette/` contains a versioned cassette runtime with an explicit `FORMAT_VERSION` constant; `docs/testing/cassette-format.md` supersedes the v0 doc and records the v0 → vNext migration story.
- Redaction rules are pluggable: `tests/support/cassette/redactors/` contains separate `codex.ts` and `claude.ts` redactor modules, both registered through a single registry, with unit tests asserting each redacts its respective auth-shape.
- A cassette-refresh PR template exists at `.github/PULL_REQUEST_TEMPLATE/cassette-refresh.md` and a triage policy is documented at `docs/testing/cassette-refresh-triage.md` (consumed by M-F's scheduled suite).
- A second L2 scenario exists at `tests/l2/brood-spawn.feature` with cassette `tests/cassettes/brood-spawn/dispatch.jsonl`.
- A third L2 scenario exists at `tests/l2/hatchery-materialization.feature` with cassette `tests/cassettes/hatchery-materialization/profile.jsonl`.
- `npm run test:l2-cassette` executes all three L2 scenarios green in CI's `l2-cassette` job in under 60 seconds.

### Milestone M-F: Scheduled Stochastic Suite + Recording Mode + Cost/Quarantine Tooling

**Description**: Stand up the weekly scheduled stochastic workflow that calls live backends on a separate credentials boundary, with cost-estimation pre-flight, hard/soft budget gates, cassette-recording mode, and quarantine SLA enforcement. Depends on M-C (at least one recorded scenario to drift-check against) and M-E (generalized cassette infrastructure to write into).

**Success Criteria**:
- `.github/workflows/scheduled-stochastic.yml` exists with a weekly `schedule:` trigger and references a secrets context (e.g., `secrets.STOCHASTIC_*`) disjoint from the PR-gate workflows; a CI lint enforces that no PR-gate workflow references those secret names.
- A pre-flight cost estimator runs as the first step of the workflow and prints a projected-spend block to the job log before any backend call is made.
- A token-budget gate enforces a soft cap and a hard kill (initial defaults per the SD-001 working recommendation: $5 soft alert, $20 hard kill; revisited after four scheduled runs) configured via repository variables; exceeding the hard cap fails the job and aborts further backend calls.
- A PromptFoo configuration file at `tests/stochastic/promptfoo.yaml` declares the M-F scenarios — each tagged `@stochastic @scheduled` — including provider configs for Codex and Claude, `pass^k` retry counts, deterministic assertion checks (schema validity, presence of required fields), and any LLM-as-judge graders. A `test:stochastic` script in `package.json` invokes `promptfoo eval` against that config; the scheduled workflow calls `npm run test:stochastic`.
- A `--record` mode for the cassette runtime produces new cassette files under `tests/cassettes/` and is invoked by the workflow when drift is detected against M-C's recorded scenario.
- `.github/PULL_REQUEST_TEMPLATE/cassette-refresh.md` (from M-E) and a new `.github/ISSUE_TEMPLATE/cassette-refresh.yml` are wired into the workflow's drift-detection handler.
- Quarantine SLA wiring enforces a 7-day clock against entries in `tests/quarantine/INDEX.md`; overdue items appear in the workflow's weekly report and in the job summary.
- A structured cost summary is written to `$GITHUB_STEP_SUMMARY` and appended to `tests/cost-history.jsonl` (one JSON object per run); the workflow commits the updated history file back to the repo. PromptFoo's per-run output (token counts, latency per provider) feeds the summary rather than being a separate publishing path.

### Milestone M-G: L3 Vertical Slice

**Description**: Deliver the first runnable L3 feature derived from `tests/Agent.tests.md` A1, replaying cassettes for every backend exchange in the Legate loop, reusing M-C's step-definition library. Depends on M-E (generalized cassette infra for multi-backend scenarios), M-D (Hatchery L1 must hold the boundary M-G's L3 scenarios cross), and M-C (step-definition library M-G reuses under `tests/l2/steps/`).

**Success Criteria**:
- A feature file exists at `tests/l3/agent-a1.feature` whose scenarios are a direct, traceable derivation of scenario A1 in `tests/Agent.tests.md` (cross-references recorded in the feature file's `# Source:` header).
- L3-specific orchestration helpers live under `tests/l3/steps/` and import and reuse the step-definition library produced by M-C under `tests/l2/steps/`.
- All backend exchanges in the Legate loop for scenario A1 are replayed from cassettes under `tests/cassettes/l3/agent-a1/`; a network-deny wrapper around the run asserts zero outbound calls.
- The L3 feature file is tagged `@l3 @deterministic @ci` and runs in CI's `l3-cassette` job via `npm run test:l3-cassette`.
- `npm run test:l3-cassette` runs green in under 90 seconds.

### Milestone M-H: Herald-Enabled Trace-as-Fixture

**Description**: Build the pipeline that consumes Herald events to convert a captured production trace into a new cassette, and land the first L3 regression test fed by such a cassette. **Blocked on Herald (RFC 2026-001 M4 — Not started)**; depends on M-G (an L3 cassette consumer must exist) and Herald M4.

**Success Criteria**:
- A trace-to-cassette tool exists (e.g., `tools/trace-to-cassette/`) that subscribes to Herald events and emits cassette files conforming to the M-E format under `tests/cassettes/from-trace/`.
- At least one cassette in `tests/cassettes/from-trace/` was generated by the tool from a real captured production trace; the source trace ID is recorded in a sidecar `*.provenance.json` file.
- A new L3 regression test under `tests/l3/` consumes that cassette and runs green in `npm run test:l3-cassette`.
- The pipeline is documented at `docs/testing/trace-as-fixture.md` including the redaction guarantees applied during conversion.

## Dependency Order

| ID  | Title                                                                       | Depends On                  | Artifact |
|-----|-----------------------------------------------------------------------------|-----------------------------|----------|
| M-A | Test Legibility & Staged CI                                                 | —                           | —        |
| M-B | Subsystem Contract Documentation Track                                      | —                           | —        |
| M-C | First L2 Vertical Slice — Spawn → Steward                                   | M-A, M-B                    | —        |
| M-D | L1 Gap-Fill (Hatchery)                                                      | M-A                         | —        |
| M-E | Cassette Infrastructure Generalization                                      | M-C, M-D                    | —        |
| M-F | Scheduled Stochastic Suite + Recording Mode + Cost/Quarantine Tooling       | M-C, M-E                    | —        |
| M-G | L3 Vertical Slice                                                           | M-C, M-D, M-E               | —        |
| M-H | Herald-Enabled Trace-as-Fixture                                             | M-G, RFC 2026-001 M4        | —        |
