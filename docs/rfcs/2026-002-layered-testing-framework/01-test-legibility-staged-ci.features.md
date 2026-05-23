# Feature Map: Test Legibility & Staged CI

**Source RFC**: `docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md`
**Milestone**: M1 — Test Legibility & Staged CI
**Created**: 2026-05-20

## Features

Operator documentation is not a standalone feature — each feature below keeps the relevant `CONTRIBUTING.md` references current as it lands, rather than deferring doc reconciliation to a separate pass.

### Feature 1: Tag Taxonomy & Coverage Lint

**Description**: Establishes the frozen test-tag vocabulary as a usable convention on every test file and the CI lint that keeps the convention universal. Defines how a vitest test file declares its scope (`@l0`–`@l3`), determinism (`@deterministic`/`@stochastic`), and execution channel (`@ci`/`@scheduled`), applies all three tag positions to every existing test file, and ships a check that fails CI on any untagged file.

**User-Facing Value**: The Test Author learns one way to label a test and gets a loud, specific failure when a file is untagged instead of silent miscategorization; the CI Failure Triager can trust that every red job maps to a known layer.

**Scope Boundaries**:
- Includes: the physical encoding of the frozen tag vocabulary; applying scope + determinism + channel tags to every existing `*.test.ts` file; the whole-repo CI lint that fails on untagged files; the day-one tag disposition of the three pre-existing "L2" tests (`src/spawn/container-launch.test.ts`, `src/spawn/snapshot-build.test.ts`, `src/hatchery/legate-container.test.ts`), tagged `@l2 @deterministic @ci` in place; recording the corrected premise that those three tests mock `node:child_process` and exercise no real Docker (inherited by Feature 4); keeping the `CONTRIBUTING.md` tag-taxonomy reference current, correcting the "real Docker" mischaracterization of the three tests there, and trimming `docs/testing-strategy.md` to strategic-only content as this feature lands.
- Excludes: the per-script untagged-but-matched runtime guard (Feature 2); restructuring or re-scoping any existing test (the RFC keeps tests "tagged in place, not restructured"); the encoding/lint implementation mechanism (deferred to the spec phase, SD-102); authoring any `@stochastic` or `@scheduled` test (none exist in M1 — the vocabulary is declared, not yet exercised).

### Feature 2: Staged CI Pipeline

**Description**: Folds the layered local runner and the layered PR gate into one feature. Declares four tag-filtered npm scripts — `test:l0`, `test:l1`, `test:l2-cassette`, `test:l3-cassette` — that each run exactly one scope, with `npm test` rebuilt as a fail-fast sequential alias; and restructures `.github/workflows/ci.yml` so an `l0` job runs first as a fail-fast gate and `l1`, `l2-cassette`, `l3-cassette` fan out in parallel once `l0` succeeds, each job running only its corresponding `npm run test:*` script.

**User-Facing Value**: The Test Author runs just the layer they are iterating on locally; the CI Failure Triager reads the failing layer off the pipeline graph — a red `l0` is a broken-fundamentals stop-the-build, a red `l3-cassette` is a scenario regression — instead of doing log archaeology in one monolithic `npm test` bucket.

**Scope Boundaries**:
- Includes: the four `package.json` scripts filtering by tag; the per-script exit-non-zero-on-untagged-but-matched guard; `npm test` as the sequential, fail-fast-on-first-failure alias; resolving the `pretest` build-amplification so the alias does not rebuild redundantly; excluding quarantined tests from all four scripts (consumes Feature 3's quarantine-directory contract); rewriting `.github/workflows/ci.yml` into the four staged jobs with the L0-gate / parallel-fan-out shape, preserving the existing Node 20/22 build matrix; keeping the `CONTRIBUTING.md` script references and the Pre-Release Checklist's `npm test` step current as this feature lands.
- Excludes: the whole-repo coverage lint (Feature 1); the scheduled stochastic workflow (M6); any cassette runtime — the `l2-cassette`/`l3-cassette` scripts and jobs run whatever is tagged today, the cassette substrate is M3 and later; revisiting the gating shape (L0-only vs. L0+L1, RFC SD-006) — that resolves after M3 measures Cucumber-vs-vitest parallelism.

### Feature 3: Quarantine Routing Scaffold

**Description**: A `tests/quarantine/` directory plus a routing primitive that moves a failing test out of the staged gate without deleting it, excludes quarantined tests from the four staged scripts, and lists them in a generated `tests/quarantine/INDEX.md`.

**User-Facing Value**: Any Operator can park a known-bad test visibly rather than silencing it; the roster is the surface the M6 SLA timer and the Cassette Refresher will later read.

**Scope Boundaries**:
- Includes: the `tests/quarantine/` directory; the routing primitive; the directory-path exclusion contract Feature 2's scripts consume; the generated `tests/quarantine/INDEX.md`; keeping the `CONTRIBUTING.md` quarantine-primitive reference current as this feature lands.
- Excludes: the one-week SLA timer, overdue alerts, and weekly-report wiring (all M6); the source-tree location of the routing primitive (`src/testing/` vs. `tests/support/`) is an open inherited decision (SD-101).

### Feature 4: Test Layer Migration Policy

**Description**: A written "material change" policy — recorded in `CONTRIBUTING.md` under a "Test Layer Migration" heading — that enumerates verbatim the conditions under which the three pre-existing vitest L2 tests must be ported to Cucumber.js.

**User-Facing Value**: A Test Author touching `container-launch.test.ts`, `snapshot-build.test.ts`, or `legate-container.test.ts` reads from a written rule whether their change triggers a port, instead of relitigating "what counts as a material change" on every PR.

**Scope Boundaries**:
- Includes: the "Test Layer Migration" heading in `CONTRIBUTING.md` with the triggering conditions enumerated verbatim; the recorded starting state that the three tests are tagged `@l2` in place, mock `node:child_process` and exercise no real Docker, and stay in vitest until a material change (the corrected premise inherited from Feature 1).
- Excludes: the actual Cucumber.js port (M3 and later, on first material change); the day-one tag disposition and the broader `CONTRIBUTING.md` tag/script/quarantine references (Features 1–3).

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-101 | Does the `tests/quarantine/` quarantine-routing primitive (Feature 3) belong in `src/testing/` (production code, operator-facing CLI growth path) or `tests/support/` / `tests/quarantine/` (test-only code)? RFC SD-007 leaves the cassette-tooling location open for the same `src/testing/` vs. `tests/support/` reason, and M1's quarantine primitive faces the identical fork; the RFC's M1 criteria say `tests/quarantine/` for the directory but do not pin where the `quarantine.ts` routing logic lives. Picking differently changes which source tree Feature 3 writes into. | clarify:Overlap Between Features / Scope Within Milestone | Medium | Medium | open | — |
| SD-102 | Does the Feature 1 coverage lint enforce that every `*.test.ts` carries all three tag positions (scope + determinism + channel) as a single combined check, or are scope/determinism/channel enforced as three independent lints that could land in separate features? The RFC states all three positions must be present but does not say whether that is one lint deliverable or three. The choice affects whether Feature 1 is one cohesive feature or whether channel-tag enforcement could split out. | clarify:Feature Boundaries | Low | Medium | open | — |
| SD-103 | Does SD-101's open primitive-location question block the whole of Feature 3, or only the source-tree location of `quarantine.ts`? The `tests/quarantine/` directory path is pinned by the RFC M1 criteria and is the stable contract Feature 2 consumes; if a spec author reads SD-101 as blocking all of Feature 3, the F2→F3 dependency edge looks unsatisfiable until SD-101 resolves, when in fact only the routing logic's location is open. The feature map should make explicit that the directory-path contract is independent of the SD-101 location question. | plan-review:Logical gap | Important | Low | open | — |

## Dependency Order

Recommended specification sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| F1 | Tag Taxonomy & Coverage Lint | — | `specs/2026-05-23-006-tag-taxonomy-and-coverage-lint` |
| F3 | Quarantine Routing Scaffold | — | — |
| F4 | Test Layer Migration Policy | F1 | — |
| F2 | Staged CI Pipeline | F1, F3 | — |

The tag vocabulary is frozen by the RFC, so it is a contract rather than a deliverable: F1 and F3 have no prerequisites and can be specced in parallel. F2 (the merged staged CI pipeline) depends on F1's tag encoding (to filter by tag) and on F3's directory-path contract (to exclude quarantined tests). F4 couples to F1's day-one tag disposition of the three tests. Operator-doc updates are not a separate feature — each feature keeps the relevant `CONTRIBUTING.md` references current as it lands, and F1 carries the one-time `docs/testing-strategy.md` trim.

## Cross-Milestone Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| Milestone M3: First L2 Vertical Slice — Spawn → Steward | depended upon by | M3 lands its cassette-replayed L2 test into the `l2-cassette` CI job and the `test:l2-cassette` script this milestone creates. |
| Milestone M4: L1 Gap-Fill (Hatchery) | depended upon by | M4's new L1 tests are labeled with this milestone's taxonomy and run by the `l1` job / `test:l1` script. |
| Milestone M6: Scheduled Stochastic Suite + Recording Mode + Cost/Quarantine Tooling | depended upon by | M6 wires the one-week SLA timer (explicitly deferred here) onto this milestone's `tests/quarantine/INDEX.md` roster and exercises the `@stochastic`/`@scheduled` tags reserved here. |
| Milestone M7: L3 Vertical Slice | depended upon by | M7's L3 feature file is tagged `@l3 @deterministic @ci` and runs in the `l3-cassette` job via `npm run test:l3-cassette`, both created here. |

_Milestone M2 (Subsystem Contract Documentation Track) runs concurrently with M1 with no dependency in either direction — it touches `docs/subsystems/**` and a separate CI check, disjoint from M1's taxonomy/CI plumbing._
