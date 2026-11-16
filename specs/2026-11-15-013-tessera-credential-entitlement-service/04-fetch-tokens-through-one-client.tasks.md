# Tasks: Fetch Tokens Through One Client

**Source**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.spec.md` — User Story 4
**Data Model**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.data-model.md`
**Contracts**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.contracts.md`
**Story Number**: 04

---

## Slice 1: Fetch Tokens Through a Fail-Closed Client
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Service code calls `getGitHubToken` and receives a GitHub entitlement from Tessera, with a bounded timeout, typed errors and reuse until ten minutes before expiry. The call fails closed unless the migration flag is set; with the flag set, the environment token stands in for the `app` identity only, marked as a fallback, logged as a warning and counted.

**Justification**: This is the story's independent test — the client against a fake Tessera — and the one call every later consumer uses. It needs no CLI and migrates no consumer.

**Addresses**: FR-009, FR-022, FR-023, FR-038, FR-042; Acceptance Scenarios 4.1, 4.2, 4.3, 4.4

### Tasks

- [x] **Issue entitlements through a Tessera client class**

  Add `src/tessera/client.ts` with `TesseraClient` and `TesseraClientError`, following the option shape of `src/statio/client.ts` and the contracts "Node Client" section. Add the consumer-side settings from the spec's Clarifications to `src/tessera/config.ts`, with resolvers for the base URL, the client key and the fallback flag. `issueGitHubToken` posts to the token route and maps the wire Entitlement to `GitHubEntitlement`. Satisfies the fetch half of AS 4.1 and the typed-failure half of AS 4.2.

  _Acceptance criteria:_
  - The request carries the client key as a bearer credential and the slice id header when a slice id is given
  - A server error envelope becomes a typed error that preserves the server's code and status, and the retry delay when the server sends one
  - A network failure, a timeout or a response with no error envelope becomes the `unreachable` code within a bounded time
  - A missing client key, or an `app` request without a repository, is a typed error raised before any request
  - The client imports nothing from the server module and never raises the server's error classes
  - No token or client key appears in any error message or log line

- [x] **Reuse entitlements until ten minutes before expiry**

  Keep an in-memory cache inside `TesseraClient`, keyed by identity, repository and access, with an injectable clock. Satisfies the reuse half of AS 4.1.

  _Acceptance criteria:_
  - A repeat request with more than ten minutes left makes no request to Tessera
  - A request inside the final ten minutes fetches a new entitlement
  - `refresh` always fetches and replaces the entry
  - Different identities, repositories or access levels never share an entry; repository matching ignores case
  - An entitlement with no expiry is never cached
  - The slice id does not affect the cache key; nothing is written to disk

- [x] **Expose `getGitHubToken` with the gated environment fallback**

  Add the module-level `getGitHubToken` in `src/tessera/client.ts`, over a lazily created default client, and a consumer-side fallback counter in a new `src/observability/tessera-metrics.ts` following `src/observability/statio-metrics.ts` (contracts "Events"). The fallback applies only when the flag is set, the identity is `app`, and Tessera could not be reached, has no client key configured for this service, or returned `provider_unavailable`, `provider_unconfigured`, `credential_invalid`, `mint_failed` or `internal`. Satisfies AS 4.2, AS 4.3 and AS 4.4.

  _Acceptance criteria:_
  - With the flag unset, `GH_TOKEN` and `GITHUB_TOKEN` are never read and the typed error surfaces
  - With the flag set, an `app` request that Tessera cannot serve returns the environment token marked as a fallback
  - Each of `unreachable`, a client-side missing key, `provider_unavailable`, `provider_unconfigured`, `credential_invalid`, `mint_failed` and `internal` falls back when the flag is set and the identity is `app`
  - A `user` request never falls back, and the environment token is not read for it
  - A refused key, a policy denial, an invalid request or an uninstalled repository never falls back
  - With no environment token present, the original typed error surfaces
  - Each fallback logs one warning and increments the counter once, with only a low-cardinality service label; the token is never logged
  - A fallback result is never cached

- [x] **Document the Node client**

  Update `docs/subsystems/tessera/contract.md` and the Tessera line in `AGENTS.md` for the client, the consumer settings, the cache rule, the fallback and its counter.

  _Acceptance criteria:_
  - The contract states the fail-closed default and that the environment token is not read unless the flag is set
  - The contract lists exactly which failures allow the fallback and that it never serves the `user` identity
  - The contract states the timeout bound, the `unreachable` code and the ten-minute reuse rule
  - The contract states that the client's status and reachability calls, and consumer migration, belong to later stories
  - The advisory contract check reports no error for Tessera

**PR Outcome**: Service code has one fail-closed call for GitHub tokens, covered against a fake Tessera with no network. Nothing consumes it yet.

---

## Slice 2: Print a Token from the CLI
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: `march tessera token` for a repository and access level writes only the token to standard output. Any failure goes to standard error with a non-zero exit, and the command never falls back to host credentials.

**Justification**: This is the shell seam the steward `gh` wrapper and credential helper build on. It is a thin layer over the Slice 1 client and works from a plain npm install because it only speaks HTTP.

**Addresses**: FR-024 (token command), FR-038; Acceptance Scenario 4.5

### Tasks

- [x] **Add the `march tessera token` command**

  Add a `token` subcommand to the `tessera` group in `src/cli/program.ts`, per the contracts "CLI" section, with its logic in a small function under `src/tessera` that the program only wires. It uses `TesseraClient` directly, not `getGitHubToken`, so the migration fallback cannot apply. Extend the `march tessera` block in `src/cli/program.test.ts`. Satisfies AS 4.5.

  _Acceptance criteria:_
  - Standard output is exactly the token and a newline
  - A denied, unauthorized, unconfigured or unreachable Tessera exits non-zero with one line on standard error and nothing on standard output
  - A missing or invalid repository or access level, or an identity other than `app`, is a usage error raised before any request
  - The command ignores the fallback flag and never reads `GH_TOKEN` or `GITHUB_TOKEN`
  - No token or client key appears on standard error or in help output

- [ ] **Document the token command**

  Update the CLI part of `docs/subsystems/tessera/contract.md` and the Tessera line in `AGENTS.md`.

  _Acceptance criteria:_
  - The contract states the output guarantee and the exit behavior
  - The contract states there is no fallback to host credentials
  - The contract states that the credential-helper and status commands belong to later stories
  - The advisory contract check reports no error for Tessera

**PR Outcome**: An operator, and later the steward shims, can obtain a bot token from the shell. All of AS 4.1–4.5 hold.

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
| SD-017 | When the fallback flag is set and identity is `app`, which Tessera failures count as "cannot issue" (AS 4.3) and allow the env fallback? The choice is between: (a) availability failures only: `unreachable`, `provider_unavailable`, `provider_unconfigured`, `credential_invalid`, `mint_failed`, `internal`; (b) list (a) plus a missing or rejected client key (client-side missing key, `unauthorized`), covering services that have no key yet during migration; (c) any failure, including `policy_denied`, `invalid_request` and `repo_not_installed`. | Scope Edges | High | Medium | open | — |
| SD-018 | If `MARCH_TESSERA_URL` is unset, which should the client do: (a) default to `http://localhost:<resolveTesseraPort()>` (9477), or (b) raise a typed configuration error before any request, as the contracts' "Required: Yes" implies? | Scope Edges | Medium | Medium | open | — |
| SD-019 | What should `GitHubEntitlement.identity` hold on an `env-fallback` result, when the token's login is unknown without asking GitHub? The choice is between: (a) an empty string; (b) a fixed marker such as `"env-fallback"`; (c) the login resolved through a GitHub `/user` call. | Technical Risk | Low | Medium | open | — |
| SD-020 | Should the client cache an entitlement whose `expiresAt` is null (only a `user` PAT with no discoverable expiry)? The choice is between: (a) never cache it, so every call asks Tessera; (b) cache it for a bounded TTL (for example 10 minutes). | Technical Risk | Low | Medium | open | — |

Working defaults in the tasks: SD-017 takes (a) plus a client-side missing key, but not a key Tessera refused; SD-018 takes (a); SD-019 takes (a); SD-020 takes (a). IDs continue from the User Story 2 tasks file, which ends at SD-016.

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Fetch Tokens Through a Fail-Closed Client | — | — |
| S2 | Print a Token from the CLI | S1 | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Mint a Downscoped Bot Token | depends on | The token route and the wire Entitlement the client maps. |
| User Story 2: Enforce a Default-Deny Policy per Client | depends on | The bearer scheme and the `unauthorized` and `policy_denied` codes the client surfaces. |
| User Story 3: Keep Credentials Only in Tessera | depended upon by | US3 has `march up` inject each service's client key and Tessera URL; this story only reads them. |
| User Story 5: Stewards Open Pull Requests as the Bot | depended upon by | US5 builds the `gh` wrapper and the `march tessera git-credential` command on the client and the token command from this story. |
| User Story 6: Migrate Services off the Ambient Token | depended upon by | US6 moves the existing environment-token readers onto `getGitHubToken`; none is touched here. |
| User Story 7: Request a Copilot Review as the Operator | depended upon by | US7 calls `getGitHubToken` with the `user` identity. |
| User Story 8: See Issuances, Expiry and Health | depended upon by | US8 adds the client's status and reachability calls, `march tessera status`, the doctor check and dashboards. |
