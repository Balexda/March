# Contracts: Published Work Module Contract
<!-- applicability: code-shaped features only -->

**Source RFC**: [RFC 2026-004](../../docs/rfcs/2026-004-work-modules/work-modules.rfc.md)\
**Source Feature Map**: [Feature 1](../../docs/rfcs/2026-004-work-modules/01-module-contract-v1-loader-and-conformance-kit.features.md#feature-1-published-work-module-contract)

## Interfaces
<!-- audience: builder; mode: reference; length: tables only; diagram: optional; examples: required; applicability: code-shaped features only -->

### Published package boundary

| Surface | Inputs | Outputs | Failure |
|---------|--------|---------|---------|
| Versioned subpath `@balexda/march/modules/v0`, declared in the package `exports` map | Same import specifier for in-tree and installed consumers. The path segment carries the contract major, and a new major publishes a new subpath such as `modules/v1`. | Contract version and public roles, facets, work-item, signal, intent, and report declarations | A consumer depending on private March imports is outside the published contract. |
| Contract compatibility | Host and module contract versions, independent of npm package versions | Compatible if majors match and, for major zero, minors also match. Patch differences do not affect compatibility. | Invalid or incompatible versions are refused by the host integration. The host loader owns startup enforcement and diagnostics. |

For a host declaring `0.2.0`, `0.2.1` is compatible and `0.3.0` and `1.0.0` are incompatible. For a host declaring `1.2.0`, `1.3.0` is compatible and `2.0.0` is incompatible. Mark the pre-1.0 contract unstable until Dependabot migrates.

### Role and facet boundary

The signatures below describe capabilities and value shapes. Context contains scoped read inputs and item or binding metadata. It carries no write-capable GitHub or git client or credential.

| Provider and facet | Operation | Input | Output |
|--------------------|-----------|-------|--------|
| Producer observe, called by Herald | Discover | Bound profile and source observations | Candidate items with declared kinds, origin, destination, entry stage and close-out owner |
| Producer act, called by Legate | Prepare or hand off | Current item and planning context | Work instructions or a handoff proposal, including the receiving producer and its kind |
| Producer act, called by Legate | Match and respond | Work item, actionable signal and optional steward, using a registration for the item's kind and signal category | Eligible declarative intent, or no response |
| Destination observe, called by Herald | Observe destination | Work item and bound destination | Signal set for the item |
| Destination act, called by Legate | Evaluate and propose landing or review | Work item, signal set and destination policy scoped to repository or board and item kind | Eligible intents, or a blocked decision |
| Origin-serving module act, called by Legate | Propose close-out | Work item and successful landed report | Close-out intent for the item's origin, or no action when already closed |
| Participating producer act, called by Legate | Consume landing outcome | Landed report for a previously handled item | Optional eligible follow-up intent, such as recording the artifact link |

Invalid declarations, outputs outside the role's capabilities, unknown intent discriminators and invalid step targets yield diagnostic failure before execution. No matching responder for an actionable signal yields needs-human. Lifecycle diagnostics and module activity belong on the item's deterministic trace.

### Signal set and arbitration

| Group | Signal | Arbitration rank | Meaning |
|-------|--------|------------------|---------|
| Checks | Platform *not possible* | 1 | Conflict or moved base prevents landing. |
| Comments | Review thread | 2 | Unresolved review feedback. |
| Checks | User check | 3 | A configured check such as CI fails. |
| Comments | Conversation comment | 4 | Actionable feedback outside a review thread. |
| Checks | Platform *not permitted* | 5 | The merge gate is blocked by approval, permissions or branch rules. |
| Approvals | Approval state | Via rank 5 | Input to the destination's merge gate. |

Destinations always run and report both platform checks. Unsupported groups are empty and empty groups pass. A failed platform check still blocks its gate. Core ranks by the contract categories and allows at most one action per steward per tick. Steward self-reports are core lifecycle inputs.

### Closed step vocabulary

The following discriminators define the initial semantic vocabulary. Every step has a contract-owned destructive class. Core derives the class from the discriminator and validates role, scope and targets before execution. A module cannot supply an executable callback or a generic command.

| Step | Typed target or input | Destructive class and execution eligibility |
|------|-----------------------|--------------------------------------------|
| Implement or remediate | Work item and instructions, plus the steward binding where applicable | Non-destructive intent, executed under core dispatch and recovery limits |
| Request review | Item artifact and initial or fresh review request | Non-destructive intent, governed by destination review policy |
| Update labels | Item artifact or origin and a declarative label change | Non-destructive intent, scoped to the item |
| Write feedback | Item artifact or origin and a comment or sticky-note update | Non-destructive intent, scoped to the item |
| Recover GitHub PR conflict | Item PR and its head branch, with the expected head for lease protection | Bounded recovery, automatic only under the built-in GitHub-repo rule for the item's own head after a conflict or base movement. An absent or stale lease rejects the write. |
| Land artifact | Item and bound destination artifact | Policy-controlled land, eligible for automatic execution under destination policy and core safety |
| Close out origin | Successful landed report and item origin | Policy-controlled close-out, eligible for automatic execution only for the origin owner |
| Delete branch | Branch registered to the item | Destructive, core-only |
| Delete worktree | Worktree registered to the item | Destructive, core-only |
| Teardown | Registered item resources | Destructive, core-only |

Core rejects configuration that makes a destructive step automatic through a module. The GitHub recovery step is a narrow core-executed operation and grants no general branch rewrite capability. A rejected or failed execution produces a diagnostic on the item's trace.

## Events / Hooks
<!-- audience: builder; mode: reference; length: tables only; diagram: optional; examples: required; applicability: code-shaped features only -->

| Outcome | Trigger | Payload and routing |
|---------|---------|---------------------|
| Landed report | Core confirms successful landing | Item ID, destination, artifact reference. Delivered to the module serving the origin and to all participating producers. |
| Close-out report | Core resolves close-out | Item ID, origin, owner, outcome, and diagnostic on failure. Close-out is once per origin, and a failed close-out yields needs-human and an errored span. |

These are contract values. Herald event transport and fold schema belong to the lifecycle work.

## Integration Boundaries
<!-- audience: builder; mode: reference; length: tables only; diagram: optional; examples: required; applicability: code-shaped features only -->

| Boundary | Direction | Contract | Failure mode |
|----------|-----------|----------|--------------|
| Open package ↔ in-tree and private modules | Package to consumers | Shared public subpath and compatibility rule | An incompatible module cannot be admitted. |
| Herald ↔ observe facets | Scoped inputs to modules, typed observations to Herald | Read-side discovery and signals | Invalid outputs are refused with diagnostics. |
| Legate ↔ act facets | Scoped item context to modules, typed intents to Legate | Core arbitrates, validates and executes | Invalid intent fails before execution. Missing response escalates. |
| Core ↔ GitHub and git | Core-side effects only | Destination policy controls eligible actions. Conflict recovery writes only the item's PR head with a lease. | Rejected target, failed lease or execution failure is traceable to the item. |
| Published surface ↔ repo reference | Contract to maintainers and authors | Subsystem `contract.md` covers the subpath, roles and facets, signal groups and arbitration, step classes and compatibility, including the unstable period. The [open-core boundary](../../docs/open-core-boundary.md) identifies this contract as the open seam consumed by private connectors. | Documentation drift fails the reference acceptance scenarios. |
