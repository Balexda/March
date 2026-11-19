# Tasks: Keep Credentials Only in Tessera

**Source**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.spec.md` — User Story 3
**Data Model**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.data-model.md`
**Contracts**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.contracts.md`
**Story Number**: 03

## Slice 1: Isolate and Rotate Provider Secrets
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Operators can provision and replace provider secrets for standalone Tessera through the npm-installed CLI.

**Justification**: Standalone deployment establishes the storage boundary before stack startup provisions client access.

**Addresses**: FR-001, FR-016, FR-017, FR-018, FR-020, FR-021, FR-042; AS 3.1, AS 3.2, AS 3.4, AS 3.5.

### Tasks

- [ ] **Isolate the Tessera secret store**

  Extend `docker/tessera.docker-compose.yml` and Tessera startup validation for AS 3.1, AS 3.2 and AS 3.5. Resolve SD-001 before forging this slice.

  _Acceptance criteria_
  - Rendered compose mounts the provider secret store only in Tessera. Tessera has no host HOME mount, publishes on loopback only and joins the March network.
  - Startup rejects a provider secret path that resolves inside the shared host HOME, including through a symlink. The error identifies the path and omits secret contents.
  - Missing provider secrets preserve unconfigured startup. Normal stack teardown and image replacement preserve stored secrets.
  - The compose header covers setup, host settings, secret placement and residual access by Docker-socket holders and host steward processes.

- [ ] **Import and reload provider secrets**

  Wire the documented stdin import command through `src/cli/program.ts` to Tessera-owned behavior. Connect store changes to the provider reload boundary for AS 3.4.

  _Acceptance criteria_
  - The npm-installed command accepts both documented secret names through stdin. Secret bytes stay out of process arguments, shared HOME and diagnostics.
  - Empty input and failed writes leave the existing secret intact. Successful replacement publishes the complete value with access restricted to Tessera.
  - The running app provider takes up the replacement without an image rebuild and invalidates affected cached entitlements. The same storage and change detection support the PAT provider in US7.
  - Coverage exercises compose isolation, path rejection, import and live app-key replacement without real GitHub calls. Update `docs/subsystems/tessera/contract.md` for the new command and deployment surface.

**PR Outcome**: Standalone Tessera can import and replace provider secrets within its deployment boundary.

## Slice 2: Start Tessera and Provision Service Access
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: A fresh-host `march up` starts Tessera ahead of its consumers and delivers one distinct client key to each.

**Justification**: Startup order and client-key delivery land together so consumers start with working authentication.

**Addresses**: FR-019, FR-042; AS 3.3.

### Tasks

- [ ] **Wire per-service Tessera access into stack startup**

  Extend `src/stack/services.ts`, `src/stack/up.ts` and affected compose assets for AS 3.3. Forge this slice after SD-002 is resolved and US2 production authorization is available. US5 owns steward key delivery, and US6 owns consumer call-site migration.

  _Acceptance criteria_
  - Tessera starts after the March network is available and becomes ready before consumers start. A bounded startup failure prevents dependent services from starting.
  - Each managed consumer receives the Tessera URL and its own key. Standalone Statio accepts its dedicated URL and key. Tessera receives matching hashed registrations. Plaintext keys stay out of shared HOME, sibling environments, steward tmux and diagnostics.
  - Repeated or interrupted startup and upgrade preserve consistency between active keys and registered hashes. Existing operator policy is preserved.
  - Coverage verifies ordering, bounded failure and key isolation without real GitHub calls. Document provisioned access, including how an independently deployed Statio receives its own key, and update affected subsystem contracts.

**PR Outcome**: Stack startup provisions Tessera and starts consumers with isolated client credentials.

Both slices follow [March's vision](../../docs/vision.md) and [operating philosophy](../../docs/operating-philosophy.md) for unattended operation and bounded failures.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

| ID | Title | Source Category | Impact | Confidence | Origin |
|----|-------|-----------------|--------|------------|--------|
| SD-001 | Provider secret store | Non-Functional Quality | High | Medium | spec:SD-001 |
| SD-002 | Plaintext service key persistence | Domain & Data Model | High | Medium | spec:SD-002 |
| SD-003 | Steward key delivery | Interaction & UX | Medium | Low | spec:SD-003 |
| SD-004 | Steward commit identity | Domain & Data Model | High | Medium | spec:SD-004 |
| SD-005 | Steward workflow-file permissions | Integration | Medium | Medium | spec:SD-005 |

SD-006 and SD-007 describe constraints on SD-001 and SD-002. The selected store must support stdin import, and the selected client key persistence must prevent sibling services from accessing each other's keys.

## Open Implementation Questions
<!-- audience: builder; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | How can US8 doctor verify a service key without minting a GitHub token? | — | building | spec:SD-008 |

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Isolate and Rotate Provider Secrets | — | — |
| S2 | Start Tessera and Provision Service Access | S1 | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US1 · Mint a Downscoped Bot Token | depends on | Supplies the Tessera image, service and app provider reload boundary. |
| US2 · Enforce a Default-Deny Policy per Client | depends on | S2 requires production authorization and the registration reader. |
| US7 · Request a Copilot Review as the Operator | depended upon by | The PAT provider uses the S1 secret store and reload boundary. |
| US8 · See Issuances, Expiry and Health | depended upon by | US8 doctor key checks need S2's deployed client-key wiring, and its provider status follows S1 secret replacement. |
