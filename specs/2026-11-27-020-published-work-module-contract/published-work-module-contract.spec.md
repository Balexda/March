# Feature Specification: Published Work Module Contract

**Spec Folder**: `2026-11-27-020-published-work-module-contract`\
**Branch**: `master`\
**Created**: 2026-11-27\
**Status**: Draft\
**Input**: [RFC 2026-004, Milestone 1](../../docs/rfcs/2026-004-work-modules/work-modules.rfc.md#milestone-1-module-contract-v1-loader-and-conformance-kit)\
**Source Feature Map**: [Feature 1](../../docs/rfcs/2026-004-work-modules/01-module-contract-v1-loader-and-conformance-kit.features.md#feature-1-published-work-module-contract) — Published Work Module Contract

## Clarifications
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

### Session 2026-11-27

- RFC SD-001 assigns mergeability to the two mandatory platform checks and determines their priority.
- [Critical Assumption] Module packages are trusted in-process code. Core execution and its typed inputs enforce the contract for conforming modules.

## Artifact Hierarchy
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

RFC → Milestone → Feature → User Story → Slice → Tasks

## User Scenarios & Testing *(mandatory)*
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: optional -->

### User Story 1: Author Against the Published Contract (Priority: P1)

As a module author, I want one public interface for in-tree and external modules so that I can build a producer or destination against the open engine.

**Why this priority** — All module authors and both hosts need a common boundary.

**Independent Test** — Resolve the packed package's public subpath from an in-tree consumer and from an external package, then type-check representative producers, destinations and responders against it.

**Acceptance Scenarios**

1. **Given** the packed open package, **When** in-tree and external consumers import the versioned subpath, **Then** they resolve the same role, facet and vocabulary declarations and the same contract version.
2. **Given** Smithy work identified by a bare verb and non-Smithy work with a namespaced kind, **When** either is represented in the contract, **Then** the Smithy alias resolves to its canonical `smithy/` kind and the other kind retains its producer namespace.
3. **Given** an issue-originated item handed from triage to Smithy, **When** the successor item is formed, **Then** its origin and sole close-out owner are preserved. The shape also represents an already-open Dependabot PR entering at land without a steward.
4. **Given** a landed artifact or a close-out result, **When** a module consumes the report, **Then** the outcome correlates to the work item, and the landed report identifies the artifact that landed.

### User Story 2: Interpret Signals and Request Bounded Actions (Priority: P1)

As a March operator, I want every module to use the same signal and step vocabulary so that unattended work follows the same priorities and safety limits.

**Why this priority** — Consumers need a safe, unambiguous contract before they can use it to drive work.

**Independent Test** — Inspect contract fixtures for simultaneous PR signals, an unavailable approval group, a landed issue-originated item and valid and invalid action requests.

**Acceptance Scenarios**

1. **Given** any destination, **When** it reports signals, **Then** it reports checks, comments and approvals, marks checks as platform or user, and includes both platform checks even if the other groups are empty. An empty group passes.
2. **Given** a conflict or moved base, unresolved review threads, failing CI, conversation comments and a blocked merge gate together, **When** the core arbitrates, **Then** the contract ranks them in that order, permits at most one action per steward per tick and routes an unpaired actionable signal to needs-human.
3. **Given** a module action request, **When** it is evaluated against the public contract, **Then** it is a typed intent from the closed vocabulary with a fixed destructive class, and only core can execute it. A request to automate a destructive step is invalid, including one disguised as a module command. The module receives no write-capable GitHub or git client or credential.
4. **Given** destination policy permits landing and close-out, **When** an eligible artifact lands, **Then** core may execute both steps automatically, routes the landed report to all participating producers and gives exclusive close-out authority to the origin owner. A verdict or approval alone cannot authorize issue closure.
5. **Given** a failing *not possible* check on a GitHub PR, **When** conflict recovery requests a force-push, **Then** only the item's own PR head branch with a valid lease qualifies for automatic execution. Core owns the execution and the result stays on the item's trace.

### User Story 3: Verify Compatibility and Ownership (Priority: P2)

As a maintainer, I want the compatibility and execution rules documented so that downstream authors can tell what may change and where private connectors integrate.

**Why this priority** — The reference can be verified against the public shape and safety rules once both are defined.

**Independent Test** — Compare the subsystem reference to the export and check a version matrix covering patch, minor and major differences.

**Acceptance Scenarios**

1. **Given** a pre-1.0 host, **When** module and host versions are compared, **Then** differing majors or minors are incompatible and patch-only differences are compatible. From 1.0 onward the major must match.
2. **Given** a module author reading the subsystem contract reference, **When** they check its coverage, **Then** it documents the export, roles and facets, signal groups and order, step vocabulary and destructive classes, and the compatibility rule. It labels the contract unstable until Dependabot migrates.
3. **Given** an enterprise connector author, **When** they consult the open-core boundary record, **Then** it identifies the public versioned module contract as the open seam that private connectors consume.

### Edge Cases

- A land-entry item has no steward. A responder can return an eligible step without a steward session.
- A destination without an approval group still reports both platform checks. An empty approval group cannot override a failing *not permitted* check.
- A missing or stale lease, another branch or a force-push requested outside conflict recovery falls outside the automatic recovery step.

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| US1 | Author Against the Published Contract | — | specs/2026-11-27-020-published-work-module-contract/01-author-against-published-contract.tasks.md |
| US2 | Interpret Signals and Request Bounded Actions | US1 | — |
| US3 | Verify Compatibility and Ownership | US1, US2 | — |

## Requirements *(mandatory)*
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: recommended -->

### Functional Requirements

- **FR-001** (US1) — Publish the versioned contract through one subpath of the open package, `@balexda/march/modules/v0`, for all modules. Define the observe facet for Herald and the act facet for Legate, with producer, destination and responder interfaces.
- **FR-002** (US1) — Represent work with a producer-namespaced kind, origin, destination, entry stage and exactly one close-out owner serving the origin. Preserve the origin and owner in handoff and retain the existing bare Smithy verbs as aliases.
- **FR-003** (US1, US2) — Define correlated landed and close-out reports. An actual landing triggers delivery to the origin owner and participating producers. Only the owner may propose close-out, and first-artifact close-out applies once per origin.
- **FR-004** (US2) — Define checks, comments and approvals, with mandatory *not possible* and *not permitted* platform checks separate from user checks. Core arbitration follows the declared rank without interpreting provider check names or reviewer identities. Unpaired signals escalate to needs-human.
- **FR-005** (US2) — Define a closed, classified step vocabulary. Core executes intents, owns deletion and teardown, and rejects unknown intents and automatic destructive configuration. Destination policy may authorize land and close-out. The only automatic force-push in this contract is lease-protected conflict recovery on the item's PR head branch through the GitHub-repo destination.
- **FR-006** (US3) — Provide the contract compatibility rule in the public interface and subsystem `contract.md`. Document the unstable period through Dependabot migration and identify the open module seam in the open-core boundary record.

### Key Entities

- **Module definition** — Versioned declaration of role and capabilities.
- **Work item and handoff** — The unit of work and the origin-preserving producer transition.
- **Signal set** — Destination observations grouped for core arbitration.
- **Intent** — A classified request for a core-owned step.
- **Landed and close-out reports** — Outcomes used for routing, correlation and traceability.

## Assumptions
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- The split between read observations and core-owned execution applies the [March vision](../../docs/vision.md) and [operating philosophy](../../docs/operating-philosophy.md). Needs-human is a surfaced outcome, execution access stays in core, and failures end with a diagnostic outcome.
- The compatibility decision is defined here. Host startup enforcement and profile registration validation use this contract in their own features.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Out of Scope
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- Lifecycle execution, event and fold migration, handler migration, and teardown implementation.
- Module loading, profile bindings, runnable conformance kit, handler inventory, and four-flow paper review.
- Isolation of in-process module code and a general destination-command authorization mechanism.

## Success Criteria *(mandatory)*
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

### Measurable Outcomes

- **SC-001** — Both consumer locations resolve one published contract and can represent Smithy work, Dependabot land entry and an origin-preserving handoff using only the public boundary.
- **SC-002** — Every signal category and step has a documented classification. The simultaneous-signal case has one unambiguous priority, and only the bounded GitHub conflict-recovery case can request an automatic force-push.
- **SC-003** — The subsystem reference and open-core record pass the documentation scenarios, and the compatibility matrix matches the public rule.
