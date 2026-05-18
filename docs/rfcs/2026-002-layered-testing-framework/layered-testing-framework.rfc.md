# RFC: Layered Testing Framework

**Created**: 2026-05-17  |  **Status**: Draft

## Summary

This RFC commits March to a two-axis test taxonomy — scope (L0–L3) crossed with determinism (deterministic vs. stochastic) — and to a cassette-replayed integration tier that makes cross-subsystem coverage affordable on a $0 PR gate. Execution is sequenced across eight vertical-slice milestones (M-A through M-H), each delivering an end-to-end working capability with explicit exit criteria. The strategy doc at [`docs/testing-strategy.md`](../../testing-strategy.md) remains the long-lived principles companion; this RFC is the commitment, sequencing, and per-milestone success criteria that turn those principles into shipped infrastructure.

## Motivation / Problem Statement

PR #126 surfaced four production bugs in a single review cycle, and every one of them was diagnosed the same way: the operator noticed nothing was happening, hours or days after the failure mode started. The Hatchery runner script had been syntactically invalid for months — every spawn silently failed on a `node -e` line-break escape, and the operator only caught it by inspecting a stalled session by hand. `launchAgentDeckManager` carried a race condition that let three concurrent dispatches attach to the same wrong session. The Legate loop's escalation path never notified the agent, so state.json piled up while the agent sat idle for 30+ hours. Stale stub archives silently blocked fresh dispatches. Each of these maps cleanly to a missing layer of automated coverage that would have caught the failure in seconds rather than days.

The cost is paid in operator time, and the operator is the sole human in the loop. There is no second pair of eyes to notice a stalled session faster; there is no team rotation absorbing the triage load. Every hour spent reconstructing "why did nothing happen between Tuesday and Thursday" is an hour not spent moving March forward. The four PR #126 incidents alone consumed enough manual triage to motivate this RFC — and they are not anomalies. They are the predictable output of a harness that has grown by accretion, where contracts between subsystems are tested implicitly (or not at all) until something breaks loudly enough that the operator notices.

This is the right time to commit to the framework because three structural pressures from [`docs/testing-strategy.md` §1](../../testing-strategy.md#1-why-this-strategy-exists) are all compounding at once. The subsystem count keeps growing — Spawn, Hatchery, Brood, Herald, Legate, Steward — and the interesting failures happen *between* subsystems, exactly where coverage is thinnest. Determinism and stochasticity now mix inside the same workflows, and tests that conflate the two either lie or break. Stochastic tests against real backends cost money and wall-clock that the PR gate cannot absorb. PR #126 was the forcing function: it surfaced the failure class all at once, and every incident traced to the same missing layer — cassette-replayed cross-subsystem coverage.

Other roles the Operator plays (named in §Personas) are blocked by the same gap. As test author, there is no L2 scaffolding to write against — the first Spawn → Steward handoff test cannot exist until cassette infrastructure does. As CI failure triager, there is no staged pipeline that fails fast on L0 invariants before burning wall-clock on L3; today every test runs in one `npm test` bucket. As cassette refresher, there is no record/replay tooling, no quarantine flow, no cost visibility. As scheduled-suite signal reviewer, there is no scheduled suite at all — cassette-drift detection has nowhere to live. Each of these is a workflow the Operator already performs ad-hoc; the framework names them, sequences the infrastructure that makes them tractable, and ties the per-milestone exit criteria to the moment each one becomes real.

This RFC is a sibling to [2026-001](../2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md) and inherits the same operator model and intervention-avoidance contract defined in [`docs/operating-philosophy.md`](../../operating-philosophy.md) — in particular [rule 3](../../operating-philosophy.md#3-failures-are-clean-exits-not-hangs), which the PR #126 incidents violated structurally by letting stalls become hangs the operator had to discover by hand.

The goal: a harness where every cross-subsystem contract has a deterministic test at the scope where it can break, a scheduled suite holds the line against backend drift, and an incident like any of the four from PR #126 fails the PR gate in seconds rather than burning operator-days in triage.

## Goals

- **Every cross-subsystem contract has a deterministic test at the scope where it can break.** Operationalizes the strategy doc's *tests are the contract* principle.
- **Every subsystem boundary the harness depends on at runtime has an explicit, freshness-checked contract artifact** that L2/L3 tests assert against, at a stable documented location. Operationalizes *contracts are explicit artifacts*.
- **The harness is tested deterministically end-to-end via cassette replay**, with stochastic tests reserved for what live backends actually produce. Operationalizes *deterministic core, stochastic edge*.
- **Every test fails loudly within a bounded budget**: cheap invariants fail fast in CI, integration coverage runs in parallel, and stochastic flakes get a quarantine clock instead of a silent skip. Operationalizes *fail loud, fail fast*.
- **The PR gate stays at $0 with no live backend reachable**, while live-backend coverage runs on a schedule behind a budget gate with observable cost. Operationalizes *cost is a first-class budget*.

## Out of Scope

- **Production observability and SLOs** — operations-doc territory, not the testing framework.
- **Production AI-flow observability** (Langfuse/Phoenix/Braintrust-style traces of live agent usage feeding back into operator dashboards) — a separate concern from CI eval; deferred to a future trace-RFC, not part of this framework.
- **Distributed-system traces** (OpenTelemetry-style instrumentation across containers) — deferred to a future RFC; not part of this framework.
- **Smithy-side testing** — `smithy test` covers slice-level test plans for individual specs and remains the authoritative Smithy-side surface; this RFC is March's harness-side complement, not a replacement.
- **TTY-only H1–H2 tests in `tests/Manual.tests.md`** — readline TTY behavior is genuinely human-test territory and stays as-is; this RFC does not propose automating them.
- **Framework reselection** — vitest for L0/L1, Cucumber.js for L2/L3, and PromptFoo for the stochastic suite are locked by `docs/testing-strategy.md` §5 and §7; revisiting that choice is out of scope here.
- **Herald implementation itself** — M-H consumes Herald events to feed regression cassettes, but the Herald subsystem is built by its own RFC; M-H is Blocked on Herald and ships no Herald code.
- **Rewriting existing L0/L1 tests** — they are tagged in place, not restructured, unless a later milestone re-labels one across scopes.
- **Re-deriving the strategy doc's principles, taxonomy, or cassette pivot** — those remain authoritative in [`docs/testing-strategy.md`](../../testing-strategy.md) §2–§4; this RFC consumes them as inputs.

(Items that are *deferred* rather than out-of-scope — eval rubrics, specific budget caps, freshness-check mechanism, cassette format internals — live in §Specification Debt below as named-and-tracked open work, not here.)

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

The framework has three load-bearing primitives — the **two-axis taxonomy**, the **cassette substrate**, and the **staged CI workflow** — plus supporting concerns (contract documentation, quarantine routing, cost tooling, cassette refresh) that the milestones below realize in sequence.

The **two-axis taxonomy** is scope (L0 unit, L1 subsystem, L2 cross-subsystem, L3 system) crossed with determinism (deterministic vs. stochastic), concretized at the runner level via the test tags `@l0`, `@l1`, `@l2`, `@l3`, `@deterministic`, `@stochastic`, `@ci`, `@scheduled`. The tag vocabulary is the schema the entire harness keys on: CI job definitions, the `test:l0` / `test:l1` / `test:l2-cassette` / `test:l3-cassette` script split, the staged-pipeline gating rules, and the freshness checks all read these labels rather than file-path heuristics.

The **cassette substrate** is the record/replay engine, the on-disk format under `tests/cassettes/`, the redaction pipeline that strips secrets before commit, the throwaway-repo factory primitive that seeds a fresh git repo per test, deterministic Docker image pinning by digest, and the Cucumber.js step-definition library shared between L2 and L3 scenarios. It turns previously stochastic backend exchanges into deterministic fixtures (per [`docs/testing-strategy.md`](../../testing-strategy.md) §4) — the lever that makes integration coverage affordable on a $0 PR gate. Format v0 lands as a hard-capped proof-of-concept against the Spawn ↔ Steward boundary (the PR #126 hotspot in `src/hatchery/spawn-handoff.ts`), then generalizes once real consumer signal is in.

The **staged CI workflow** is an extension of `.github/workflows/ci.yml`: L0 runs first as the fail-fast gate, then L1, cassette-replayed L2, and cassette-replayed L3 run in parallel on L0 pass. A separate weekly workflow runs the stochastic suite against live backends on its own credentials boundary, with a pre-flight cost estimator, soft/hard budget gates, structured cost-summary publishing to `tests/cost-history.jsonl` plus the GitHub Actions job summary, and the cassette-recording mode that closes the cassette-drift loop. The stochastic suite uses **PromptFoo** as its eval runner (configured at `tests/stochastic/promptfoo.yaml`); the deterministic side uses vitest for L0/L1 and Cucumber.js for L2/L3.

Two supporting concerns round out the framework. **Per-subsystem contract documentation** lives at `docs/subsystems/<name>/contract.md` — covering Spawn, Hatchery, Brood, Herald-stub, Legate, and Steward — with required sections for the public interface, invariants, and error modes, backed by a CI freshness check that flags public-surface changes shipping without a contract-doc update. L2 and L3 tests assert against these explicit contracts rather than implicit knowledge. **Quarantine tooling** routes failing stochastic tests to a separate suite under `tests/quarantine/` with a one-week resolution SLA and a visible state — tests that exceed their `pass^k` budget move there but are never silenced, and overdue items appear in the weekly stochastic-suite report.

In the same PR that lands this RFC, `docs/testing-strategy.md` is trimmed to strategic-only content. The principles authority — §2 Principles, §3 Two-axis taxonomy, §4 Cassette pivot, §5 framework rationale, §6 cost-policy principles, §7 Named exemplars, §8 scope — stays in the strategy doc as the long-lived companion this RFC cites rather than restates. The milestone-level sequencing, success criteria, and gap-analysis baseline of today's tests live here.

## Design Considerations

- **The tag vocabulary is the schema the entire harness keys on, so it is the most consequential schema decision in the framework.** Every CI workflow definition, script split, quarantine routing rule, and freshness check reads these labels, and renaming a tag once it is applied is a workflow-wide migration. Treat the tag set as a frozen vocabulary and extend by addition only — never repurpose `@deterministic` to also mean "cassette-replayed", and never let scope and determinism collapse into a single tag for convenience.
- **Cassette format v0 is a one-way door once cassettes are checked into `tests/cassettes/` and PRs start referencing them in diffs.** Pick the simplest viable format (the working assumption is raw JSONL HTTP capture with a redaction pass for API keys, auth headers, and token-shaped strings) and defer schema generalization to the milestone informed by real consumer signal. The generalization milestone owns the migration story — including whether v0 cassettes are re-recorded or transformed in place. The proof-of-concept slice is not the place to design format extensibility.
- **The throwaway-repo factory and deterministic Docker image pinning are substrate, not cassette concerns.** They are prerequisites for any L2 test, deterministic or stochastic, and must not be designed inside the cassette spec or scoped only to cassette-backed scenarios. Treat them as separately ownable primitives whose interface remains usable from a future non-cassette L2 test (e.g., a Brood-only L2 with no backend exchange at all). The Docker pinning refresh cadence is also separable from the cassette-refresh cadence.
- **The Cucumber.js step-definition library is a shared dependency between L2 and L3 scenarios.** Designing it once for the first L2 scenario and reusing it at L3 avoids re-invention, but it puts a forward-compatibility responsibility on the first scenario's design: step definitions must be shaped so a later L3 scenario driving the full Legate loop can compose them. Resist baking single-container or single-boundary assumptions into the step-definition surface — even when the first consumer would not notice.
- **The first L2 vertical slice is a proof-of-concept with a hard-capped scope: one cassette, one `.feature` file, one concurrency variant.** Anything that wants to be "while we're in here" belongs in the generalization milestone instead. Scope creep is the primary risk to delivery — a second cassette, a second scenario, or generalized format design all wait, even when they look cheap from inside the proof-of-concept.
- **Existing vitest L2 tests get a "Cucumber-on-first-material-change" migration policy, not a preemptive port.** They are L2-shaped in the gap-analysis baseline (specifically `src/spawn/snapshot-build.test.ts`, `src/spawn/container-launch.test.ts`, `src/hatchery/legate-container.test.ts`) but stay in vitest until the next material change touches them, at which point the change PR ports them to Cucumber.js. "Material change" needs a precise definition early enough that PR authors and reviewers do not relitigate it on every diff.
- **The Spawn → Steward handoff (`src/hatchery/spawn-handoff.ts`) is provisional code per [RFC 2026-001](../2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md).** Cassettes recorded against its current shape may need refresh if Steward is formalized into a distinct subsystem. Accept this as a known risk and document the expected refresh path; it is not a reason to delay the first L2 vertical slice, because the proof-of-concept value exceeds the cost of one cassette re-record.
- **The Operator is the sole human in the loop; every runner must be non-interactive** per [`docs/operating-philosophy.md`](../../operating-philosophy.md) rule 1. Reject any cassette-recording flow, scheduled-suite invocation, or quarantine-triage tool that expects an interactive prompt. Cassette recording in particular must not depend on a TTY-bound `y/N` confirmation — every operation must run unattended from CI or from a single non-interactive command on a dev box.
- **Quarantine is a visible state with an SLA, not a hiding place.** The one-week resolution clock is the commitment that keeps the suite trustworthy. Routing into quarantine must be cheap (moving a test there is easy) but staying past SLA must be loud (alert, dashboard, blocked release). "Silence the failing test" is out-of-bounds. Quarantine tooling lands early; the SLA timer wires in with the scheduled suite.
- **Cassette recording mode belongs with the scheduled stochastic suite, not with the first L2 slice.** The proof-of-concept slice is replay-only against a hand-prepared cassette. Co-locating recording with the drift-detector keeps the loop tight and prevents recording UX from being designed in the abstract before a real consumer exists. The temptation to bundle recording into the cassette proof-of-concept "since we're touching the cassette code anyway" should be resisted.
- **The $0 PR gate is non-negotiable.** No live backend is reachable from `npm test` or from any staged CI job. Every milestone spec must verify its design preserves this — including the scheduled stochastic milestone, whose workflow must run on its own credentials boundary so a misconfigured PR cannot accidentally invoke it. The pre-flight cost estimator is defense-in-depth, not a substitute for workflow isolation.
- **Cucumber.js parallelism characteristics are unknown relative to vitest's worker model, and Codex vs. Claude auth-shape divergence will affect the cassette redaction pipeline.** Both need measurement before the staged-CI parallelism strategy is locked, and the redaction pipeline must be designed pluggable against both backends' auth-header shapes rather than a single one — redaction-rule pluggability is a first-class concern of the generalization milestone, not an afterthought.

## Decisions

- **Framework choice per scope is locked.** vitest for L0 and L1; Cucumber.js (`@cucumber/cucumber`) for L2 and L3. Settled in [`docs/testing-strategy.md`](../../testing-strategy.md) §5 and §7 with explicit rationale against `@amiceli/vitest-cucumber` (ecosystem too thin) and `jest-cucumber` (we don't use Jest). This RFC does not reopen the choice; each milestone spec inherits it.
- **Stochastic-suite framework is PromptFoo.** The scheduled suite uses **PromptFoo** (`promptfoo`) as the eval runner — TypeScript-native, CI-first, config-in-repo, npm-installable, no external runtime. Settled in [`docs/testing-strategy.md`](../../testing-strategy.md) §5 and §7 with explicit rationale against Phoenix (Arize) — Python-first, heavier infrastructure, optimized for notebook + online tracing rather than CI eval — and Braintrust (hosted; inconsistent with the strategy's OSS self-hostable posture). Phoenix may be revisited if a future RFC adopts it as a unified production AI-flow tracing platform, but the eval-framework choice is not blocked on that decision.
- **The PR gate stays at $0.** No live-backend invocation is reachable from `npm test`, the four `test:l*` scripts, or any staged CI job. Live backends run only from the scheduled stochastic workflow on its own credentials boundary.
- **Milestones are vertical slices, not horizontal phases.** Each milestone delivers an end-to-end working capability rather than building one infrastructure layer to completion before the next begins. Selected over a six-milestone horizontal restating of the strategy's phase list because vertical slicing forces the cassette format to be shaped by a real consumer and unlocks concurrent work (M-A∥M-B, M-C∥M-D).
- **`docs/testing-strategy.md` shifts to strategic-only in the same PR as this RFC.** Gap-analysis and roadmap content migrates here as committed sequencing; the strategy doc keeps Principles, Taxonomy, Cassette pivot, framework rationale, cost-policy principles, Named exemplars, and scope. Bidirectional cross-links.
- **Contract documentation lives at `docs/subsystems/<name>/contract.md`.** One file per subsystem (Spawn, Hatchery, Brood, Herald-stub, Legate, Steward). A freshness CI check flags subsystem-source changes lacking a contract-doc update.
- **Cassettes live at `tests/cassettes/`.** Checked into the repo; refresh is an explicit reviewed PR with a PR template and a triage policy; never a silent re-record.
- **Tag vocabulary is fixed: `@l0`, `@l1`, `@l2`, `@l3`, `@deterministic`, `@stochastic`, `@ci`, `@scheduled`.** Extension by addition only — never repurpose an existing tag.
- **CI workflow extends `.github/workflows/ci.yml` rather than creating a parallel workflow file** for the staged PR-gate pipeline. The scheduled stochastic suite lives in a separate workflow with its own trigger and credentials boundary.
- **Staged CI shape: L0 runs first as the fail-fast gate; L1 + cassette-replayed L2 + cassette-replayed L3 run in parallel on L0 pass.** Wall-clock budget is "minutes, not tens of minutes," bounded by the slowest staged gate.
- **Scheduled stochastic suite cadence is weekly.** A knob, not a commitment — tighten or loosen based on observed drift signal — but the initial commit is weekly per [`docs/testing-strategy.md`](../../testing-strategy.md) §6.
- **Quarantine SLA is one week.** A stochastic test that exceeds its `pass^k` budget moves to a quarantine suite within one week and must be resolved (re-recorded, fixed, or deleted) within one week of quarantine. Visibility, not silence.
- **Cassette recording mode lives with the scheduled stochastic suite, not with the proof-of-concept L2 slice.** Replay-only at first; recording co-locates with the drift-detector that consumes it.
- **Existing vitest L2 tests (`src/spawn/snapshot-build.test.ts`, `src/spawn/container-launch.test.ts`, `src/hatchery/legate-container.test.ts`) get a "Cucumber-on-first-material-change" migration policy.** Not preemptively ported; the next material change is the trigger.
- **The first L2 slice is hard-capped at one cassette, one `.feature` file, one concurrency variant.** The concurrent-dispatch variant counts as one scenario with two execution modes sharing the same cassette, not a second scenario.
- **Cost-summary publishing target: GitHub Actions job summary + append-only `tests/cost-history.jsonl` committed by the scheduled workflow.** Herald-event integration is deferred to a follow-on once Herald lands.
- **L1 Hatchery gap-fill has no hard dependency on Hatchery's contract doc being drafted first.** Tests are written against the current public TypeScript surface; the contract doc is drafted concurrently and the tests retro-link to it.
- **M-H carries `Status: Blocked` on Herald (RFC 2026-001 M4 — Not started)** rather than being deferred to a backlog. Keeps the strategy commitment visible without overpromising sequencing; status flips to `In progress` once Herald M4 reaches `Done`.

## Open Questions

None — all deferred decisions are tracked in §Specification Debt below.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Initial scheduled-suite token budget cap (USD per weekly run). Working recommendation: $5 soft cap with alert on overrun, $20 hard kill, revisit after four runs. No prior cost data exists. | clarify:Constraints | High | Medium | open | — |
| SD-002 | Contract-freshness CI mechanism: TypeScript AST diff against last-committed `contract.md` vs. Smithy-agent directive that flags drift on PR review. Recommendation: start with the Smithy-agent directive (low infra cost, fits operating philosophy of "Smithy decomposes; March executes") and add structural AST diff only if drift slips through. | clarify:Risks | Medium | Medium | open | — |
| SD-003 | Cassette format v0 shape: JSONL HTTP capture (raw request/response pairs) vs. structured envelope (prompt + backend-typed response). Working assumption: JSONL HTTP at the proxy layer — survives backend SDK churn, matches `vcr-langchain` precedent. Codex credential-mount vs. Claude env-var split may force a higher-level envelope. | clarify:Risks | High | Medium | open | — |
| SD-004 | Quarantine SLA escalation path when the operator misses the one-week deadline. Strategy §6 says "quarantine is a visible state, not a hiding place" but does not define day-8 behavior. Recommendation: weekly stochastic-suite report posts an "overdue quarantine" line item; no automated escalation beyond visibility (escalation-to-whom is undefined for a solo operator). | clarify:Constraints | Medium | Medium | open | — |
| SD-005 | Cucumber.js parallel-worker behavior is unknown relative to vitest's worker model and must be measured before the staged-CI parallelism strategy is locked. The Codex-vs-Claude redaction-shape divergence raised in §Design Considerations is a related concern that may require expanding SD-003 rather than a separate debt row. | plan-review:Debt completeness | Medium | Low | open | — |
| SD-006 | Whether the staged CI workflow gates L2-cassette and L3-cassette on L1 pass as well, or only on L0. The current decision is "L0 fail-fast, then L1∥L2-cassette∥L3-cassette in parallel," but if Cucumber.js parallel-worker behavior turns out to interact badly with vitest workers running concurrently, the gating shape may need to revert to "L0+L1 gate, then L2-cassette∥L3-cassette." Resolves once SD-005 measurement is in. | feedback:gating-shape | Medium | Medium | open | — |
| SD-007 | Where cassette refresh code lives — `src/testing/` (treated as production code) or `tests/support/` (treated as test-only code). Cassette tooling is testing infrastructure but ships in operator-facing CLI verbs once it grows beyond the proof-of-concept. | feedback:code-location | Low | Medium | open | — |
| SD-008 | Whether the framework eventually grows a per-subsystem "smoke test" tier between L1 and L2 for "this subsystem starts up cleanly and exposes its public surface" without crossing a subsystem boundary. Not in scope for any current milestone, but the taxonomy may need a fifth scope label if M-D's Hatchery work surfaces the need. Revisit after M-D. | feedback:tier-expansion | Low | Low | open | — |
| SD-009 | How this RFC coordinates with a future `smithy test` integration on the Smithy side. The strategy doc declares Smithy-side testing out of scope, but the per-slice test plans Smithy generates and the per-scope tests this framework runs share an output surface (passing tests, gating PRs). Coordination spec is deferred; this RFC just names that the coordination will eventually be needed. | feedback:smithy-coordination | Medium | Low | open | — |
| SD-010 | Eval rubrics and per-scenario `pass^k` thresholds for agent output quality. The metric *shape* (`pass^k`) is committed; per-scenario thresholds need their own design. Deferred to a future Smithy spec sequenced after M-F. | clarify:Constraints | Medium | Medium | open | — |

## Milestones

### Milestone M-A: Test Legibility & Staged CI

**Description**: Realizes the **two-axis taxonomy** and the **staged CI workflow** primitives from §Proposal, and stands up the **quarantine routing** scaffolding. Advances the *fail loud, fail fast* and *cost is a first-class budget* goals by giving the CI pipeline a layered shape where cheap invariants fail fast and broken-fundamentals failures stop the build before integration tier burns wall-clock. Day-one startable; no prerequisites.

**Success Criteria**:
- Every test file in the repo carries one scope tag from `{@l0, @l1, @l2, @l3}` and one determinism tag from `{@deterministic, @stochastic}` plus an execution-channel tag from `{@ci, @scheduled}`; tagging coverage verified by a CI lint that fails on untagged files.
- `package.json` declares four new scripts — `test:l0`, `test:l1`, `test:l2-cassette`, `test:l3-cassette` — each filtering by tag and exiting non-zero on any untagged-but-matched file.
- `npm test` remains as a local convenience alias that runs all four staged scripts in sequence and exits non-zero on the first failure.
- `.github/workflows/ci.yml` defines a `l0` job that runs first as a fail-fast gate, and three jobs `l1`, `l2-cassette`, `l3-cassette` that fan out in parallel on `l0` success; each job runs only its corresponding `npm run test:*` script.
- The "material change" policy for the three pre-existing vitest L2 tests is recorded in `CONTRIBUTING.md` under a "Test Layer Migration" heading and enumerates the triggering conditions verbatim.
- A `tests/quarantine/` directory plus a `quarantine.ts` (or equivalent) routing primitive exists; quarantined tests are excluded from the four staged scripts and listed in a generated `tests/quarantine/INDEX.md`. (SLA timer is wired in M-F.)
- `CONTRIBUTING.md` references the four staged scripts, the tag taxonomy, and the quarantine routing primitive; `docs/testing-strategy.md` is trimmed to strategic-only content in the same PR.

### Milestone M-B: Subsystem Contract Documentation Track

**Description**: Realizes the **contract documentation** primitive from §Proposal. Advances the *contracts are explicit artifacts* goal by producing one explicit contract per subsystem at a stable location, plus the freshness check that prevents the artifacts from drifting silently. Concurrent with M-A — touches `docs/subsystems/**` and a new CI check, no dependency on M-A's CI plumbing.

**Success Criteria**:
- Six contract documents exist: `docs/subsystems/spawn/contract.md`, `docs/subsystems/hatchery/contract.md`, `docs/subsystems/brood/contract.md`, `docs/subsystems/herald-stub/contract.md`, `docs/subsystems/legate/contract.md`, `docs/subsystems/steward/contract.md`.
- Each `contract.md` contains three required sections — `## Public Interface`, `## Invariants`, `## Error Modes` — verified by a presence-check script.
- For each subsystem whose public surface is typed in TypeScript, the `## Public Interface` section includes an auto-extracted block delimited by `<!-- BEGIN AUTOGEN -->` / `<!-- END AUTOGEN -->`; the extraction tool is committed and runnable via `npm run docs:contracts:extract`.
- A `.github/workflows/contract-freshness.yml` job (or equivalent Smithy agent directive per SD-002) fails any PR that modifies a subsystem's public-source paths without touching the corresponding `contract.md`; the mapping of source globs to contract paths lives in `docs/subsystems/contract-freshness.config.json`.
- Running `npm run docs:contracts:check` locally reproduces the CI freshness verdict.

### Milestone M-C: First L2 Vertical Slice — Spawn → Steward

**Description**: Realizes the **cassette substrate** primitive from §Proposal as a hard-capped proof-of-concept against the Spawn ↔ Steward boundary, plus the throwaway-repo factory, Docker pinning, and Cucumber.js step-definition library that downstream milestones generalize. Advances the *tests are the contract* and *deterministic core, stochastic edge* goals by landing the first cross-subsystem test that asserts contract behavior deterministically against a recorded backend exchange. The scope cap (one cassette, one `.feature`, one concurrency variant per §Design Considerations) is enforced. Depends on M-A (staged CI to land in) and M-B (Spawn + Steward contracts to assert against).

**Success Criteria**:
- `docs/testing/cassette-format-v0.md` records the JSONL HTTP capture format, the redaction pass rules for API keys, auth headers, and token-shaped strings, and the file layout under `tests/cassettes/`.
- A throwaway-repo factory utility exists at `tests/support/throwaway-repo.ts` (or equivalent) and is exercised by at least one test that asserts a freshly-seeded repo is produced per invocation.
- `docs/testing/docker-pinning-policy.md` documents digest-locked base images; at least one image referenced by the L2 slice is pinned by SHA-256 digest and the digest is checked into the repo.
- Exactly one cassette file exists at `tests/cassettes/spawn-steward/handoff.jsonl` capturing a real Spawn → Steward exchange against `src/hatchery/spawn-handoff.ts`.
- Exactly one feature file exists at `tests/l2/spawn-steward.feature` with two scenarios — sequential dispatch and concurrent dispatch — both replaying the single cassette.
- A Cucumber.js step-definition library lives under `tests/l2/steps/` with a documented composition contract (`tests/l2/steps/README.md`) describing how downstream L3 scenarios reuse the same steps.
- `npm run test:l2-cassette` executes the slice green in under 30 seconds with no network egress (verified by a network-deny wrapper).

### Milestone M-D: L1 Gap-Fill (Hatchery)

**Description**: Advances the *tests are the contract* goal at the L1 scope by closing the highest-priority L1 gap surfaced during M-A's tagging pass. Concurrent with M-C — vitest vs. Cucumber, different files, no cassette dependency. Depends on M-A only; M-B's Hatchery contract is drafted concurrently and the tests retro-link to it.

**Success Criteria**:
- New vitest L1 test files under `src/hatchery/` cover (a) profile-policy schema validation, (b) environment material assembly, and (c) credential-mount spec validation; one named test file per concern.
- Each new test file is tagged `@l1 @deterministic @ci` and is picked up by `npm run test:l1`.
- The L1 suite for `src/hatchery/` grows by at least 20 new test cases relative to the pre-milestone baseline, recorded in the PR description against `npm run test:l1 -- --reporter=verbose` output.
- Any additional L1 holes flagged by M-A's tagging pass are either closed in this milestone or filed as tracked issues referenced from `docs/testing/l1-gap-backlog.md`.
- `npm run test:l1` runs green in CI's `l1` job introduced by M-A.

### Milestone M-E: Cassette Infrastructure Generalization

**Description**: Generalizes the **cassette substrate** primitive from §Proposal once M-C and M-D have provided real consumer signal, adds redaction-rule pluggability per the Codex/Claude divergence concern from §Design Considerations, and validates the generalized substrate with two additional L2 scenarios. Advances the *deterministic core, stochastic edge* goal by making the substrate reusable beyond the proof-of-concept. Depends on M-C (real consumer signal) and M-D (vitest-L1 contract surface for non-cassette comparison).

**Success Criteria**:
- `tests/support/cassette/` contains a versioned cassette runtime with an explicit `FORMAT_VERSION` constant; `docs/testing/cassette-format.md` supersedes the v0 doc and records the v0 → vNext migration story.
- Redaction rules are pluggable: `tests/support/cassette/redactors/` contains separate `codex.ts` and `claude.ts` redactor modules, both registered through a single registry, with unit tests asserting each redacts its respective auth-shape.
- A cassette-refresh PR template exists at `.github/PULL_REQUEST_TEMPLATE/cassette-refresh.md` and a triage policy is documented at `docs/testing/cassette-refresh-triage.md` (consumed by M-F's scheduled suite).
- A second L2 scenario exists at `tests/l2/brood-spawn.feature` with cassette `tests/cassettes/brood-spawn/dispatch.jsonl`.
- A third L2 scenario exists at `tests/l2/hatchery-materialization.feature` with cassette `tests/cassettes/hatchery-materialization/profile.jsonl`.
- `npm run test:l2-cassette` executes all three L2 scenarios green in CI's `l2-cassette` job in under 60 seconds.

### Milestone M-F: Scheduled Stochastic Suite + Recording Mode + Cost/Quarantine Tooling

**Description**: Realizes the **staged CI workflow**'s scheduled side from §Proposal — the weekly stochastic suite against live backends, plus the **cost tooling**, **cassette-refresh workflow**, and quarantine SLA wiring named in the supporting concerns. Advances the *cost is a first-class budget* and *fail loud, fail fast* goals by making cost observable per run, gating spend, and giving stochastic flakes a one-week SLA. Depends on M-C (at least one recorded scenario to drift-check against) and M-E (generalized cassette infrastructure to write into).

**Success Criteria**:
- `.github/workflows/scheduled-stochastic.yml` exists with a weekly `schedule:` trigger and references a secrets context (e.g., `secrets.STOCHASTIC_*`) disjoint from the PR-gate workflows; a CI lint enforces that no PR-gate workflow references those secret names.
- A pre-flight cost estimator runs as the first step of the workflow and prints a projected-spend block to the job log before any backend call is made.
- A token-budget gate enforces a soft cap and a hard kill (initial defaults per the SD-001 working recommendation: $5 soft alert, $20 hard kill; revisited after four scheduled runs) configured via repository variables; exceeding the hard cap fails the job and aborts further backend calls.
- A PromptFoo configuration file at `tests/stochastic/promptfoo.yaml` declares the scheduled scenarios — each tagged `@stochastic @scheduled` — including provider configs for Codex and Claude, `pass^k` retry counts, deterministic assertion checks (schema validity, presence of required fields), and any LLM-as-judge graders. A `test:stochastic` script in `package.json` invokes `promptfoo eval` against that config; the scheduled workflow calls `npm run test:stochastic`.
- A `--record` mode for the cassette runtime produces new cassette files under `tests/cassettes/` and is invoked by the workflow when drift is detected against the proof-of-concept scenario.
- `.github/PULL_REQUEST_TEMPLATE/cassette-refresh.md` (from M-E) and a new `.github/ISSUE_TEMPLATE/cassette-refresh.yml` are wired into the workflow's drift-detection handler.
- Quarantine SLA wiring enforces a 7-day clock against entries in `tests/quarantine/INDEX.md`; overdue items appear in the workflow's weekly report and in the job summary.
- A structured cost summary is written to `$GITHUB_STEP_SUMMARY` and appended to `tests/cost-history.jsonl` (one JSON object per run); the workflow commits the updated history file back to the repo. PromptFoo's per-run output (token counts, latency per provider) feeds the summary rather than being a separate publishing path.

### Milestone M-G: L3 Vertical Slice

**Description**: Exercises the **cassette substrate** primitive at the L3 scope from §Proposal by lifting `tests/Agent.tests.md` A1 into a runnable Cucumber.js scenario. Advances the *tests are the contract* and *deterministic core, stochastic edge* goals at the system scope by replacing prose dogfooding with a deterministic, cassette-replayed regression. Depends on M-E (generalized cassette infra for multi-backend scenarios), M-D (Hatchery L1 must hold the boundary L3 scenarios cross), and M-C (step-definition library reused under `tests/l2/steps/`).

**Success Criteria**:
- A feature file exists at `tests/l3/agent-a1.feature` whose scenarios are a direct, traceable derivation of scenario A1 in `tests/Agent.tests.md` (cross-references recorded in the feature file's `# Source:` header).
- L3-specific orchestration helpers live under `tests/l3/steps/` and import and reuse the step-definition library produced by M-C under `tests/l2/steps/`.
- All backend exchanges in the Legate loop for scenario A1 are replayed from cassettes under `tests/cassettes/l3/agent-a1/`; a network-deny wrapper around the run asserts zero outbound calls.
- The L3 feature file is tagged `@l3 @deterministic @ci` and runs in CI's `l3-cassette` job via `npm run test:l3-cassette`.
- `npm run test:l3-cassette` runs green in under 90 seconds.

### Milestone M-H: Herald-Enabled Trace-as-Fixture

**Description**: Closes the loop between operator-visible production runs and L3 regression coverage by converting Herald events into cassettes, advancing the *deterministic core, stochastic edge* goal at the regression scope. **Blocked on Herald (RFC 2026-001 M4 — Not started)**; depends on M-G (an L3 cassette consumer must exist) and Herald M4.

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
