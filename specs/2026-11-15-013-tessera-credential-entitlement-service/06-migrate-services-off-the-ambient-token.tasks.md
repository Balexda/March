# Tasks: Migrate Services off the Ambient Token

**Source**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.spec.md` — User Story 6
**Data Model**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.data-model.md`
**Contracts**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.contracts.md`
**Story Number**: 06

Credential acquisition follows the [March vision](../../docs/vision.md) and [operating philosophy](../../docs/operating-philosophy.md). Resolve the target GitHub repository before issuing, bound issuance and network calls, and propagate a sanitized typed error through each service's failure boundary with an errored span. Use the existing slice trace when one is available. Use the shared client's explicit migration fallback and its refresh contract for a single retry on a confirmed GitHub 401. Keep credentials scoped to the call and out of command arguments, persisted git configuration, parent environments and diagnostics.

Each slice validates its normal entry point against fakes with no live GitHub traffic (FR-042). For callers of `gh`, cover a mounted HOME with an operator login and prove the child receives the issued token with an isolated, initially empty `GH_CONFIG_DIR`. Update affected subsystem contracts when mapped behavior changes. US3 owns service key provisioning, US5 owns steward credentials, US7 owns operator-identity review requests, and US9 owns removal of ambient compose variables.

## Slice 1: Scope Herald Observation and Sync
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Herald can observe and synchronize a profile using repository-scoped read access.

**Justification**: Herald can cut over its reads and its optional sync together while preserving its existing observation and fold boundaries.

**Addresses**: FR-029, FR-030, FR-042. AS 6.1, 6.4, 6.6.

### Tasks

- [ ] **Authenticate Herald observation and default-branch sync**

  Route Herald's `src/herald/service/server.ts` observation dependencies through the shared Tessera client at the `src/observe/sense-io.ts` GitHub boundary. Apply the same scope to the network git operations in AS 6.1.

  _Acceptance criteria:_
  - Repository metadata, PR and review reads, and fetch/pull in sync-enabled profiles use app/read for the target profile repository. Repository discovery works from local profile or remote metadata before any authenticated GitHub request.
  - Git network calls use scoped HTTPS authentication and cannot silently use mounted SSH keys or host credential helpers. Read-only profiles still skip sync.
  - Fake-based tests cover multiple profiles, child isolation, and typed traced issuance failure. A failing profile does not stop the observer or fabricate an empty observation.

**PR Outcome**: Herald can read and sync a profile without ambient GitHub credentials.

## Slice 2: Scope Brood Orphan Checks
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Brood can query the forge before orphan cleanup with repository-scoped read access.

**Justification**: The orphan gate has an independent REST boundary and can migrate without changing cleanup ownership.

**Addresses**: FR-029, FR-042. AS 6.2, 6.6.

### Tasks

- [ ] **Authenticate Brood's orphan-gate REST lookup**

  Replace ambient-token selection in `src/brood/service/steward-removal.ts` with a Tessera app/read entitlement for the repository resolved by the gate. Pass the token only in the bounded GitHub REST request.

  _Acceptance criteria:_
  - Fixture-backed orphan checks work with fallback unset and no ambient token, including repositories under different owners.
  - Missing repository identity or typed issuance failure leaves the candidate ineligible for removal. It cannot become proof that a PR is absent or terminal.
  - A fake outage verifies a traced failure and continued processing of other candidates.

**PR Outcome**: Brood's orphan gate uses Tessera and preserves its conservative cleanup decision.

## Slice 3: Scope Hatchery Base Pinning
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Hatchery fetches the base for a steward worktree with repository-scoped read access.

**Justification**: The pre-pin fetch and branch-collision checks share the steward worktree lifecycle and can be migrated without changing spawn-container policy.

**Addresses**: FR-029, FR-030, FR-042. AS 6.2, 6.4, 6.6.

### Tasks

- [ ] **Authenticate Hatchery's worktree GitHub calls**

  Obtain app/read for the steward worktree's GitHub repository in `src/hatchery/spawn-handoff.ts` before the pre-pin fetch. Scope the optional GitHub queries in `src/hatchery/orphan-branch.ts` to app/read and keep credentials on the Hatchery side of the handoff.

  _Acceptance criteria:_
  - The fetch uses scoped HTTPS authentication even for a GitHub SSH remote. Local git operations and the worker container receive no GitHub credential.
  - Successful issuance preserves fast-forward and divergence safeguards. A failed forge-dependent collision check leaves the branch ineligible for deletion. Local-only checks still work without an entitlement.
  - Fake-based tests cover pinning and unavailable Tessera. The affected operation surfaces a bounded typed failure on the slice trace and Hatchery remains available for other jobs.

**PR Outcome**: Hatchery can pin a GitHub base without relying on the host identity.

## Slice 4: Scope Statio Forge Reads
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Statio's existing GitHub read surface runs with repository-scoped app access.

**Justification**: Statio can migrate its forge adapter independently of any change to its consumers.

**Addresses**: FR-029, FR-030, FR-042. AS 6.4, 6.6.

### Tasks

- [ ] **Authenticate Statio's forge commands**

  Use the shared client at the GitHub command boundaries in `src/statio/forge.ts` and `src/statio/adapter.ts`. Resolve the repository locally or from existing registration data before the first GitHub metadata lookup.

  _Acceptance criteria:_
  - Repository metadata, PR list/detail and review-thread commands use app/read for their target repository with isolated child credentials.
  - Fake-based coverage exercises registration and normal routes with ambient auth absent, including a typed traced outage surfaced through the existing forge error boundary. An issuance failure never becomes a 404.
  - Existing route and response contracts remain compatible.

**PR Outcome**: Statio's GitHub read endpoints no longer depend on ambient forge authentication.

## Slice 5: Scope Legate Actions and Conductor Scripts
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Legate's runtime and deployed conductor operate on GitHub using entitlements scoped to each action.

**Justification**: Migrating both Legate entry points in one slice keeps their read/write rules and operator-facing failure behavior aligned.

**Addresses**: FR-029, FR-030, FR-042. AS 6.3, 6.4, 6.6.

### Tasks

- [ ] **Authenticate Legate runtime operations**

  Apply the shared client at the forge command boundaries in `src/legate/loop/runtime.ts`. Resolve the repository from the relevant profile or checkout.

  _Acceptance criteria:_
  - Mutations including merges, reactions, comments, label changes, PR closures and remote branch deletion use app/write. Independent read operations use app/read.
  - Entitlements and empty gh configuration are scoped to child invocations. Merge head matching and the folded Herald observation path are preserved.
  - Fake-based runtime coverage proves a typed issuance failure produces an errored span without exiting the scheduler or falsely advancing the affected operation.

- [ ] **Authenticate deployed conductor skill operations**

  Migrate GitHub-bound commands in `src/templates/legate/skills/` through the existing Tessera CLI and keep commands scoped to the selected repository. Keep deployment wiring in `src/legate/` and the templates packaged as static assets.

  _Acceptance criteria:_
  - GitHub reads and network fetches use app/read, and supported writes use app/write. Children that run gh use isolated configuration. Handle CI reruns according to SD-010, with a bounded failure when the entitlement lacks permission.
  - Fake-based coverage exercises the deployed entry points with no ambient credentials and verifies that failed issuance stops the GitHub operation, produces a sanitized failure and records an errored span.

**PR Outcome**: Both Legate entry points can act on GitHub with scoped app entitlements.

## Slice 6: Preserve Mixed-Author PR Tracking
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Herald and Legate track mixed-author PRs without treating March's replies as external feedback.

**Justification**: The credential cutovers provide the app login and leave a single observation-to-consumption path for testing identity and dedup together.

**Addresses**: FR-031, FR-042. AS 6.5.

### Tasks

- [ ] **Classify and deduplicate feedback across identities**

  Use the login derived by Tessera where `src/observe/` classifies feedback and where the Herald fold is consumed by Legate's babysit path. Keep the existing March reply marker and durable comment dedup useful during migration.

  _Acceptance criteria:_
  - A fake observation with simultaneous operator- and app-authored PRs tracks both through Herald into Legate using the existing repository, branch and PR correlation.
  - March's app-authored comments and marked legacy steward replies do not generate external-review work. Genuine operator and external bot feedback remains actionable.
  - A repeated observation and a rebuilt Legate state do not redispatch previously handled comments or collapse distinct replies.

**PR Outcome**: Mixed-author PRs remain visible and their feedback is acted on once through the existing loop.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Where should the app private key and PAT be stored? Option 1: a named docker volume mounted only into Tessera and filled by an npm-safe `march tessera secrets import`. Host stewards running as the operator can't read it, but it adds an import step. Option 2: a host directory outside `$HOME`, wired through compose `secrets:`. That is simpler, but any process running as the operator uid, including every steward pane, can read it. (Recommended: named volume.) | Non-Functional Quality | High | Medium | inherited | — |
| SD-002 | inherited from spec: Where should the plaintext per-service client keys persist between `march up` runs? `~/.march` is mounted into every container, so following the castra-token precedent would let any container read every key. Options: (a) 0600 files under `~/.march`, following the castra precedent; (b) only hashes kept in Tessera's volume, with plaintext keys regenerated and re-injected on every `march up` so services restart onto fresh keys; (c) a separate host directory outside the shared HOME. (Recommended: b.) | Domain & Data Model | High | Medium | inherited | — |
| SD-003 | inherited from spec: How should a steward pane receive its Tessera client key? Options: (a) a 0600 key file beside `~/.march/steward` that the wrapper and helper read; (b) a pane env var injected by Castra/agent-deck at launch, which would have to be exempt from the tmux-env scrub; (c) a key minted per steward session. Every option is reachable by other processes on the host; the policy caps the damage at app/write. | Interaction & UX | Medium | Low | inherited | — |
| SD-004 | inherited from spec: Which identity should steward commits carry? Options: (a) the bot as author and committer, with the noreply email, so history fully reflects the bot; (b) the operator stays author and the bot is only the push/PR identity; (c) the bot as committer with a `Co-authored-by:` trailer for the operator. The brief's motivation, "history misrepresents authorship", points to (a) or (c), but the brief only says *PRs* are bot-authored. | Domain & Data Model | High | Medium | inherited | — |
| SD-005 | inherited from spec: How should v1 handle steward pushes that touch `.github/workflows/*`? GitHub rejects those without `workflows:write`. Options: (a) leave it out of write, so such pushes fail closed and the steward escalates; (b) add an opt-in `write+workflows` access level that the policy grants per client or per repo; (c) include it in the default write profile. | Integration | Medium | Medium | inherited | — |
| SD-006 | inherited from spec: SD-001 is open between a named volume filled by `march tessera secrets import` and a host directory outside `$HOME` wired through compose `secrets:`, but FR-020, User Story 3 scenario 4 and the CLI contract make the CLI import mandatory — option 1's mechanism — so the artifacts effectively commit to it. | plan-review:Internal contradiction | Important | Low | inherited | — |
| SD-007 | inherited from spec: SD-002 is open, but User Story 3 scenario 3 and FR-019 ("each service receives its own client key and no other service's key") quietly exclude option (a) if "receives" means "can obtain", and the data model calls the client-keys file "operator-owned" although option (b) has `march up` write it. | plan-review:Internal contradiction | Important | Low | inherited | — |
| SD-008 | inherited from spec: `march doctor` must check that each service's client key is accepted (FR-040, User Story 8 scenario 6), but the only authenticated route is `POST /v1/github/token`; checking a key would mean minting a real token or sending a deliberately invalid body, and doctor's access to every plaintext key depends on SD-002. | plan-review:Logical gap | Important | Low | inherited | — |
| SD-009 | inherited from spec: The Copilot review request must happen exactly once per PR (FR-032, User Story 7 scenario 3, SC-008), but no idempotency mechanism is given: Legate's working state is rebuilt from the Herald fold, so after a restart it would request again unless a transition event in the fold or a check of GitHub's requested reviewers prevents it. | plan-review:Logical gap | Important | Low | inherited | — |
| SD-010 | Should the app/write profile gain `actions:write` to preserve the conductor's `rerun-ci.sh` capability, or should the conductor surface reruns for manual execution to keep the existing write scope? | Integration | High | Low | open | — |

### SD-010 — Conductor Actions rerun permission

Should the app/write profile gain `actions:write` to preserve the conductor's `rerun-ci.sh` capability, or should the conductor surface reruns for manual execution to keep the existing write scope? The access profile in the data model omits Actions permissions, and the rerun already exists in the deployed scripts. This choice affects S5.

## Open Implementation Questions
<!-- audience: builder; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

_None — no open implementation questions._

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Scope Herald Observation and Sync | — | — |
| S2 | Scope Brood Orphan Checks | — | — |
| S3 | Scope Hatchery Base Pinning | — | — |
| S4 | Scope Statio Forge Reads | — | — |
| S5 | Scope Legate Actions and Conductor Scripts | — | — |
| S6 | Preserve Mixed-Author PR Tracking | S1, S5 | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US4 — Fetch Tokens Through One Client | depends on | Provides the Node client and token CLI. Fakes support implementation before deployment. |
| US9 — Remove Ambient GitHub Credentials | depended upon by | Removes the remaining compose-level migration inputs after the service cutovers. |
