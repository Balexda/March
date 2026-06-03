# Data Model: Containerized-Service Contracts (Hatchery, Brood, Herald, Castra)

## Overview

This model supports documentation-only service contracts for the four March subsystems that expose Fastify HTTP APIs. It captures the contract artifacts, route-surface entries, service readiness promises, event/session wire shapes, and Brood teardown invariants that later L2/L3 tests and freshness checks consume.

## Entities

### 1) Service Contract (`docs/subsystems/<name>/contract.md`)

Purpose: Represents one explicit HTTP contract artifact for a containerized March service.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | repo-relative path | Yes | One of `docs/subsystems/hatchery/contract.md`, `docs/subsystems/brood/contract.md`, `docs/subsystems/herald/contract.md`, or `docs/subsystems/castra/contract.md`. |
| `subsystem` | enum | Yes | `hatchery`, `brood`, `herald`, or `castra`. |
| `publicInterfaceSection` | markdown H2 section | Yes | Documents the service's HTTP route surface. |
| `invariantsSection` | markdown H2 section | Yes | Documents assertable service promises. |
| `errorModesSection` | markdown H2 section | Yes | Documents observable failure conditions and responses. |
| `autogenRegion` | marker pair | Yes | Empty `<!-- BEGIN AUTOGEN -->` / `<!-- END AUTOGEN -->` pair inside `## Public Interface`. |

Validation rules:
- The contract has exactly one `## Public Interface`, `## Invariants`, and `## Error Modes` section.
- The public-interface section includes route-surface entries for every documented HTTP route.
- The AUTOGEN marker pair is present but empty in this feature.
- Invariants and error modes are written as assertable statements.

### 2) HTTP Route Surface (`http_route_surface`)

Purpose: Describes a service route in a testable form.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `service` | enum | Yes | Owning service. |
| `method` | HTTP method | Yes | `GET`, `POST`, `PATCH`, or `DELETE` for current routes. |
| `path` | route template | Yes | Fastify route path, using `:id` for params. |
| `auth` | enum | Yes | `open` or `bearer-token`, based on the service route. |
| `requestEnvelope` | markdown table/prose | Yes | Params, query, body, or headers accepted by the route. |
| `responseEnvelope` | markdown table/prose | Yes | Success response shape and status code. |
| `errorBehavior` | markdown table/prose | Yes | Externally visible validation, not-found, conflict, dependency, or internal errors. |

Validation rules:
- Route paths use templates rather than concrete ids.
- Error behavior includes the HTTP status and body shape visible to callers.
- Request fields that current validation drops or ignores are not documented as echoed outputs.

### 3) Service Readiness Contract (`service_readiness_contract`)

Purpose: Captures health and readiness route behavior for service orchestration.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `service` | enum | Yes | Hatchery, Brood, Herald, or Castra. |
| `healthRoute` | route reference | Yes | `/healthz` for Hatchery, Brood, and Herald; `/healthz` for Castra. |
| `readyRoute` | route reference | No | `/readyz` for Hatchery, Brood, and Herald. |
| `statusRoute` | route reference | No | `/status` for Herald and Castra. |
| `dependencies` | list | Yes | Dependencies surfaced in readiness/status responses. |
| `gatingRules` | list | Yes | Which dependencies determine the status code. |

Validation rules:
- Health routes return a simple OK body.
- Readiness contracts distinguish gating dependencies from best-effort probes.
- Status routes document summary fields rather than internal metrics labels.

### 4) Brood Teardown Invariant (`brood_teardown_invariant`)

Purpose: Records the cleanup ordering that Brood must preserve.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `orderedSteps` | ordered list | Yes | `archive`, `container`, `steward`, `worktree`, `branch`. |
| `worktreeRemoval` | rule | Yes | Remove only the exact tracked worktree path after steward removal is complete. |
| `branchRemoval` | rule | Yes | Delete only the exact tracked branch name. |
| `neverPrune` | boolean | Yes | Must be true; blanket `git worktree prune` is outside the contract. |
| `deferredCleanupCondition` | rule | Yes | Worktree and branch cleanup are skipped if steward removal fails. |

Validation rules:
- Container cleanup precedes steward cleanup.
- Worktree cleanup follows steward cleanup and uses exact tracked path data.
- A failed steward cleanup prevents worktree and branch cleanup in the same teardown attempt.

## Relationships

- A Service Contract contains many HTTP Route Surface entries.
- A Service Contract contains one Service Readiness Contract where the service exposes health, readiness, or status routes.
- Brood's Service Contract contains one Brood Teardown Invariant.
- Route Surface entries for Herald reference the shared event taxonomy and projection shapes.
- Route Surface entries for Castra reference the shared interactive-session and uniform error-envelope shapes.

## State Transitions

### Service contract lifecycle

1. `scaffolded` -> `authored`
   - Trigger: This feature writes the service-specific route, invariant, and error-mode content.
   - Effects: The contract becomes a test target for L2 and future freshness checks.

2. `authored` -> `autogen_populated`
   - Trigger: A later extraction tool writes generated TypeScript surface content between the marker pair.
   - Effects: The human-authored HTTP route contract remains stable outside the generated block.

### Brood teardown lifecycle

1. `active` -> `tearing-down`
   - Trigger: A teardown request is accepted.
   - Effects: The session group is marked as tearing down before destructive cleanup starts.

2. `tearing-down` -> `torndown`
   - Trigger: Archive, container, steward, worktree, and branch cleanup complete without a steward-removal deferral.
   - Effects: The registry records the session as torn down.

3. `tearing-down` -> `tearing-down`
   - Trigger: Steward removal fails.
   - Effects: Worktree and branch cleanup are deferred so the next teardown request can retry without orphaning a live session checkout.

## Identity & Uniqueness

- A Service Contract is uniquely identified by its repo-relative contract path.
- An HTTP Route Surface is uniquely identified by `(service, method, path)`.
- A Brood Teardown Invariant is uniquely identified by the Brood contract path.
- A readiness/status contract is uniquely identified by `(service, route)`.
