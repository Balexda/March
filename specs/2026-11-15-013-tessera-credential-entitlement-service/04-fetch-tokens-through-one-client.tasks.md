# Tasks: Fetch Tokens Through One Client

**Source**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.spec.md` — User Story 4
**Data Model**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.data-model.md`
**Contracts**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.contracts.md`
**Story Number**: 04

---

## Slice 1: Deliver the Shared Entitlement Client

**Goal**: Services obtain typed GitHub entitlements through one bounded HTTP client, with safe cache reuse and an explicit, observable migration fallback.

**Justification**: This delivers the complete consumer API against the fixed wire contract without waiting for the server. Keeping fallback with transport ensures the first shipped client enforces identity and environment-access guarantees.

**Addresses**: FR-009, FR-022, FR-023, FR-042; AS 4.1–4.4; Node Client contract.

### Tasks

- [ ] **Implement the typed Tessera HTTP client**

  Add client, configuration and wire types under `src/tessera/`, following `src/statio/client.ts` and `src/castra/client.ts`. Implement the Node Client contract, including the convenience call, status and reachability methods, with fake-Tessera coverage for AS 4.1–4.2.

  _Acceptance criteria:_
  - Explicit options and documented URL/client-key environment settings configure requests; missing configuration fails closed.
  - Requests authenticate, map wire entitlements to the public client shape, and forward refresh and slice correlation as documented.
  - Server codes and HTTP status survive in typed errors; transport and timeout failures use the documented unreachable code.
  - Requests, including response-body consumption and health/status probes, terminate within bounded time.
  - Malformed responses fail with sanitized typed errors; secrets and raw response bodies never enter diagnostics.
  - Status returns the documented shape; reachability returns false on transport failure without issuing a token.

- [ ] **Add scope-safe entitlement reuse and refresh**

  Implement in-memory reuse in `src/tessera/client.ts` for AS 4.1 and the Node Client refresh contract. Ensure the convenience call retains usable client state without sharing credentials across differently configured callers.

  _Acceptance criteria:_
  - Reuse is isolated by client configuration, requested identity, repository and access level.
  - Reuse stops at the ten-minute expiry boundary; expired or near-expiry entries require issuance.
  - Refresh bypasses and evicts the matching entitlement, supporting the caller's one retry after a GitHub 401.
  - Unknown-expiry user entitlements and migration fallbacks are not retained as fresh installation tokens.
  - Fake-Tessera tests cover expiry boundaries, scope isolation and refresh without calling GitHub.

- [ ] **Gate and observe migration fallback**

  Implement AS 4.2–4.4 in `src/tessera/client.ts`, using `src/observability/logger.ts` and a consumer metric helper under `src/observability/`. Include fallback visibility in `docker/grafana/dashboards/` and document the client in `docs/subsystems/tessera/contract.md`.

  _Acceptance criteria:_
  - Ambient tokens are read only after issuance fails, the documented migration flag equals 1, and the requested identity is app.
  - An available environment token returns the documented fallback source; absence preserves a typed failure.
  - User requests never read or use ambient tokens; failures never substitute another Tessera identity.
  - Every fallback warns and increments the documented counter with a bounded service label, without exposing secrets.
  - Telemetry follows existing env-gating conventions; tests cover fallback selection, disabled access and user exclusion.
  - The subsystem contract records client exports, cache/refresh, bounded failures and fallback; the dashboard exposes fallback usage.

**PR Outcome**: Service authors have the complete, independently testable entitlement API; service credential call sites remain for US6.

---

## Slice 2: Expose the Token CLI

**Goal**: Operators and steward shims obtain tokens through `march tessera token` with clean stdout and bounded, fail-closed errors.

**Justification**: This independently usable CLI increment builds on the shared client without introducing server deployment or steward session changes.

**Addresses**: FR-024 (token command only), FR-042; AS 4.5; CLI token contract.

### Tasks

- [ ] **Wire the token command through the shared client**

  Add thin Commander dispatch in `src/cli/program.ts` with command behavior owned by `src/tessera/`. Implement AS 4.5 and the CLI token contract, keeping this credential-printing surface fail closed even when the service migration fallback flag is set.

  _Acceptance criteria:_
  - The command accepts documented repository, access and app identity options, validating inputs before issuance.
  - Successful stdout contains only the token and terminating newline; sanitized diagnostics use stderr.
  - Denial, malformed responses, missing configuration and unreachability exit non-zero within the client timeout without printing credentials.
  - CLI issuance never uses ambient tokens, including when the migration flag is set.
  - Fake-Tessera command coverage verifies success and failures; the subsystem contract records the new command.
  - Existing CLI commands remain intact; no server, git helper or steward shim is introduced.

**PR Outcome**: The normal CLI build provides the token-only seam consumed by US5.

---

## Implementation Boundaries

| Concern | Decision |
|---------|----------|
| Architecture | Runtime behavior belongs in `src/tessera/`; Commander stays thin. Follow [vision](../../docs/vision.md) and [operating philosophy](../../docs/operating-philosophy.md) for bounded, unattended failures. |
| Parallel delivery | Use fake Tessera against the fixed wire contract; US1 server implementation is not a prerequisite. |
| Alternative decomposition | Separate transport, cache and fallback slices would reduce individual PR size but expose an incomplete client. Keep these guarantees together and split the independently usable CLI. |
| Story boundaries | US5 owns the git credential helper, gh wrapper and steward wiring. US6 owns service migrations. US8 owns server audit/spans, provider metrics, health implementation and the full dashboard; this story supplies consumer fallback telemetry only. |
| Validation | Each functional task includes fake-based coverage. Each implementation slice runs `npm run typecheck`, `npm run build` and `npm test`; Slice 2 also runs the AGENTS.md CLI spot-checks. |
| Secret safety | Existing clients interpolate transport errors; credential-bearing requests require sanitized diagnostics without raw response bodies or headers. |

## Specification Debt

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
| SD-009 | inherited from spec: The Copilot review request must happen exactly once per PR (FR-032, User Story 7 scenario 3, SC-008), but no idempotency mechanism is given: Legate's working state is rebuilt from the Herald fold, so after a restart it would request again unless a transition event in the fold or a check of GitHub's requested reviewers prevents it. | plan-review:Logical gap | Important | Low | resolved | Resolved 2026-11-16 in the spec — durable `review.requested` record per spec `2026-11-16-014-legate-per-verb-review-requests-and-merge-gates`. |

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Deliver the Shared Entitlement Client | — | — |
| S2 | Expose the Token CLI | S1 | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 5: Stewards Open Pull Requests as the Bot | depended upon by | Uses the client/token CLI for its gh wrapper and git credential helper. |
| User Story 6: Migrate Services off the Ambient Token | depended upon by | Replaces service credential reads and handles per-call refresh after GitHub rejection. |
| User Story 7: Request a Copilot Review as the Operator | depended upon by | Uses the user entitlement path, which never falls back to ambient credentials. |
