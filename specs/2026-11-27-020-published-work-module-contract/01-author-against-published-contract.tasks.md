# Tasks: Author Against the Published Contract

**Source**: `specs/2026-11-27-020-published-work-module-contract/published-work-module-contract.spec.md` — User Story 1\
**Data Model**: `specs/2026-11-27-020-published-work-module-contract/published-work-module-contract.data-model.md`\
**Contracts**: `specs/2026-11-27-020-published-work-module-contract/published-work-module-contract.contracts.md`\
**Story Number**: 01

---

## Slice 1: Publish the Work Module Authoring Contract
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Give in-tree and external authors one versioned import for declaring modules and representing work and outcomes.

**Justification**: The package export ships with the declarations that make it usable by both kinds of consumer.

**Addresses**: FR-001, FR-002, FR-003 (report declarations), AS 1.1–1.4.

### Tasks

- [ ] **Publish the versioned package entrypoint**

  Wire `@balexda/march/modules/v0` into the package export map and existing build and package flow. Export the contract version independently of the npm package version (AS 1.1).

  _Acceptance criteria:_
  - The normal build produces an ESM entry and TypeScript declarations included in the packed package. The CLI binary remains usable.
  - An in-tree consumer and a separate consumer installed from the tarball resolve the same subpath, observe the same contract version and type-check representative producers, destinations and responders using only that public import.

- [ ] **Declare the module roles and facets**

  Define the Herald observe and Legate act interfaces from the companion contracts. Expose the signal and step vocabulary declarations used by those signatures through the public entrypoint (AS 1.1).

  _Acceptance criteria:_
  - The interfaces cover discovery, preparation and handoff, responder registration and response, destination observation and proposals, and outcome hooks.
  - Act outputs are declarative. Context provides scoped inputs and optional steward metadata where applicable, with no write-capable GitHub or git client or credential.
  - The owning subsystem contract reference documents the surface introduced in this slice.

- [ ] **Model canonical kinds and work entry**

  Define work identity, destination binding and stages from the companion data model. Expose Smithy alias resolution on the public boundary (AS 1.2, AS 1.3).

  _Acceptance criteria:_
  - Each specified bare Smithy verb resolves to its corresponding `smithy/<verb>` kind. Other producer-namespaced kinds retain their namespace.
  - A work item identifies its current producer, canonical kind, origin, destination, entry stage and one close-out owner. An existing Dependabot PR can enter at land with its artifact and no steward.

- [ ] **Preserve ownership across handoffs**

  Define the handoff proposal and successor contract for producer changes. Use the predecessor as the source of origin and close-out ownership (AS 1.3).

  _Acceptance criteria:_
  - A triage-to-Smithy handoff correlates to the predecessor, uses a kind declared by the receiving producer, and preserves the issue origin, sole close-out owner and record of participating producers.

- [ ] **Expose correlated outcome reports**

  Define the landed and close-out reports used by the act facets. Represent landing, close-out and failure diagnostics as contract values (AS 1.4).

  _Acceptance criteria:_
  - Both reports correlate by item ID. A landed report identifies the destination and landed artifact. A close-out report identifies the origin, owner and outcome.
  - Close-out failure carries a diagnostic, and replay can represent an already-completed origin.

**PR Outcome**: Authors can use the packed contract to declare modules, express Smithy and Dependabot work, preserve ownership across handoffs and consume correlated outcomes.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Open Implementation Questions
<!-- audience: builder; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

_None — no open implementation questions._

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Publish the Work Module Authoring Contract | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US2 | depended upon by | US2 completes the signal and intent rules and specifies landing delivery, exclusive close-out authority and once-per-origin behavior. |
| US3 | depended upon by | US3 adds the public compatibility rule and completes the reference and open-core documentation. |
