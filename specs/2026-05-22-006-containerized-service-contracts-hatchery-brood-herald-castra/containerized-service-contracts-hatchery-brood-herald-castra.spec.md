# Feature Specification: Containerized-Service Contracts (Hatchery, Brood, Herald, Castra)

**Spec Folder**: `2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra`
**Branch**: `feature/smithy/mark/layered-testing-framework-m2-f2`
**Created**: 2026-05-22
**Status**: Draft
**Input**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` Feature 2, with RFC context from `docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md`.
**Source Feature Map**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` - Feature 2: Containerized-Service Contracts (Hatchery, Brood, Herald, Castra)

## Clarifications

### Session 2026-05-22

- The slice is documentation-only: it authors the four containerized-service contract artifacts but does not implement checkers, source globs, AUTOGEN extraction, or runtime route changes.
- The contracts consume the required section schema established by Feature 1: `## Public Interface`, `## Invariants`, and `## Error Modes`.
- The public interface for Hatchery, Brood, Herald, and Castra is their HTTP route surface, including method, path, request envelope, response envelope, and externally visible error shape.
- Brood's contract must preserve the existing teardown ordering from source: archive, container removal, Castra steward removal, exact tracked worktree removal, exact branch deletion; it must explicitly rule out blanket `git worktree prune`. [Critical Assumption]
- Steward's role-level consumer contract is out of scope even though Castra hosts the server-side session API; this feature documents only Castra's server-side wire surface.

## Artifact Hierarchy

RFC -> Milestone -> Feature -> User Story -> Slice -> Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: Document Hatchery HTTP Contract (Priority: P1)

As the Operator-as-Test-Author, I want Hatchery's spawn-job HTTP surface documented as an explicit contract so that L2 tests can assert how clients submit and inspect spawn work.

**Why this priority**: Hatchery is the dispatch entrypoint for containerized spawn execution, and the RFC's first cross-subsystem tests depend on stable route and envelope expectations at this boundary.

**Independent Test**: Inspect `docs/subsystems/hatchery/contract.md` and verify it contains the three required sections, documents the health/readiness routes, `POST /spawns`, `GET /spawns/:id`, request and response envelopes, validation errors, and an empty AUTOGEN marker pair inside `## Public Interface`.

**Acceptance Scenarios**:

1. **Given** a client submits a valid spawn request, **When** it reads the Hatchery contract, **Then** it can identify the required `prompt`, `backend`, and `repoPath` fields and the accepted optional metadata fields.
2. **Given** a client polls a spawn job, **When** it reads the Hatchery contract, **Then** it can identify the job record envelope and the not-found error response.
3. **Given** Hatchery readiness is used as a service gate, **When** the contract documents `/readyz`, **Then** the readiness dependencies and 200/503 behavior are explicit.

---

### User Story 2: Document Brood HTTP Contract and Teardown Invariants (Priority: P1)

As the CI Failure Triager, I want Brood's session registry and teardown contract documented so that teardown regressions fail against a known lifecycle promise instead of relying on source archaeology.

**Why this priority**: Brood owns lifecycle state and destructive cleanup. Its teardown order is a named RFC requirement and a high-risk boundary because the wrong order can orphan or remove a live steward worktree.

**Independent Test**: Inspect `docs/subsystems/brood/contract.md` and verify it documents session registration, listing, lookup, update, teardown routes, error envelopes, lifecycle state values, and the teardown invariant: archive -> container -> Castra steward removal -> exact tracked worktree -> exact branch, never blanket `git worktree prune`.

**Acceptance Scenarios**:

1. **Given** a service registers a managed session, **When** it reads the Brood contract, **Then** it can identify the accepted session kinds, statuses, path rules, branch rules, and response record shape.
2. **Given** teardown is requested for a spawn with a steward, **When** the contract describes invariants, **Then** it states the ordered cleanup sequence and the exact tracked path guarantee.
3. **Given** steward removal fails, **When** the contract describes error modes, **Then** it states that worktree and branch cleanup are deferred rather than performed under a live steward.

---

### User Story 3: Document Herald HTTP Contract and Event Log Semantics (Priority: P1)

As the Operator-as-Test-Author, I want Herald's event-log routes and projection semantics documented so that Legate and L2 tests can assert the observable state contract.

**Why this priority**: Herald is the deterministic event bus and state projection consumed by the loop. The testing framework needs explicit event, cursor, projection, and validation promises before replay-style tests can depend on them.

**Independent Test**: Inspect `docs/subsystems/herald/contract.md` and verify it documents health/readiness, event read/write, state projection, state delta, status routes, event taxonomy constraints, cursor behavior, and error responses.

**Acceptance Scenarios**:

1. **Given** a consumer reads events after a cursor, **When** it reads the Herald contract, **Then** it can identify `after`, `limit`, `events`, and `lastSeq` behavior.
2. **Given** Legate posts a transition event, **When** it reads the Herald contract, **Then** it can identify accepted event validation rules and the server-assigned event envelope.
3. **Given** a consumer inspects current or historical state, **When** the contract documents `/state` and `/state/delta`, **Then** it can identify projection and range semantics, including invalid cursor errors.

---

### User Story 4: Document Castra HTTP Contract (Priority: P1)

As the Operator-as-Test-Author, I want Castra's interactive-session HTTP API documented so that Hatchery, Herald, and future L2 tests can assert the session-launch boundary without treating agent-deck behavior as implicit.

**Why this priority**: Castra is the service boundary over agent-deck and the wire surface used by Hatchery's steward handoff. It must be documented before the Spawn -> Steward L2 cassette asserts the handoff contract.

**Independent Test**: Inspect `docs/subsystems/castra/contract.md` and verify it documents open health/status routes, bearer-token-protected session list/launch/show/send/output/set/remove routes, request and response envelopes, uniform error envelope, and an empty AUTOGEN marker pair inside `## Public Interface`.

**Acceptance Scenarios**:

1. **Given** a client launches an interactive session, **When** it reads the Castra contract, **Then** it can identify required launch fields, optional metadata, status code, and `session` response envelope.
2. **Given** a client drives an existing session, **When** it reads the Castra contract, **Then** it can identify send, output, set, and remove request and response shapes.
3. **Given** an API request fails, **When** the contract describes error modes, **Then** it can identify the uniform error envelope and mapped HTTP statuses for validation, authorization, missing sessions, conflicts, agent-deck failures, and internal failures.

### Edge Cases

- Health and status routes may be unauthenticated while service APIs are bearer-token protected.
- Readiness routes may report upstream reachability without making every probed dependency readiness-gating.
- Unknown request fields may be ignored or dropped by existing validation and must not be documented as echoed contract fields.
- Cursor and range query values can be malformed, zero, or reversed.
- Teardown can be requested against an already-torndown session and must remain idempotent.
- Castra agent-deck errors are externally visible as stable 502 error envelopes, while unexpected server details stay out of 500 responses.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| US1 | Document Hatchery HTTP Contract | — | specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/01-document-hatchery-http-contract.tasks.md |
| US3 | Document Herald HTTP Contract and Event Log Semantics | — | — |
| US4 | Document Castra HTTP Contract | — | — |
| US2 | Document Brood HTTP Contract and Teardown Invariants | US4 | — |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST author `docs/subsystems/hatchery/contract.md`, `docs/subsystems/brood/contract.md`, `docs/subsystems/herald/contract.md`, and `docs/subsystems/castra/contract.md`.
- **FR-002**: Each authored contract MUST include `## Public Interface`, `## Invariants`, and `## Error Modes` as H2 sections.
- **FR-003**: Each authored contract MUST document the subsystem's HTTP route surface with method, path, request envelope, response envelope, and externally visible status or error behavior.
- **FR-004**: Each authored contract MUST place an empty `<!-- BEGIN AUTOGEN -->` / `<!-- END AUTOGEN -->` marker pair inside `## Public Interface` for future TypeScript client/type extraction.
- **FR-005**: The Hatchery contract MUST document health, readiness, spawn submission, and spawn job lookup routes.
- **FR-006**: The Hatchery contract MUST document spawn request validation for missing prompt, missing backend, unknown backend, and missing repo path.
- **FR-007**: The Brood contract MUST document health, readiness, session registration, session listing, session lookup, session update, and session teardown routes.
- **FR-008**: The Brood contract MUST document accepted session kinds, lifecycle statuses, registerable fields, mutable fields, list filters, and teardown request/result envelopes.
- **FR-009**: The Brood contract MUST state the teardown ordering as archive, container removal, Castra steward removal, exact tracked worktree removal, and exact branch deletion.
- **FR-010**: The Brood contract MUST state that cleanup never uses blanket `git worktree prune` and that worktree and branch cleanup are skipped when steward removal fails.
- **FR-011**: The Herald contract MUST document health, readiness, event read, event append, state projection, state delta, and status routes.
- **FR-012**: The Herald contract MUST document cursor, limit, event taxonomy, required slice/session keys, source ownership, projection, and invalid-query error behavior.
- **FR-013**: The Castra contract MUST document health, status, session list, launch, show, send, output, set, and remove routes.
- **FR-014**: The Castra contract MUST document required profile-bearing request shapes, optional metadata on launch, output line bounds, removable-session options, and the `CastraSession` response shape.
- **FR-015**: The Castra contract MUST document the uniform non-2xx error envelope and mapped error codes.
- **FR-016**: This feature MUST NOT author the Steward role contract, generate AUTOGEN contents, populate freshness globs, implement checkers, or change runtime service code.

### Key Entities

- **Containerized Service Contract**: A subsystem contract whose public interface is an HTTP API exposed by a Fastify service.
- **HTTP Route Surface**: A method, path, request envelope, response envelope, and error/status behavior tuple.
- **Service Readiness Contract**: The observable health/readiness behavior that signals whether a service can do useful work.
- **Brood Teardown Invariant**: The ordered cleanup promise that protects containers, steward sessions, exact worktrees, and branches from unsafe deletion.
- **Autogen Region Placeholder**: An empty generated-content region reserved for F7 to populate later.

## Assumptions

- Feature 1's section schema and AUTOGEN marker convention are the authoritative structure for these contracts.
- The current Fastify route definitions and shared TypeScript wire types are the source of truth for documenting route envelopes.
- The Steward consumer contract remains separate and will be authored by Feature 4.
- The generated AUTOGEN block contents remain empty in this slice because extraction is Feature 7 scope.
- The service contracts support the low-touch execution model described in `docs/vision.md` and `docs/operating-philosophy.md` by turning service-boundary promises into explicit test targets.

## Specification Debt

None — all ambiguities resolved.

## Out of Scope

- Authoring contracts for Spawn, Legate, or Steward.
- Implementing or modifying any Fastify route, client, store, teardown, metrics, or telemetry code.
- Implementing contract presence checks, freshness checks, Smithy-agent enforcement, or CI workflows.
- Populating `docs/subsystems/contract-freshness.config.json` with concrete source globs.
- Generating TypeScript exported-signature content inside AUTOGEN blocks.
- Re-documenting Steward's consumer role inside the Castra contract beyond identifying Castra's server-side route surface.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Four new service contract artifacts exist at the Hatchery, Brood, Herald, and Castra subsystem contract paths.
- **SC-002**: Each new contract contains the three required H2 sections from Feature 1.
- **SC-003**: Each new contract documents its HTTP routes with method, path, request envelope, response envelope, and error/status behavior.
- **SC-004**: Brood's contract records the teardown ordering and exact-path / never-`git worktree prune` guarantee.
- **SC-005**: Each new contract includes an empty AUTOGEN marker pair inside `## Public Interface` for later F7 extraction.
