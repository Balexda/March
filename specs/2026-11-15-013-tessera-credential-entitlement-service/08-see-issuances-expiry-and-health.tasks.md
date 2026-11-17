# Tasks: See Issuances, Expiry and Health

**Source**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.spec.md` — User Story 8
**Data Model**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.data-model.md`
**Contracts**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.contracts.md`
**Story Number**: 08

---

## Slice 1: Audit, Trace and Count Every Token Request
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Every request to the token route — issued, denied, invalid, unauthenticated or failed — produces exactly one `tessera.audit` log event, one `tessera.issue` span and one counter increment. The span nests in the slice trace when a slice id is supplied, and no token, key, hash or header reaches any log, span or metric.

**Justification**: This is the story's independent test against fakes. It needs only the existing server and stub providers, and it establishes the per-request record the later slices read.

**Addresses**: FR-015, FR-034, FR-035, FR-036, FR-038; Acceptance Scenarios 8.1, 8.2, 8.3, 8.5

### Tasks

- [ ] **Emit one audit event for every token request**

  In `src/tessera/server.ts`, record what each token request resolved on a per-request context, and emit one `tessera.audit` event from the response hook, which also sees requests rejected by the authentication hook or the error handler. Build the event in a new `src/tessera/audit.ts` as a pure function that copies an allow-list of fields — exactly the Issuance Audit Record (data model). Satisfies the audit half of AS 8.1 and FR-015.

  _Acceptance criteria:_
  - Issued (cache hit and miss), unauthorized, invalid, policy-denied and provider-failed requests each yield exactly one event
  - An unauthenticated request records the caller as unknown; fields not resolved before rejection are null
  - A rejected request with a 4xx status is `denied` and a 5xx is `failed`, with the error code as the reason
  - The subject is echoed when sent; the cache result is `n/a` unless a token was issued
  - No other route emits an audit event
  - A field added to the per-request context does not reach the event unless the builder lists it

- [ ] **Emit a `tessera.issue` span nested in the slice trace**

  Add `src/observability/tessera-trace.ts`, following the service-side child-span pattern in `src/observability/herald-trace.ts`, and emit one span per token request from the same response hook with the request's own start and end times (contracts "Events / Hooks"). Attach the span's trace and span ids to the `tessera.audit` log line as log-correlation fields, outside the Issuance Audit Record allow-list. Satisfies the span half of AS 8.1 and AS 8.2, and AS 8.3.

  _Acceptance criteria:_
  - One span per token request, including unauthenticated and invalid ones
  - With a valid slice id the span is a child on that slice's deterministic trace and never claims its root
  - With no slice id, or an invalid one, the span starts a service-local trace
  - The span is errored unless a token was issued
  - Attributes are limited to the contract's list; none carries a repository, token or client key
  - Nothing is emitted, and nothing fails, when telemetry is off

- [ ] **Count issuances and denials**

  Add the server-side issuance and denial counters (contracts "Events / Hooks") to `src/observability/tessera-metrics.ts` and record them from the same per-request record. Satisfies the counting half of AS 8.2.

  _Acceptance criteria:_
  - An issued request increments issuances once and never denials
  - A denied or failed request increments denials once, with its error code as the reason
  - An unresolved identity is recorded under one fixed placeholder value
  - No label carries a repository, client name, client key or token
  - The existing consumer-side fallback counter is unchanged

- [ ] **Prove no credential reaches any output**

  Add redaction for credential-bearing fields to the Tessera logger in `src/observability/logger.ts`, as a second layer behind the audit allow-list, and a test in `src/tessera/server.test.ts` that drives issued, cached, denied and failed requests with a sentinel token and a sentinel client key at the most verbose log level. Satisfies AS 8.5 and FR-038.

  _Acceptance criteria:_
  - Neither sentinel, nor the key's hash, appears in any captured log line at any level
  - Neither appears in a span attribute, a metric label, the `/status` body or an error body
  - An error whose message contains a sentinel does not surface it
  - Other services' loggers are unaffected

- [ ] **Document the audit event, span and counters**

  Update `docs/subsystems/tessera/contract.md`, `docs/Observability.md` and the Tessera line in `AGENTS.md`.

  _Acceptance criteria:_
  - The contract lists the audit fields, the denied and failed rule, and the unknown-caller rule
  - The observability guide names the span, its parentage rule and the two counters with their labels
  - Both state that no token, key, hash or header is ever logged
  - The advisory contract check reports no error for Tessera

**PR Outcome**: An operator can read who obtained what from logs, traces and counters. AS 8.1, 8.2, 8.3 and 8.5 hold.

---

## Slice 2: Report Credential and GitHub Health
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Tessera reports GitHub call health — mint latency, rate-limit remaining and secondary-limit hits — and flags any credential within 14 days of expiry on `/status`, in a gauge, and in a warning logged at most once a day.

**Justification**: These are provider-side signals, independent of the per-request audit. The expiry rule is built once for every provider and tested with a fake that reports an expiry, so it does not wait on the operator-token provider.

**Addresses**: FR-036, FR-037, FR-038, FR-039; Acceptance Scenario 8.4

### Tasks

- [ ] **Record GitHub call health from the GitHub client**

  Give the GitHub client in `src/tessera/providers/github-app/github-client.ts` an optional call observer, and have the github-app provider forward its reports, labeled with the provider id, to new instruments in `src/observability/tessera-metrics.ts` (contracts "Events / Hooks"). The client holds no metrics logic, and failure classification does not change.

  _Acceptance criteria:_
  - Mint duration is recorded for the token-mint call only, with provider and outcome; a cache hit records nothing
  - The rate-limit gauge follows the latest response that carries the header and is untouched otherwise
  - A secondary-rate-limit response increments its counter once and still surfaces as the same typed error
  - No label or report carries a repository, token or assertion
  - With no observer the client behaves exactly as before

- [ ] **Flag credentials within 14 days of expiry on `/status`**

  Add `src/tessera/expiry.ts` with the 14-day rule and an injectable clock, and have `/status` in `src/tessera/server.ts` apply it to every provider's credential expiry, so a provider reports an expiry and never computes the warning itself. Satisfies the `/status` part of AS 8.4.

  _Acceptance criteria:_
  - A credential expiring within 14 days, or already expired, is flagged
  - A credential with no expiry, or more than 14 days away, is not
  - The soonest-expiry field behaves as before
  - A provider whose status call fails still degrades as today
  - `/status` matches the contracts "Health and Status" shape and carries no secret or policy content

- [ ] **Warn at most daily and publish seconds until expiry**

  Add a credential health monitor under `src/tessera`, started from `src/tessera/serve.ts` and stopped with the server. It publishes the seconds-until-expiry gauge per provider and logs a `tessera.expiry_warning` event for a credential inside the 14-day window. Satisfies the log and gauge parts of AS 8.4.

  _Acceptance criteria:_
  - A credential inside the window logs one warning, and no more than one per day per provider
  - The gauge reports remaining seconds for a provider with an expiry and nothing for one without
  - The gauge and warning do not depend on a request arriving
  - The timer does not keep the process alive and is cleared on shutdown
  - A provider whose status call fails does not stop the monitor
  - The warning and the gauge carry the provider and expiry only

- [ ] **Document the health signals**

  Update `docs/subsystems/tessera/contract.md` and `docs/Observability.md`.

  _Acceptance criteria:_
  - Both list the new instruments with their labels
  - The contract states the 14-day rule, the daily cadence and that the cadence resets on restart
  - The contract states that only a credential with a discoverable expiry can warn, and that the GitHub App key has none
  - The advisory contract check reports no error for Tessera

**PR Outcome**: GitHub call health and credential expiry are visible on metrics, in logs and on `/status`. AS 8.4 holds against a fake provider; a real expiring credential arrives with User Story 7.

---

## Slice 3: Read Status from the Client and the CLI
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: The Node client can fetch Tessera's status and test reachability, and `march tessera status` prints provider state and expiry as a table or as JSON.

**Justification**: A thin layer over the status route that already exists. It works with today's status document and picks up the Slice 2 fields with no further change.

**Addresses**: FR-039; contracts "Node Client" and "CLI"

### Tasks

- [ ] **Add status and reachability calls to the client**

  Move the status document's type from `src/tessera/server.ts` to `src/tessera/types.ts`, since the client may not import the server module, and add `status()` and `reachable()` to `TesseraClient` in `src/tessera/client.ts` per the contracts "Node Client" section.

  _Acceptance criteria:_
  - `status()` returns the parsed document, or raises the client's typed `unreachable` error within the existing bound
  - `reachable()` returns a boolean and never throws
  - Neither call sends the client key, and neither needs one configured
  - Neither touches the entitlement cache or the fallback path
  - The server's behavior is unchanged by the type move

- [ ] **Add the `march tessera status` command**

  Add a `status` subcommand to the `tessera` group in `src/cli/program.ts`, with its logic beside the token command in `src/tessera/cli.ts`, per the contracts "CLI" section. Extend the `march tessera` block in `src/cli/program.test.ts`.

  _Acceptance criteria:_
  - The default output is a table of each provider's state, login, expiry and warning, with the soonest expiry
  - `--json` writes the status document and nothing else to standard output
  - An unreachable Tessera exits non-zero with one line on standard error
  - The command reads no GitHub credential and works over HTTP alone
  - No token or client key appears in any output

- [ ] **Document the status calls**

  Update `docs/subsystems/tessera/contract.md` and the Tessera line in `AGENTS.md`.

  _Acceptance criteria:_
  - The contract documents both client calls and the command
  - The earlier statement that these belong to a later story is removed
  - The advisory contract check reports no error for Tessera

**PR Outcome**: An operator and other code can ask Tessera for its health from the shell and from Node.

---

## Slice 4: Check Tessera in Doctor and Chart It
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: `march doctor` reports whether Tessera is reachable, whether each service's client key is accepted, and which services still carry an ambient GitHub token. A Grafana dashboard shows issuances, denials, mint latency and time to expiry.

**Justification**: These are the operator surfaces over the signals from Slices 1 to 3. The doctor checks degrade to warnings on a stack that has not been migrated, so they are useful before the stories they observe have landed.

**Addresses**: FR-040, FR-041; Acceptance Scenarios 8.6, 8.7

### Tasks

- [ ] **Report Tessera reachability and ambient GitHub tokens in doctor**

  Add a Tessera check under `src/doctor/checks`, registered and wired the way the Castra token-wiring check is, with a Tessera probe on the doctor context backed by the Slice 3 client. Ambient tokens are found by reading the two GitHub token variables from each service container's environment. Satisfies the reachability and ambient-token parts of AS 8.6.

  _Acceptance criteria:_
  - A reachable Tessera passes; an unreachable one is a finding with a remedy
  - A stack with no Tessera running is a warning, not a failure
  - Each service still carrying a GitHub token is named by service and variable; the value is never printed
  - An ambient token is a warning
  - A provider that is degraded, invalid or within its expiry window is surfaced
  - The check never throws and never requests a token

- [ ] **Report whether each service's client key is accepted**

  In the same check, read each service container's Tessera client key from its environment and probe the token route with a deliberately invalid body, behind one replaceable probe function: an authentication failure means the key is rejected, a validation failure means it is accepted, and nothing is minted. Satisfies the client-key part of AS 8.6.

  _Acceptance criteria:_
  - An accepted key, a rejected key, a service with no key and an unverifiable probe each produce a distinct finding naming the service
  - A rejected key is a failure; a service with no key is a warning
  - No key, hash or fingerprint is printed
  - No token is requested or minted

- [ ] **Add the Tessera dashboard**

  Add `docker/grafana/dashboards/march-tessera.json`, following the Statio dashboard, and extend `src/tessera/container-artifacts.test.ts` the way the Statio artifact test covers its dashboard. Satisfies AS 8.7.

  _Acceptance criteria:_
  - Panels show issuances, denials by reason, mint latency and time to expiry, plus rate-limit remaining, secondary limits and recent logs and traces
  - Queries use only the metrics the service emits and their low-cardinality labels
  - No panel filters or groups by repository, client key or token
  - The artifact test fails if the dashboard is removed or stops referencing a contract metric

- [ ] **Document doctor and the dashboard**

  Update `docs/subsystems/tessera/contract.md` and `docs/Observability.md`.

  _Acceptance criteria:_
  - The contract states what each doctor finding means and that no check mints a token
  - The contract states that a real stack reports every service as having no key until `march up` injects them
  - The contract states that each doctor run adds one invalid-request audit record per probed service
  - The observability guide names the dashboard and what each panel answers
  - The advisory contract check reports no error for Tessera

**PR Outcome**: Doctor shows Tessera's reachability and how far the migration has come, and the dashboard charts the service. AS 8.7 holds; AS 8.6 holds as far as the unlanded stories allow.

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
| SD-021 | Which audit `outcome` should `unauthorized` (401), `invalid_request` (400) and `repo_not_installed` (422) get? The choices are (a) by status class: every 4xx is `denied`, every 5xx (`provider_unconfigured`, `credential_invalid`, `provider_unavailable`, `mint_failed`) is `failed`; or (b) only policy-shaped rejections (`unauthorized`, `policy_denied`) are `denied`, and malformed or uninstallable requests count as `failed`. The contracts only pin `policy_denied` to `denied`. | Technical Risk | Medium | Medium | open | — |
| SD-022 | Should "at most once a day" for `tessera.expiry_warning` survive restarts? The choices are (a) in-memory per-provider timestamps, so a restart can warn again the same day; or (b) last-warned timestamps saved on Tessera's state volume, so the once-a-day bound holds across restarts. | Scope Edges | Low | Medium | open | — |
| SD-023 | Where should `march doctor` get the list of services whose client-key wiring it checks? The choices are (a) a static list of known Tessera consumers in the doctor; (b) the MARCH_SERVICES registry that US3 fills in; or (c) the client names in the Tessera policy, which would need a new non-secret listing because /status must not expose policy content. | Scope Edges | Medium | Medium | open | — |
| SD-024 | The Slice 4 doctor tasks find client keys and ambient tokens by reading each service container's environment, but `steward` is a Tessera client that runs in host panes, not a container, and how its key is delivered is still open (inherited SD-003). With a static consumer list it is not defined whether the steward is checked, how, or what finding it gets, which affects how much of AS 8.6 the slice covers. | plan-review:Logical gap | Important | Low | open | — |

Working defaults in the tasks: SD-021 takes (a); SD-022 takes (a); SD-023 takes (a). For inherited SD-008, the doctor uses the invalid-body probe behind one replaceable function. IDs continue from the User Story 4 tasks file, which ends at SD-020.

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Audit, Trace and Count Every Token Request | — | — |
| S2 | Report Credential and GitHub Health | S1 | — |
| S3 | Read Status from the Client and the CLI | — | — |
| S4 | Check Tessera in Doctor and Chart It | S1, S2, S3 | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Mint a Downscoped Bot Token | depends on | The token route, the providers and the status route this story instruments. |
| User Story 2: Enforce a Default-Deny Policy per Client | depends on | The authenticated caller name and the `unauthorized` and `policy_denied` outcomes recorded in the audit event. |
| User Story 4: Fetch Tokens Through One Client | depends on | The client and CLI group that the status calls extend. |
| User Story 3: Keep Credentials Only in Tessera | depended upon by | The doctor's client-key check reports every service as having no key until `march up` injects them. |
| User Story 7: Request a Copilot Review as the Operator | depended upon by | Only the operator token has a discoverable expiry; AS 8.4 is exercised end to end once that provider exists. |
| User Story 6: Migrate Services off the Ambient Token | depended upon by | The ambient-token finding goes quiet as services migrate. |
| User Story 9: Remove Ambient GitHub Credentials | depended upon by | US9 can turn the ambient-token warning into a failure. |
