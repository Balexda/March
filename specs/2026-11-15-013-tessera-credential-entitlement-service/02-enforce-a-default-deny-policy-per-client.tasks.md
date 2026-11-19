# Tasks: Enforce a Default-Deny Policy per Client

**Source**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.spec.md` — User Story 2
**Data Model**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.data-model.md`
**Contracts**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.contracts.md`
**Story Number**: 02

## Slice 1: Enforce Client Authentication and Entitlement Policy
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: discouraged -->

**Goal**: Tessera serves token requests only for authenticated clients with an explicit grant.

**Justification**: Validated configuration and HTTP enforcement ship together so the production entrypoint applies policy before provider selection or cache access.

**Addresses**: FR-011–FR-015, FR-043 and AS 2.1–2.6.

### Tasks

- [x] **Load and validate authorization configuration**

  Load client registrations and policy under `src/tessera/` and validate them during startup for AS 2.6. Follow the data model and the clean-exit guidance in [March's operating philosophy](../../docs/operating-philosophy.md).

  _Acceptance criteria:_
  - Either required file being unset, unreadable, empty or invalid causes a nonzero exit before Tessera listens. Diagnostics identify the configuration problem without exposing file contents or credentials.
  - Registrations satisfy the client name and SHA-256 digest format and uniqueness rules. Policy validation rejects malformed rules, unknown clients and prohibited user grants.
  - Startup coverage exercises file and cross-file failures without GitHub.

- [x] **Authenticate versioned requests and enforce client grants**

  Implement the production authorization boundary used by `src/tessera/server.ts` and cover AS 2.1–2.5 through HTTP contract tests.

  _Acceptance criteria:_
  - Every `/v1/*` request requires a valid bearer key before body validation. Tessera stores only key digests and compares digests in constant time. Health and status retain their documented access behavior.
  - Requests require an explicit grant for the authenticated caller and requested identity. App grants enforce the repository allowlist and access ceiling, including owner-scoped wildcards. Only the `legate` client can receive a user grant.
  - Denials use the documented HTTP envelopes and precede provider selection, cache lookup, refresh and upstream access. Contract coverage includes each denial case and an allowed request without GitHub.

- [x] **Record the reserved subject in issuance audits**

  Extend Tessera's issuance audit and existing error tracing to cover the production authorization path. Update `docs/subsystems/tessera/contract.md` with the configuration formats, startup behavior and HTTP contract.

  _Acceptance criteria:_
  - The optional subject is recorded after request validation and has no effect on decisions or cache scope. Audit and trace coverage verifies denial outcomes and keeps keys, hashes, tokens and authorization headers out of diagnostics.
  - Denials emit errored issuance spans with existing slice correlation. The contract describes default deny, startup validation and the subject field.

**PR Outcome**: A configured Tessera enforces client policy through its production entrypoint and can be contract-tested without GitHub. US3 owns deployment and key distribution, US7 owns the user provider, and US8 owns the denial metric and broader provider telemetry.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Title | Source Category | Impact | Confidence | Origin |
|----|-------|-----------------|--------|------------|--------|
| SD-002 | Plaintext client-key persistence | Domain & Data Model | High | Medium | spec:SD-002 |
| SD-005 | Workflow permission in the app access profiles | Integration | Medium | Medium | spec:SD-005 |

## Open Implementation Questions
<!-- audience: builder; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

_None — no open implementation questions._

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Enforce Client Authentication and Entitlement Policy | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1 | depends on | Provides the Tessera service, authorization boundary and issuance path. |
| User Story 7 | depended upon by | Uses the Legate-only user policy to authorize operator review requests. |
