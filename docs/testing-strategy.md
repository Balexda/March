# March Testing Strategy

**Status**: Living document. First draft 2026-05-17, seeded by issue [#133](https://github.com/Balexda/March/issues/133). Expected to evolve as the system grows and as each phase of the [Roadmap](#9-roadmap) lands.

**Audience**: Anyone writing or reviewing tests for March, designing a new subsystem, or trying to understand which assertions belong at which scope.

**Companion**: [`CONTRIBUTING.md`](../CONTRIBUTING.md) holds the practical "how to run tests today" commands. This document holds the longer-lived "what should we be testing and why" framing. Read this once; then use `CONTRIBUTING.md` day-to-day.

---

## 1. Why this doc exists

March is a pre-release agent harness that orchestrates Smithy-style plan→PR→fix loops across sandboxed AI workers. It has grown by accretion: a new subsystem lands, the operator dogfoods it, a bug surfaces, the bug gets fixed. That loop has worked, but it has a cost — the system today is one wrong poke away from the house of cards collapsing, and recent incidents (see [issue #133](https://github.com/Balexda/March/issues/133) and PR #126) were all things automated tests at the right layer would have caught immediately, instead of waiting for the operator to notice that "nothing is happening."

Three things make this hard:

1. **The subsystem count keeps growing.** Spawn, Hatchery, Brood, Herald, Legate, Steward. Each one is a contract, and most of the interesting failures happen *between* subsystems, not inside them.
2. **Determinism and stochasticity are mixed.** The harness itself is deterministic; the LLM-backed sessions it launches are not. Tests that conflate the two either lie (passing because they only check shape) or break (failing because the prose drifted overnight).
3. **Stochastic tests cost money and time.** Running real backends on every PR is not affordable. Never running them is dishonest.

This document proposes a taxonomy that separates these concerns, a cassette-based architecture that makes the integration tier affordable, and a phased roadmap that closes the coverage gap deliberately rather than opportunistically.

## 2. Principles

These trace directly to [`docs/operating-philosophy.md`](operating-philosophy.md). Cite that document, not this one, when defending a design choice — the principles below restate it for the testing context.

- **Tests are the contract.** Every subsystem boundary the harness depends on at runtime is a contract that needs a test at the matching scope. If the contract is not tested at the scope where it can break, the system is one race condition away from a silent failure.
- **Contracts are explicit artifacts.** A tested contract is only as good as the contract it is testing against. Each subsystem boundary should produce a documented contract — interface shape, invariants, error modes — that tests reference, rather than implicit knowledge that lives in someone's head or in a spec PR from six months ago. Without an explicit contract, drift between what a subsystem *claims* to do and what its tests actually assert goes undetected. Phase 1.5 of the [Roadmap](#9-roadmap) names the artifact and the freshness tooling that backs this principle.
- **Deterministic core, stochastic edge.** The harness is deterministic; only the spawned backends are stochastic. Test the harness deterministically — even when the thing it launches is not. Cassettes (§4) are how we hold that line.
- **Fail loud, fail fast.** A flaky test masks the very fragility this strategy is fighting. Stochastic tests must have explicit pass/fail criteria (e.g. `pass^k` with `k ≥ 3`) and tight timeouts — never "looks roughly right." A stochastic test that hangs is itself a violation of [rule 3 — failures are clean exits, not hangs](operating-philosophy.md#3-failures-are-clean-exits-not-hangs).
- **Cost is a first-class budget.** Money and wall-clock are scarce; PR-gate tests must spend neither. The cassette split (§4) makes this practical.

## 3. Two-axis taxonomy

The prior `CONTRIBUTING.md` model — Tier 1 (Automated) / Tier 2 (Agent) / Tier 3 (Human), which this document replaces — conflated three different things: *who* runs the test, *what scope* it exercises, and *whether it asserts over deterministic or stochastic output*. This document separates them onto orthogonal axes.

### Axis A — Scope (what the test exercises)

| Scope | Boundary | Allowed infrastructure | March example |
|-------|----------|------------------------|---------------|
| **L0 Unit** | One function/class in isolation. | Tmp dirs, in-process fixtures only. No git, no docker, no network. | `src/brood/spawn-record.test.ts` — SpawnRecord state machine transitions. |
| **L1 Subsystem** | One subsystem end-to-end on the host, no other subsystem in the loop. | Real filesystem, real git allowed. No docker containers managed by another subsystem. | `src/brood/worktree.test.ts` — Brood worktree lifecycle against real git. |
| **L2 Cross-subsystem** | Two or more subsystems wired together; may launch one container. | Real docker, real git, throwaway repo. Backends behind a cassette by default. | Spawn → Steward patch handoff on a throwaway repo (does not exist today; the gap issue #133 calls out). |
| **L3 System** | Full Legate loop spanning all subsystems; may launch many coordinated containers. | Everything L2 allows, plus a real multi-container orchestration. Backends still cassette-replayed in the CI variant. | Plan → dispatch → PR on a seeded repo, with the full Legate loop running. (No automated example today; today's `tests/Agent.tests.md` A1–A5 are the prose form of this scope.) |

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
- **Local.** `npm run test:slow` on a dev machine. L2/L3 with real docker permitted; live backends off by default. The right place to re-record a cassette or debug container plumbing.
- **Scheduled.** Weekly GitHub Action runs the `Stochastic / Scheduled` suite against live backends, behind a budget gate.
- **Agent-driven.** A Claude Code session inside a Legate runs L3 scenarios that themselves test Legate. Dogfooding. Today this is the prose in `tests/Agent.tests.md`; aspirationally, runnable.
- **Human.** TTY-only or judgment-required tests (`tests/Manual.tests.md`).

A test's full label is `<Scope> / <Determinism> / <Context>`, e.g. `L2 / Deterministic / CI` or `L3 / Stochastic / Scheduled`.

## 4. The cassette pivot

This is the central architectural idea of the whole strategy. Take it as the lever that makes everything else affordable.

A **cassette** is a recorded backend exchange — the prompts the harness sent and the responses the backend produced. Once captured, the cassette is checked in, and subsequent test runs *replay* it instead of calling the backend live. Replay turns a previously stochastic call into a deterministic fixture: same inputs, same recorded output, every time.

The whole taxonomy hinges on this:

- The **majority** of L2 and L3 tests run as `Deterministic / CI` against cassettes. We get genuine end-to-end coverage of harness integration paths — Spawn launch, Brood lifecycle, Steward patch apply, Legate loop iteration — without spending a token or waiting on a model.
- A **smaller, separate** suite of `Stochastic / Scheduled` tests calls the real backends. Its job is narrower: confirm the live backend still behaves consistently with the cassette assumptions (**cassette-drift detection**) and that the backend's output quality still meets the contract the harness was designed against.
- The same scenario typically exists at *both* levels — once as a deterministic replay (cheap, runs everywhere) and once as a stochastic live call (expensive, runs weekly). The two are the two halves of the same question: "do we still know how to drive this contract?" and "does the contract still behave the way we recorded?"
- **Cassette refresh is a tracked operation.** When a backend version changes or a prompt evolves, the stochastic suite catches the drift, and re-recording the relevant cassette is the explicit, reviewed response. Cassettes live in the repo so the change is visible in the diff.

Industry precedent for this pattern is solid — see `vcr-langchain`, `pytest-recording`, the original `vcr` Ruby gem, and Anthropic's own evals framing of code-graders as the reproducible-cheap-fast layer with model-graders as the expensive-rare layer. We are not inventing this; we are committing to it.

## 5. Per-scope playbook

Each scope below specifies what is allowed, what determinism mode applies by default, where the existing examples live, and the shape of the first test someone should write at that scope.

### L0 — Unit

- **Allowed**: tmp dirs, in-process fixtures, vitest mocks.
- **Forbidden**: real git, real docker, real network, real backend.
- **Default determinism**: deterministic. There should be no stochastic L0 tests.
- **Existing examples**: `src/brood/spawn-record.test.ts`, `src/spawn/snapshot.test.ts`, `src/spawn/backends.test.ts`, `src/shared/deps.test.ts`, `src/bootstrap/manifest.test.ts`, `src/bootstrap/skills.test.ts`.
- **First-test template**: instantiate the type, call the method, assert exact return. No setup beyond the class itself.

### L1 — Subsystem

- **Allowed**: real filesystem (tmp), real git, in-process invocation of one subsystem's public surface.
- **Forbidden**: another subsystem's behavior in the assertion path. Real docker containers managed by another subsystem.
- **Default determinism**: deterministic. Use of real git is reproducible; git state is fully controlled by the test.
- **Existing examples**: `src/brood/worktree.test.ts`, `src/bootstrap/init.test.ts`, `src/bootstrap/update.test.ts`, `src/legate/init.test.ts`.
- **First-test template**: set up a throwaway repo / tmp HOME, call the subsystem's top-level entry point, assert filesystem state + return value.

### L2 — Cross-subsystem

- **Allowed**: real docker, real git, throwaway repos, one container launched by the subsystem under test. Backends behind a cassette.
- **Forbidden**: the Legate orchestration loop. Live backend calls in the CI variant.
- **Default determinism**: deterministic (cassette-replayed). A stochastic L2 variant is allowed in the `Scheduled` context for cassette-drift detection.
- **Existing examples**: `src/hatchery/legate-container.test.ts`, `src/spawn/container-launch.test.ts`, `src/spawn/snapshot-build.test.ts`. These exercise container shape but not yet the cross-subsystem handoff paths issue #133 calls out.
- **First-test template**: spin up the throwaway-repo factory, launch one container with a cassette mounted, drive the inter-subsystem boundary, assert the artifact landed where the consumer expects it. The first L2 test the codebase should add is the Spawn → Steward handoff (issue #133's race-condition hotspot).

### L3 — System

- **Allowed**: everything L2 allows, plus the full Legate loop and multi-container coordination.
- **Forbidden**: live backend calls in the CI variant. Anything that depends on operator interaction (those are H-tests).
- **Default determinism**: deterministic (cassettes for every backend exchange). A stochastic L3 variant runs `Scheduled`.
- **Existing examples**: none automated. The prose A1–A5 in `tests/Agent.tests.md` are L3-shaped today.
- **First-test template**: seed a repo with a known Smithy plan, hand it to a real Legate, replay cassettes for every backend exchange in the loop, assert the loop terminates with a PR in the expected state.

## 6. Cost policy

Explicit, because the strategy lives or dies on whether it stays affordable.

- **PR gate**: $0, < 2 minutes wall-clock. Deterministic only — includes L0, L1, and cassette-replayed L2/L3. No live backend spawns. This is where the cassette pivot pays off: integration coverage at unit-test cost.
- **Local opt-in (`npm run test:slow`)**: L2/L3 with real docker permitted; live backends still off by default. The right place to re-record a cassette or debug container plumbing on a dev box.
- **Scheduled (weekly)**: the `Stochastic / Scheduled` suite calls live backends. Token budget gate per run (initial soft cap with alert on overrun). A pre-flight cost estimator prints projected spend before invoking. Primary signal is cassette-drift detection and live-output quality — *not* per-PR coverage.
- **Cassette refresh policy**: cassettes are checked in. Refresh is an explicit, reviewed PR — never a silent re-record. When the stochastic suite fails and the failure is benign backend drift, the resolution is to re-record the cassette and commit the diff with a note on what changed.
- **Quarantine rule**: a stochastic test that exceeds its `pass^k` budget moves to a quarantine suite within one week; never silenced. Quarantine is a visible state, not a hiding place.
- **Cost visibility**: every scheduled run posts a structured summary (tokens, $, wall-clock per scenario) to a tracked location so trends are observable.

The weekly cadence is a deliberate choice. Nightly would over-spend for the signal it provides; the kinds of drift we are watching for (backend version bumps, prompt-template regressions) move on a slower clock than a day. If the signal proves too slow in practice, tighten to nightly; if it proves noisy, loosen to fortnightly. The cadence is a knob, not a commitment.

## 7. Named exemplars

This document is principles-first, but the principles are easier to apply when you can see them in someone else's code. The exemplars below are the inspiration set, not a mandate — when a phase of the [Roadmap](#9-roadmap) lands, the RFC for that phase picks which (if any) to adopt directly.

- **Anthropic's evals framework** — the three grader types (code-based, model-based, human) map cleanly onto our Determinism axis: code-based ≈ deterministic-CI, model-based ≈ stochastic-scheduled, human ≈ H-tests.
- **Testcontainers philosophy** — "real services in containers, not mocks" for the integration tier. We already follow this implicitly for snapshot/build tests; the L2 playbook generalizes it.
- **VCR / `pytest-recording` / `vcr-langchain` / `proxymock`** — the cassette-replay pattern as the canonical record-replay primitive. Format and storage details are a Phase-2 decision (see §9).
- **LangSmith trace-as-fixture** — production traces become regression fixtures by converting them into cassettes. Aspirational; depends on Herald (M4) landing.
- **`pass@k` / `pass^k` metrics** from the agent-eval literature — the right way to score a stochastic test that runs a small number of trials.
- **Jepsen-style scenario testing** — the model for L3 coordination tests once Brood orchestrates multiple Spawns concurrently. The race conditions in PR #126 are exactly the class of bug Jepsen's lineage targets.

## 8. Gap analysis

Today's tests, mapped to the new taxonomy.

### Automated (formerly "Tier 1")

| Test file | New label |
|-----------|-----------|
| `src/cli/program.test.ts` | L1 / Deterministic / CI |
| `src/bootstrap/init.test.ts` | L1 / Deterministic / CI |
| `src/bootstrap/update.test.ts` | L1 / Deterministic / CI |
| `src/bootstrap/manifest.test.ts` | L0 / Deterministic / CI |
| `src/bootstrap/skills.test.ts` | L0 / Deterministic / CI |
| `src/legate/init.test.ts` | L1 / Deterministic / CI |
| `src/shared/deps.test.ts` | L0 / Deterministic / CI |
| `src/brood/worktree.test.ts` | L1 / Deterministic / CI |
| `src/brood/spawn-record.test.ts` | L0 / Deterministic / CI |
| `src/spawn/snapshot.test.ts` | L0 / Deterministic / CI |
| `src/spawn/snapshot-build.test.ts` | L2 / Deterministic / CI (builds an image but does not exercise another subsystem's behavior) |
| `src/spawn/backends.test.ts` | L0 / Deterministic / CI |
| `src/spawn/container-launch.test.ts` | L2 / Deterministic / CI |
| `src/hatchery/legate-container.test.ts` | L2 / Deterministic / CI |

### Agent + Human (formerly "Tier 2" / "Tier 3")

| Reference | New label | Status |
|-----------|-----------|--------|
| `tests/Agent.tests.md` A1–A5 | L3 / Stochastic / Agent-driven | Prose, not runnable. The right target shape is `L3 / Deterministic / CI` (replayed) plus `L3 / Stochastic / Scheduled` (live). |
| `tests/Manual.tests.md` H1–H2 | TTY UI / Deterministic / Human | Appropriate as-is; readline TTY behavior is genuinely human-test territory. |

### Gaps surfaced

- **Hatchery has no L1 test.** `legate-container.test.ts` is L2-shaped. Hatchery's profile-policy surface deserves its own subsystem-scope coverage.
- **No L2 test for the Spawn → Steward handoff** — the exact layer issue #133 calls out as the race-condition hotspot, with three PR #126 incidents traceable to its absence.
- **No L3 tests at all.** Today's A1–A5 are documented intent, not runnable assertions.
- **No cassette infrastructure.** Every future L2/L3 test that involves a backend will need it; nothing exists today.
- **No CI separation of fast vs slow.** Every test runs in `npm test`; there is no `npm run test:slow` and no scheduled workflow.
- **No stochastic suite, anywhere.** Cassette-drift detection has no home today.

## 9. Roadmap

The phases below are the input `/smithy.ignite` should turn into RFCs and specs. Each phase is sized to be one RFC/spec, not one PR.

- **Phase 1 — Make today's tests legible.** Add scope/determinism tags to each existing test file (the gap-analysis table above is the seed). Split `npm test` into `npm test` (CI: L0 + L1 + cassette-replayed L2/L3) and `npm run test:slow` (local: + real-Docker, + cassette-recording mode). Update the CI workflow and `CONTRIBUTING.md` to reflect the split. Cheap; unlocks the rest.
- **Phase 1.5 — Subsystem-contract documentation + freshness tooling.** Output: a per-subsystem contract document (interface shape, invariants, error modes) at a stable location — `docs/subsystems/<name>/contract.md` or co-located with the subsystem source, whichever survives review. Where the surface is typed in TypeScript, auto-extract what you can; the rest is hand-written prose. Add a CI check (or a Smithy agent directive) that flags when a subsystem's public surface changes without a corresponding contract-doc update — the "Contracts are explicit artifacts" principle needs a freshness signal, not just a folder of stale `.md` files. Sequenced before Phase 2 because cassette-backed tests are most valuable when they're asserting against an explicit contract, not chasing the implementation.
- **Phase 2 — Cassette infrastructure for backend exchanges.** This is foundational, not a later add-on. Decide the recording layer (HTTP-level capture against the backend container's API, or a stub-backend container that serves canned JSONL). Define cassette format, on-disk location, redaction rules (no API keys in committed cassettes), and the record-vs-replay toggle. Build the throwaway-repo factory and deterministic Docker image pinning at the same time — both are prerequisites for any cassette-backed test.
- **Phase 3 — Close the cross-subsystem hole with cassettes.** Write the first L2 Spawn → Steward test as `Deterministic / CI` using a Phase-2 cassette. This is issue #133's race-condition hotspot and the proof-of-concept for the whole strategy. Concurrent-dispatch variant included from day one (the race only shows under concurrency).
- **Phase 4 — Scheduled stochastic suite.** Weekly workflow runs the live-backend variants of the same scenarios behind a budget gate. Cassette-drift detection: a scheduled-suite failure tells you the backend has moved relative to the cassette.
- **Phase 5 — Herald-enabled trace-as-fixture.** Once Herald lands (M4), capture real run traces from operator dogfooding and convert them into new cassettes for L3 regression coverage. Closes the loop between production observability and test fixtures.

Each phase has a clean predecessor; do not skip ahead.

## 10. What this doc does NOT cover

- The specific test framework choice beyond vitest (already settled).
- Eval rubrics for agent output quality. A future Smithy spec under Phase 4 or 5 will define these — `pass^k` is the right metric *shape*, but the per-scenario thresholds need their own design.
- Production observability and SLOs. That's operations-doc territory.
- Anything Smithy-side. `smithy test` covers slice-level test plans for individual specs; this strategy is March's harness-side complement, not a replacement for it.
