# March Testing Strategy

**Status**: Living document. Long-lived strategic companion to the testing RFC. Expected to evolve as principles shift, not as tactics shift.

**Audience**: Anyone writing or reviewing tests for March, designing a new subsystem, or trying to understand which assertions belong at which scope.

**Companion**: [`docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md`](rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md) owns the milestone-level commitment, sequencing, and per-milestone success criteria — the *how* and *when*. This document owns the *what* and *why*: the principles, the taxonomy, the cassette pivot, the cost framing. If they conflict, this document wins on principle; the RFC wins on milestone exit criteria. [`CONTRIBUTING.md`](../CONTRIBUTING.md) holds the practical day-to-day commands.

---

## 1. Why this strategy exists

March is a pre-release agent harness that has grown by accretion. The system is one wrong poke away from the house of cards collapsing, and the failure mode is consistent: the operator notices nothing is happening hours or days after a silent regression started. The four PR #126 incidents (Hatchery runner script invalid for months, `launchAgentDeckManager` race, Legate-loop escalation silent, stale stub archive blocking dispatch) are the canonical examples — each one would have failed an automated test at the right layer in seconds, instead of burning operator-days in triage.

Three structural pressures make this hard, and they will keep applying as March grows:

1. **The subsystem count keeps growing.** Spawn, Hatchery, Brood, Herald, Legate, Steward, and whatever lands next. Most of the interesting failures happen *between* subsystems, not inside them, and that is exactly where coverage is thinnest.
2. **Determinism and stochasticity are mixed.** The harness itself is deterministic; the LLM-backed sessions it launches are not. Tests that conflate the two either lie (passing because they only check shape) or break (failing because the prose drifted overnight).
3. **Stochastic tests cost money and time.** Running real backends on every PR is not affordable. Never running them is dishonest.

The strategy this document describes — a two-axis taxonomy, a cassette pivot, an explicit cost framing, and locked framework choices per scope — is the answer to those three pressures. The companion RFC owns the milestones that execute it.

## 2. Principles

These trace directly to [`docs/operating-philosophy.md`](operating-philosophy.md). Cite that document, not this one, when defending a design choice — the principles below restate it for the testing context.

- **Tests are the contract.** Every subsystem boundary the harness depends on at runtime is a contract that needs a test at the matching scope. If the contract is not tested at the scope where it can break, the system is one race condition away from a silent failure.
- **Contracts are explicit artifacts.** A tested contract is only as good as the contract it is testing against. Each subsystem boundary should produce a documented contract — interface shape, invariants, error modes — that tests reference, rather than implicit knowledge that lives in someone's head or in a spec PR from six months ago. Without an explicit contract, drift between what a subsystem *claims* to do and what its tests actually assert goes undetected.
- **Deterministic core, stochastic edge.** The harness is deterministic; only the spawned backends are stochastic. Test the harness deterministically — even when the thing it launches is not. Cassettes (§4) are how we hold that line.
- **Fail loud, fail fast.** A flaky test masks the very fragility this strategy is fighting. Stochastic tests must have explicit pass/fail criteria (e.g. `pass^k` with `k ≥ 3`) and tight timeouts — never "looks roughly right." A stochastic test that hangs is itself a violation of [rule 3 — failures are clean exits, not hangs](operating-philosophy.md#3-failures-are-clean-exits-not-hangs).
- **Cost is a first-class budget.** Money and wall-clock are scarce; PR-gate tests must spend neither. The cassette pivot (§4) makes this practical.

## 3. Two-axis taxonomy

Earlier framings collapsed three different things — *who* runs the test, *what scope* it exercises, and *whether it asserts over deterministic or stochastic output* — into a single tier label. This document separates them onto orthogonal axes.

### Axis A — Scope (what the test exercises)

| Scope | Boundary | Allowed infrastructure |
|-------|----------|------------------------|
| **L0 Unit** | One function/class in isolation. | Tmp dirs, in-process fixtures only. No git, no docker, no network. |
| **L1 Subsystem** | One subsystem end-to-end on the host, no other subsystem in the loop. | Real filesystem, real git allowed. No docker containers managed by another subsystem. |
| **L2 Cross-subsystem** | Two or more subsystems wired together; may launch one container. | Real docker, real git, throwaway repo. Backends behind a cassette by default. |
| **L3 System** | Full Legate loop spanning all subsystems; may launch many coordinated containers. | Everything L2 allows, plus a real multi-container orchestration. Backends still cassette-replayed in the CI variant. |

**Boundary rules** (when in doubt, climb the ladder):

- An L0 test that imports two subsystems and stubs the boundary is still L0. An L0 test that lets one subsystem call into another for real is actually L1 or L2 — re-label it.
- An L1 test must not depend on docker behavior for its assertion. If it needs a container, it's L2.
- An L2 test must not depend on Legate's orchestration loop. If it needs the loop, it's L3.

### Axis B — Determinism (what the test asserts over)

- **Deterministic.** Same inputs, exact same outputs every run. The default. Covers process, schemas, state transitions, container lifecycle, file layouts. **Includes cassette-replayed tests** — a recorded backend exchange is deterministic *for a given cassette*, even though the underlying call was stochastic when recorded.
- **Stochastic.** Outputs vary; the test asserts statistical or shape properties — validity, presence of required fields, `pass^k` over `k` retries, LLM-as-judge score above a threshold. Reserved for tests of *what backends actually produce when called live*, never *how the harness behaves*.

A test that depends on a live backend and asserts an exact string is mis-categorized. Either replay the cassette (deterministic) or assert a property (stochastic). Pick one.

### Orthogonal — Execution context (who runs it, where)

- **CI.** Runs unattended on every push/PR. L0 always; L1 mostly; L2/L3 with cassettes only. No live backend spawns.
- **Local.** Opt-in for L2/L3 with real docker on a dev machine. The right place to re-record a cassette or debug container plumbing.
- **Scheduled.** Periodic runs against live backends, behind a budget gate. Catches drift between cassette and live behavior.
- **Agent-driven.** A Claude Code session inside a Legate runs scenarios that themselves test Legate. Dogfooding.
- **Human.** TTY-only or judgment-required tests.

A test's full label is `<Scope> / <Determinism> / <Context>`, e.g. `L2 / Deterministic / CI` or `L3 / Stochastic / Scheduled`.

## 4. The cassette pivot

This is the central architectural idea of the whole strategy. Take it as the lever that makes everything else affordable.

A **cassette** is a recorded backend exchange — the prompts the harness sent and the responses the backend produced. Once captured, the cassette is checked in, and subsequent test runs *replay* it instead of calling the backend live. Replay turns a previously stochastic call into a deterministic fixture: same inputs, same recorded output, every time.

The whole taxonomy hinges on this:

- The **majority** of L2 and L3 tests run as `Deterministic / CI` against cassettes. We get genuine end-to-end coverage of harness integration paths — Spawn launch, Brood lifecycle, Steward patch apply, Legate loop iteration — without spending a token or waiting on a model.
- A **smaller, separate** suite of `Stochastic / Scheduled` tests calls the real backends. Its job is narrower: confirm the live backend still behaves consistently with the cassette assumptions (**cassette-drift detection**) and that the backend's output quality still meets the contract the harness was designed against.
- The same scenario typically exists at *both* levels — once as a deterministic replay (cheap, runs everywhere) and once as a stochastic live call (expensive, runs periodically). The two are the two halves of the same question: "do we still know how to drive this contract?" and "does the contract still behave the way we recorded?"
- **Cassette refresh is a tracked operation.** When a backend version changes or a prompt evolves, the stochastic suite catches the drift, and re-recording the relevant cassette is the explicit, reviewed response. Cassettes live in the repo so the change is visible in the diff.

Industry precedent for this pattern is solid — see `vcr-langchain`, `pytest-recording`, the original `vcr` Ruby gem, and Anthropic's own evals framing of code-graders as the reproducible-cheap-fast layer with model-graders as the expensive-rare layer. We are not inventing this; we are committing to it.

## 5. Framework choice per scope

Different scopes have different natural assertion shapes, and one framework does not fit all of them. The choices below are settled in this document and consumed downstream by the RFC and per-milestone specs; the RFC does not reopen them.

- **L0 — Unit.** vitest. The shape — assert exact return given exact input — is what vitest is good at. There should be no stochastic L0 tests.
- **L1 — Subsystem.** vitest. L1 stays in-process by design, so the function-call assertion shape still fits. If an L1 test grows container plumbing in its setup, that is the signal it should be re-labeled L2 and adopt the L2 framework.
- **L2 — Cross-subsystem.** Gherkin via **Cucumber.js** (`@cucumber/cucumber`). At this scope a test is a scenario — *given* a throwaway repo and a cassette mounted, *when* Subsystem A drives Subsystem B across the boundary, *then* the artifact lands in the expected shape. Gherkin's `Given / When / Then` matches the structure of the LLM-produced acceptance scenarios already showing up in Smithy specs, so the spec-to-test handoff is mostly mechanical rather than a translation step.
- **L3 — System.** Gherkin via **Cucumber.js**, same toolchain as L2. At L3 the assertion shape is "*given* this seed repo and Smithy plan, *when* Legate runs the loop end-to-end against replayed cassettes, *then* a PR exists in state X with these properties." Trying to write that in vitest collapses readability; Gherkin is the native shape. The L3 step-definition library is largely a superset of L2's, with extra orchestration helpers.

Cucumber.js was picked over the alternatives because it is the canonical Gherkin runner for Node, has first-class TypeScript support and parallel execution, and a healthy 2026 release cadence — it is the safe place to land an integration tier the rest of the strategy depends on. Considered and rejected: `@amiceli/vitest-cucumber` (would give a unified vitest story, but the ecosystem — single maintainer, ~90 GitHub stars — is too thin a foundation for the integration tier); `jest-cucumber` (we don't use Jest, and it couples Gherkin to Jest's structure less cleanly than Cucumber.js stands alone). `playwright-bdd` and Maestro are named in §7 as the future browser and mobile paths that keep `.feature` files reusable.

## 6. Cost policy

Explicit, because the strategy lives or dies on whether it stays affordable.

- **The PR gate is $0.** Deterministic only — includes L0, L1, and cassette-replayed L2/L3. No live backend spawns. Wall-clock budget is *minutes, not tens of minutes*. This is where the cassette pivot pays off: integration coverage at unit-test cost.
- **Staged feedback over monolithic suites.** PR-gate runs as separate jobs per scope, not one bucket. Broken-fundamentals failures (L0 invariant violations) fail fast; integration tier gets the wall-clock it needs without dragging down the cheap signal. The exact gating pattern is a tactical choice owned by the RFC and its milestone specs.
- **Live backends run on a schedule, behind a budget gate.** The `Stochastic / Scheduled` suite carries pre-flight cost estimation, soft/hard budget caps with overrun alerts, and a structured cost-summary publish trail. Primary signal is cassette-drift detection and live-output quality — *not* per-PR coverage.
- **Cassette refresh is an explicit, reviewed PR.** Cassettes are checked into the repo; refresh is never silent. When the stochastic suite fails and the failure is benign backend drift, the resolution is to re-record the cassette and commit the diff with a note on what changed.
- **Quarantine is a visible state, not a hiding place.** A stochastic test that exceeds its `pass^k` budget moves to a quarantine suite with a bounded resolution clock; the test is never silently skipped. The specific SLA is set by the RFC.
- **Cost is observable.** Every scheduled run publishes a structured summary (tokens, dollars, wall-clock per scenario) to a tracked location so trends are visible without operator vigilance.

The scheduled cadence and the specific budget cap are tactical knobs owned by the RFC. The principle — that live-backend testing is rare, gated, observable, and never on the PR critical path — is owned here.

## 7. Named exemplars

This document is principles-first, but the principles are easier to apply when you can see them in someone else's code. The exemplars below are the inspiration set, not a mandate — when a milestone spec lands, the spec picks which (if any) to adopt directly.

- **Anthropic's evals framework** — the three grader types (code-based, model-based, human) map cleanly onto our Determinism axis: code-based ≈ deterministic-CI, model-based ≈ stochastic-scheduled, human ≈ H-tests.
- **Testcontainers philosophy** — "real services in containers, not mocks" for the integration tier. We already follow this implicitly for snapshot/build tests; the L2 playbook generalizes it.
- **VCR / `pytest-recording` / `vcr-langchain` / `proxymock`** — the cassette-replay pattern as the canonical record-replay primitive.
- **LangSmith trace-as-fixture** — production traces become regression fixtures by converting them into cassettes. Aspirational; depends on Herald landing.
- **`pass@k` / `pass^k` metrics** from the agent-eval literature — the right way to score a stochastic test that runs a small number of trials.
- **Jepsen-style scenario testing** — the model for L3 coordination tests once Brood orchestrates multiple Spawns concurrently. The race conditions in PR #126 are exactly the class of bug Jepsen's lineage targets.
- **Cucumber.js (`@cucumber/cucumber`)** — the chosen runner for L2 and L3 (see §5). The defense against alternatives lives in §5.
- **playwright-bdd** — the future browser path. We do not have a UI today, but when one lands, `playwright-bdd` keeps the `.feature` files we have written and runs them against Playwright instead of asking us to learn a second BDD dialect.
- **Maestro** — the future mobile path, for the same reason. If we ever need device automation, the plan is a custom step-definition library that drives Maestro from the same Gherkin scenarios. Aspirational; called out so the Gherkin investment is understood as a forward-compatible choice, not a sunk-cost trap.

## 8. What this strategy does NOT cover

- The specific milestone sequencing, scope, success criteria, and dependencies that turn this strategy into shipped infrastructure. That lives in [`docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md`](rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md), the gap-analysis baseline of today's tests, and per-milestone specs derived from the RFC.
- Eval rubrics for agent output quality. A future Smithy spec will define these — `pass^k` is the right metric *shape*, but the per-scenario thresholds need their own design.
- Production observability and SLOs. That's operations-doc territory.
- Anything Smithy-side. `smithy test` covers slice-level test plans for individual specs; this strategy is March's harness-side complement, not a replacement for it.

(The framework choice per scope — vitest for L0/L1, Cucumber.js for L2/L3 — *is* settled by this doc; see §5 and §7. Re-deriving it is out of scope for downstream RFCs and specs.)
