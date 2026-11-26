# Feature Map: Module Contract v1, Loader and Conformance Kit

**Source RFC**: `docs/rfcs/2026-004-work-modules/work-modules.rfc.md`
**Milestone**: 1 — Module Contract v1, Loader and Conformance Kit
**Created**: 2026-11-26

## Features
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

### Feature 1: Published Work Module Contract

```yaml
kind: backend
```

**Description**: Publish the common producer, destination and responder interfaces through a versioned subpath export of the open package. In-tree and external modules consume the same export.

**User-Facing Value**: Module authors can build against a published interface and know which actions the engine can execute on their behalf.

**Scope Boundaries**:
- Includes the work-item model with namespaced kinds, bare Smithy verb aliases, origin, destination, entry stage, exactly one close-out owner and producer handoff that preserves the origin. Define landed and close-out reports and the observe and act facets.
- Includes checks, comments and approvals. Mark checks as platform or user. Destinations always run the *not possible* and *not permitted* platform checks. Document the arbitration order from conflict through review threads, CI, conversation comments and finally the merge gate.
- Includes a closed declarative step vocabulary with a destructive class on every step. Core owns execution, branch and worktree deletion and teardown. Destination policy can automate land and close-out within those rules. The contract accounts for the existing lease-protected conflict recovery on the item's own PR branch.
- Includes the subsystem `contract.md` covering the export, roles, signals, step classes and compatibility rule. Document the pre-1.0 contract as unstable until Dependabot migrates. A major mismatch is incompatible, and a minor mismatch is incompatible before 1.0. Record the published contract as the open seam for private connectors in [the open-core boundary](../../open-core-boundary.md). Apply [March's vision](../../vision.md) and [operating philosophy](../../operating-philosophy.md) to the module and core responsibilities.
- Excludes lifecycle execution, fold migration, isolation of module code and a generic authorization mechanism for destination commands.

### Feature 2: Module Loading and Startup Compatibility

```yaml
kind: backend
```

**Description**: Resolve installed modules by package specifier and load their observe and act facets in Herald and the legate respectively.

**User-Facing Value**: An operator can start the open engine without private modules and diagnose an incompatible installation from the startup error.

**Scope Boundaries**:
- Includes both startup paths refusing an incompatible module before work begins. The error names the module, its contract version and the host contract version. Cover major mismatches and pre-1.0 minor mismatches at both hosts.
- Includes M1 startup diagnostics and associated dashboard visibility through existing observability surfaces, with errored spans for new failure paths.
- Excludes package discovery, private module deployment packaging and hot reload.

### Feature 3: Profile Module Bindings and Known Kinds

```yaml
kind: backend
```

**Description**: Store module bindings in Herald's profile registry. Derive known kinds from the bound producers' declarations and use the resulting kind and alias lookup for binding validation and landing-row lookup.

**User-Facing Value**: An operator can register a new kind through profile configuration and resolve its landing row without editing March source.

**Scope Boundaries**:
- Includes a profile's single repository and multiple destination bindings, validation through `POST /profiles`, and the M1 CLI surface for registering and inspecting bindings. Reject any binding that makes a destructive step automatic and any binding that names an unknown kind.
- Includes replacing `KNOWN_TASK_TYPES` with registry-driven lookup for the profile validation and kind consumers, preserving bare Smithy aliases during migration. Verify that a kind declared by a bound producer passes validation and resolves its landing rows without a hard-coded list edit. Expose this same lookup to M3 for fail-closed landing.
- Excludes migrating stored merge policy, changing automatic landing decisions, and moving the existing CLI merge-policy command.

### Feature 4: Module Author Conformance Kit

```yaml
kind: backend
```

**Description**: Give module authors a repeatable way to check their packages against the published contract. Exercise the kit with a fixture producer and fixture destination installed outside the source tree.

**User-Facing Value**: A module author can check the same public interface and package loading path used by the open engine before deploying a module.

**Scope Boundaries**:
- Includes resolving and exercising both fixtures by installed package specifier against the published export alone. Both fixtures pass conformance, and the open engine starts and runs on the fixture setup with zero private modules.
- Excludes converting the production producers and destinations or choosing how to package private modules for deployment.

### Feature 5: Handler Inventory and Contract Flow Review

```yaml
kind: backend
```

**Description**: Record which responsibilities the contract assigns to the core, producers and destinations. Check the contract against the four flows in the [work modules PRD](../../prds/2026-002-work-modules.prd.md) before the live migrations begin.

**User-Facing Value**: Operators and module authors can see where existing behavior belongs and identify gaps in the published contract before moving a production flow.

**Scope Boundaries**:
- Includes classifying all 13 handlers imported by [the coordinator](../../../src/legate/loop/coordinator.ts) as core, producer or destination, with responsibility-level notes for mixed handlers such as babysit.
- Includes mapping every step of Smithy plan-to-merge, Dependabot land-entry, CodeRabbit re-review and issue triage through Smithy handoff and close-out to contract roles, signal groups and steps. Account for all steps, explicitly mapping conflict or base movement to *not possible* and the merge gate to *not permitted* within platform checks.
- Excludes moving handlers and claiming runtime parity from the paper-check.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

_No unresolved specification debt remains._

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| F1 | Published Work Module Contract | — | — |
| F2 | Module Loading and Startup Compatibility | F1 | — |
| F3 | Profile Module Bindings and Known Kinds | F2 | — |
| F4 | Module Author Conformance Kit | F2 | — |
| F5 | Handler Inventory and Contract Flow Review | F1 | — |

## Cross-Milestone Dependencies
<!-- audience: reviewer; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

| Dependency | Direction | Notes |
|------------|-----------|-------|
| Milestone 2: Core Work-Item Lifecycle and Identity | depended upon by | Implements the published work-item, stage, signal and responder contracts in the core. |
| Milestone 3: GitHub-Repo Destination and Policy Migration | depended upon by | Implements destination behavior, uses the registry-driven kind lookup to fail closed and migrates existing landing policy. |
