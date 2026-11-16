# Tasks: Enforce a Default-Deny Policy per Client

**Source**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.spec.md` — User Story 2
**Data Model**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.data-model.md`
**Contracts**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.contracts.md`
**Story Number**: 02

---

## Slice 1: Authenticate Callers with Per-Client Keys
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Every `/v1/*` request must carry a bearer key that matches a registered client, checked against SHA-256 hashes loaded at startup. A missing or unknown key is rejected as `unauthorized`, the route knows the authenticated client's name, `/healthz` and `/status` stay open, and Tessera refuses to start without a valid client-keys file.

**Justification**: The service stops being unauthenticated, which is a working increment without any policy: a known client is authenticated but not yet restricted. Slice 2 builds on the client names and the caller seam this slice establishes.

**Addresses**: FR-011, FR-014 (client-keys file), FR-038, FR-043; Acceptance Scenarios 2.1, 2.6 (client-keys file)

### Tasks

- [ ] **Load and validate the client registrations**

  Add `src/tessera/auth/client-keys.ts` and a `TESSERA_CLIENT_KEYS_FILE` setting in `src/tessera/config.ts`. The module loads the file at that path, a JSON array of Client Registration rows (data model), into an immutable registry that resolves a presented bearer key to a client name. Add the `unauthorized` typed error to `src/tessera/types.ts` per the contracts "Error Conditions" table. Satisfies the client-keys half of AS 2.6.

  _Acceptance criteria:_
  - An unset setting, or a missing, unreadable, blank or unparseable file, is a typed validation error, never "allow all"
  - An empty list, an unknown field, a bad client name, a malformed hash, a duplicate client or a duplicate hash is rejected
  - Load errors name the setting and the entry position, never a hash or file contents
  - Lookup hashes the presented key and compares it in constant time against every stored hash
  - An unknown key, of any length, resolves to no client without throwing
  - Plaintext keys are never retained

- [ ] **Gate `/v1/*` on the client key and expose the caller**

  In `src/tessera/server.ts`, take the client registry as a required build option and authenticate every path under `/v1` in a hook that runs before body parsing. Record the authenticated client name on the request, for the route and the later audit record. Update the existing cases in `src/tessera/server.test.ts` to authenticate, and extend that contract test. Satisfies AS 2.1.

  _Acceptance criteria:_
  - A missing, malformed or unknown key returns the same `unauthorized` response, including for an invalid body and an unmatched `/v1` path
  - A rejected request reaches no provider
  - A valid key reaches the route, and the token flow behaves as before
  - `/healthz` and `/status` answer without a key
  - The route handler can read the client name; no response body carries it
  - No key, hash or Authorization header appears in logs, `/status` or error bodies

- [ ] **Load client keys at startup**

  In `src/tessera/serve.ts`, load the registry after the port is validated and before the server is built, so a bad file fails startup through the existing usage-error path with nothing listening. Update `src/tessera/serve.test.ts`, including its existing cases, which now need a keys file.

  _Acceptance criteria:_
  - A missing, empty or invalid file prevents listening
  - An invalid port is still reported before a file problem
  - With a valid file the service starts with an unconfigured GitHub App, as before
  - The startup log names the setting and the number of clients, never a hash or a key

- [ ] **Document client authentication**

  Update `docs/subsystems/tessera/contract.md`, the header of `docker/tessera.docker-compose.yml` with `src/tessera/container-artifacts.test.ts`, the Tessera line in `AGENTS.md`, and the comments in `src/tessera` that say caller authentication is absent. The compose file passes the new setting through as an optional variable and adds no mount; where the file lives is User Story 3.

  _Acceptance criteria:_
  - The contract documents the bearer scheme, hash-only storage, the file format, the `unauthorized` error mode and the startup failure
  - The contract states that authentication precedes body validation
  - The contract and compose header state that any authenticated client may request anything until the policy lands
  - The compose header says the file is operator-supplied by a compose override and the service refuses to start without it
  - No "unauthenticated" statement about `/v1/*` remains
  - The advisory contract check reports no error for Tessera

**PR Outcome**: Tessera authenticates each caller by its own key and refuses to start without registered clients. Authorization is still absent, and the docs say so.

---

## Slice 2: Enforce the Default-Deny Policy
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: A policy file loaded at startup decides each authenticated request: the identity must be granted, the repository must match the client's allowlist, and the access must not exceed its ceiling. Everything else, including a known client with no rule, is rejected as `policy_denied`. Tessera refuses to start with a missing or invalid policy.

**Justification**: This is the entitlement control the story exists for. It needs only the client names and caller seam from Slice 1, changes no provider code, and is testable with no GitHub at all.

**Addresses**: FR-012, FR-013, FR-014 (policy file), FR-015, FR-038, FR-043; Acceptance Scenarios 2.2, 2.3, 2.4, 2.5, 2.6 (policy file)

### Tasks

- [ ] **Load and validate the policy file**

  Add `src/tessera/auth/policy.ts` and a `TESSERA_POLICY_FILE` setting in `src/tessera/config.ts`. The module loads the file, a JSON array of Policy Rule rows (data model), into an immutable rule set validated against the client registry. Add the `policy_denied` typed error to `src/tessera/types.ts` per the contracts "Error Conditions" table. Satisfies the policy half of AS 2.6.

  _Acceptance criteria:_
  - An unset setting, or a missing, unreadable, blank or unparseable file, is a typed validation error
  - An empty rule list is rejected
  - A rule naming an unregistered client is rejected
  - `user` granted to any client other than `legate` is rejected
  - A bare `*`, a malformed repository entry, an unknown `max_access`, an unknown field or an empty `identities` list is rejected
  - A rule granting `app` with no repositories is rejected
  - A second rule for the same client is rejected
  - Load errors name the setting and the rule position, never file contents

- [ ] **Authorize each token request against the client's rule**

  Add a pure authorization function to `src/tessera/auth/policy.ts` that takes a client name and a parsed Entitlement Request. Call it from the token route in `src/tessera/server.ts` after request validation and before the provider is looked up. Extend the contract test in `src/tessera/server.test.ts`. Satisfies AS 2.2–2.5 and FR-015.

  _Acceptance criteria:_
  - An identity not granted, an access above the ceiling, or a repository outside the allowlist is denied
  - `owner/*` allows every repository of that owner and no other owner's; matching ignores case
  - A `user` request from any client other than `legate` is denied
  - A known client with no rule is denied for every request
  - A denied request reaches no provider and never reports `provider_unconfigured`
  - The denial message names the dimension denied, never the allowlist or the submitted repository
  - Changing or omitting `subject` never changes an outcome

- [ ] **Load the policy at startup**

  In `src/tessera/serve.ts`, load the policy after the client registry and pass both to the server, so an invalid policy fails startup with nothing listening. Extend `src/tessera/serve.test.ts`.

  _Acceptance criteria:_
  - Each AS 2.6 failure prevents listening and exits through the usage-error path
  - A registered client with no rule does not prevent startup, provided the policy has at least one rule
  - Allowed and denied requests behave as in AS 2.2–2.5 against the running entrypoint with no GitHub App configured
  - The startup log names the setting and the number of rules, never rule contents

- [ ] **Document the policy**

  Update `docs/subsystems/tessera/contract.md`, the header of `docker/tessera.docker-compose.yml` with `src/tessera/container-artifacts.test.ts`, and the Tessera line in `AGENTS.md`.

  _Acceptance criteria:_
  - The contract documents the policy file format, the `policy_denied` error mode and the startup failures
  - The contract states the evaluation order: authenticate, validate, authorize, dispatch
  - Invariants state default deny, the `legate`-only `user` identity, and that `subject` affects no decision
  - The Slice 1 statement that any authenticated client may request anything is removed
  - The compose header lists both settings and what remains for User Story 3
  - The advisory contract check reports no error for Tessera

**PR Outcome**: Tessera is default-deny per client. All of AS 2.1–2.6 hold and are covered over HTTP without GitHub.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

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
| SD-014 | May a client have more than one policy rule? The data model says Client Registration 1:N Policy Rule, but the reconciled plan rejects a duplicate rule at startup. The choice is between: (a) one rule per client, with a duplicate being a startup failure; (b) several rules per client, where a request is allowed if any one rule grants it. Option (b) would allow, for example, `owner/*` at read plus a few repos at write. | Scope Edges | Medium | Medium | open | — |
| SD-015 | Does `max_access` cap a `user` request? The data model calls it the "ceiling for the `app` identity", yet the Entitlement Request says `access` "must not exceed the client's `max_access`". The choice is between: (a) applying the ceiling to every identity, so a legate rule with `max_access: read` denies a `user`/`write` request; (b) checking only identity membership for `user`, because the PAT cannot be downscoped. | Technical Risk | Low | Medium | open | — |
| SD-016 | In Slice 2, task "Authorize each token request against the client's rule", the criterion that a repository outside the allowlist is denied does not say how it applies to a `user` request. The contracts make `repo` required only for `app`, and the response gives `repo: null` for `user`. The tasks do not say whether a `user` request skips the repository check, or is checked when it carries a `repo` anyway. | plan-review:Logical gap | Important | Low | open | — |

The tasks take option (a) for both SD-014 and SD-015. IDs continue from the User Story 1 tasks file, which uses SD-010 to SD-013 for its own items.

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Authenticate Callers with Per-Client Keys | — | — |
| S2 | Enforce the Default-Deny Policy | S1 | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Mint a Downscoped Bot Token | depends on | The token route, error envelope and provider seam this story puts authentication and policy in front of. |
| User Story 3: Keep Credentials Only in Tessera | depended upon by | US3 decides where the two files live, has `march up` generate client keys and write the client-keys file, and mounts them. Until then the operator supplies both files. |
| User Story 4: Fetch Tokens Through One Client | depended upon by | US4's client sends the bearer key this story checks. |
| User Story 7: Request a Copilot Review as the Operator | depended upon by | US7 registers the operator-token provider; this story only restricts the `user` identity to `legate`. |
| User Story 8: See Issuances, Expiry and Health | depended upon by | US8 records the caller in the audit event and adds denial spans and metrics, using the client name exposed here. |
