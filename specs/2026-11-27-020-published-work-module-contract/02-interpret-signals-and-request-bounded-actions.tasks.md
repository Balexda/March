# Tasks: Interpret Signals and Request Bounded Actions

**Source**: `specs/2026-11-27-020-published-work-module-contract/published-work-module-contract.spec.md` — User Story 2\
**Data Model**: `specs/2026-11-27-020-published-work-module-contract/published-work-module-contract.data-model.md`\
**Contracts**: `specs/2026-11-27-020-published-work-module-contract/published-work-module-contract.contracts.md`\
**Story Number**: 02

---

## Slice 1: Publish Signal Arbitration and Bounded Action Rules
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Give the engine and module authors one versioned contract for interpreting destination signals and determining which intents are eligible.

**Justification**: Signal priority and action eligibility jointly determine what core can accept. Contract fixtures can verify both at the existing public boundary before lifecycle integration.

**Addresses**: FR-003 (landing delivery and close-out eligibility), FR-004, FR-005, AS 2.1–2.5.

### Tasks

- [x] **Complete the destination signal contract**

  Build on the published signal declarations to define destination reporting (AS 2.1).

  _Acceptance criteria:_
  - Reports contain checks, comments and approvals scoped to the item and destination. Checks distinguish platform from user checks, and the platform pair is mandatory for every destination.
  - Unsupported groups are empty and empty groups pass. A fixture with empty approvals and a failing platform merge gate still represents blocked landing.

- [x] **Define core signal arbitration**

  Publish deterministic arbitration rules over the signal categories in the companion contracts (AS 2.2).

  _Acceptance criteria:_
  - A simultaneous-signal fixture verifies the order of a conflict or moved base, unresolved review threads, failing user checks, conversation comments and the blocked merge gate. Approval state feeds the merge gate. Arbitration uses contract categories independent of provider check names and reviewer identities.
  - Core permits at most one action per steward per tick. An actionable signal without a matching responder yields needs-human. An eligible responder can propose an intent for a land-entry item without a steward.

- [x] **Classify and constrain step intents**

  Complete the public step vocabulary with fixed destructive classes and rules for accepting module requests (AS 2.3).

  _Acceptance criteria:_
  - Valid fixture requests use typed, item-scoped inputs from the closed vocabulary. Core derives the class from the discriminator and validates the requesting role and target before execution.
  - Invalid fixtures cover unknown steps, automatic branch deletion, worktree deletion and teardown, and generic module commands or callbacks. Core owns execution and destructive lifecycle actions. Module context exposes scoped data without write-capable GitHub or git clients or credentials.

- [x] **Define landing delivery and close-out eligibility**

  Apply the published report values to landing and origin close-out under scoped destination policy (AS 2.4).

  _Acceptance criteria:_
  - Destination policy can authorize core to land an eligible artifact and close out its origin. A confirmed landed report goes to the origin owner and every participating producer.
  - Only the sole origin owner can propose close-out after confirmed landing. Fixtures cover an eligible issue-originated item, a non-owner request, replay after the first qualifying artifact for an origin, and requests backed only by a verdict or approval. Failed close-out calls for needs-human and a correlated diagnostic on the item's trace.

- [x] **Bound automatic GitHub conflict recovery**

  Define the GitHub recovery eligibility rule and update the owning subsystem reference for the rules this slice publishes (AS 2.5).

  _Acceptance criteria:_
  - A fixture permits automatic core execution only for the built-in GitHub-repo destination after a failing *not possible* check for a conflict or moved base, targeting the item's own PR head with a valid expected-head lease.
  - Fixtures reject a different PR or branch, a missing or stale lease, a different destination and a request outside conflict recovery. Rejected or failed recovery has a diagnostic, and the result stays on the item's deterministic trace.
  - The subsystem reference covers signal groups and order, step vocabulary and classes, and eligibility for landing, close-out and conflict recovery.

**PR Outcome**: The public contract and fixtures specify signal arbitration and intent eligibility for future core integrations. Live execution, event delivery and lifecycle persistence belong to the lifecycle work.

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
| S1 | Publish Signal Arbitration and Bounded Action Rules | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US1 | depends on | Supplies the versioned export, facets, work-item and report types, and initial signal and intent declarations. |
| US3 | depended upon by | Uses the completed signal and step rules in the public contract reference. |
