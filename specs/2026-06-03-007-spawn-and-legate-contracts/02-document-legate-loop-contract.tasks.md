# Tasks: Document Legate Loop Contract

**Source**: `specs/2026-06-03-007-spawn-and-legate-contracts/spawn-and-legate-contracts.spec.md` - User Story 2
**Data Model**: `specs/2026-06-03-007-spawn-and-legate-contracts/spawn-and-legate-contracts.data-model.md`
**Contracts**: `specs/2026-06-03-007-spawn-and-legate-contracts/spawn-and-legate-contracts.contracts.md`
**Story Number**: 02

---

## Slice 1: Author Legate Loop Contract
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Deliver `docs/subsystems/legate/contract.md` as a complete, testable documentation contract for Legate's autonomous loop inputs, service observations, event cursor, slice-state projection, dispatch, babysit, trace ownership, terminal outcomes, and externally visible failures.

**Justification**: User Story 2 is documentation-only and all acceptance scenarios describe one Legate loop boundary. Splitting command/service inputs from cursor, dispatch, babysit, trace, or terminal behavior would leave L2 tests without a complete diagnostic target, while adding Spawn content, cross-contract consolidation, checkers, freshness globs, AUTOGEN generation, CI enforcement, or runtime changes would cross into other stories or later features.

**Addresses**: FR-001, FR-002, FR-003, FR-008, FR-009, FR-010, FR-011, FR-012, FR-013, FR-014; Acceptance Scenarios 2.1, 2.2, 2.3, 2.4

### Tasks

- [ ] **Author the Legate public interface contract**

  Create `docs/subsystems/legate/contract.md` with the required contract section shape and a Legate-owned `## Public Interface` section. Document the operator-visible loop command or process surface, configuration inputs, observed service dependencies, exported loop and serve entrypoint surface, slice decision outputs, and terminal diagnostic outputs as human-authored prose while leaving generated extraction content empty.

  _Acceptance criteria:_
  - The contract contains `## Public Interface`, `## Invariants`, and `## Error Modes` as H2 sections.
  - `## Public Interface` contains an empty `<!-- BEGIN AUTOGEN -->` / `<!-- END AUTOGEN -->` marker pair.
  - Public input coverage includes repository path, profile or manager context, Herald cursor, projected slice state, service readiness, and steward attachment metadata.
  - Public output coverage includes Hatchery dispatch request metadata, event cursor, slice decision, terminal outcome, deterministic trace relationship, and bounded diagnostic output.
  - The public interface describes Legate's exported-signature-level TypeScript surface for loop startup, service startup, configuration, and orchestration entrypoints as prose, without requiring AUTOGEN output in this slice.
  - Herald, Hatchery, Brood, Castra, and Steward are referenced only as integration boundaries; their route, lifecycle authority, session-hosting, and role-interface contracts are not re-authored.
  - No Spawn contract change, Steward role contract, contract checker, freshness mapping, AUTOGEN generator, CI enforcement, or runtime behavior change is introduced.

- [ ] **Document Legate loop invariants**

  Fill `## Invariants` with assertable cursor, projection, dispatch, babysit, trace, and terminal-state promises owned by Legate. The contract should support L2 tests that diagnose stalled slices, missing events, duplicate events, relaunch decisions, and terminal outcomes without reading terminal logs or re-authoring service contracts.

  _Acceptance criteria:_
  - Herald cursor ownership covers persisted cursor state, replay behavior, duplicate or stale event handling, and event-delta application to slice state.
  - Slice-state promises cover planned or runnable work, running workers, attached stewards, relaunch candidates, blocked or waiting work, and terminal outcomes.
  - Dispatch behavior documents the Hatchery request metadata Legate supplies, including task identity, branch or slice identity, profile/backend context, and slice correlation.
  - Trace prose states that `legate.dispatch` is the slice trace origin and service-side actions nest under the deterministic slice trace rather than starting unrelated roots.
  - Babysit behavior covers timeout, missing worker, missing steward, relaunch, cleanup, and terminal-failure decisions as clean events or outcomes instead of interactive prompts.
  - Terminal outcome promises identify the labels or diagnostic classes that stop further autonomous action and the events or service state that justify them.
  - The invariants cite the low-touch execution model from `docs/vision.md` and the autonomous-component rules from `docs/operating-philosophy.md` when describing noninteractive recovery and clean terminal outcomes.

- [ ] **Document Legate observable error modes**

  Fill `## Error Modes` with externally visible failure behavior for service readiness, repository or configuration input, event streams, slice projection, Hatchery dispatch, worker or steward loss, timeout, relaunch, terminal cleanup, trace correlation, and bounded diagnostics. Keep the error contract focused on deterministic outcomes and escalations rather than interactive recovery.

  _Acceptance criteria:_
  - Missing repository context, invalid profile or manager metadata, missing service readiness, unavailable Herald, unavailable Hatchery, unavailable Brood, unavailable Castra, and local dependency failures are covered.
  - Cursor gaps, malformed events, duplicate events, stale slice state, contradictory projection state, and replay exhaustion name the externally visible diagnostic or bounded retry outcome.
  - Hatchery dispatch failure, worker launch failure, worker loss, steward attachment loss, steward session loss, timeout, relaunch exhaustion, and cleanup failure are covered.
  - Each error mode names the externally visible outcome, event, terminal label, or diagnostic class a caller or test can assert.
  - Cleanup failures retain observable slice or service-state evidence and do not mask the original terminal outcome.
  - The contract states failures exit cleanly, emit events, or surface diagnostics rather than blocking on an interactive prompt.

**PR Outcome**: Legate's loop contract exists as a stable documentation target for L2 tests and later freshness or AUTOGEN tooling. It records the accepted loop inputs, exported public surface, service observations, cursor and state-projection promises, dispatch and trace behavior, babysit and relaunch decisions, terminal outcomes, and externally visible failure modes without changing runtime code or authoring Spawn/Steward contracts.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

None - all ambiguities resolved.

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Author Legate Loop Contract | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 3: Record Cross-Contract Ownership Boundaries | depended upon by | US3 consolidates Spawn and Legate boundary references after both subsystem contracts exist. |
