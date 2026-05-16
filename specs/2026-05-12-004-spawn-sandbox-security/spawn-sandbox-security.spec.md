# Feature Specification: Spawn Sandbox Security

**Spec Folder**: `2026-05-12-004-spawn-sandbox-security`
**Branch**: `feature/smithy/mark/01-spawn-f4` *(orchestrator-staged linked worktree; preserved per Branch Selection Policy because the cwd is a non-default linked worktree)*
**Created**: 2026-05-12
**Status**: Draft  |  **Implementation status (2026-05-16)**: **Not started.** See [Accelerated context](#accelerated-context-2026-05-16) below before reading the rest of the spec — the multi-backend landscape shifted after this spec was drafted (Gemini cut, Codex added with credential-mount auth) and three FRs need re-aiming.

## Accelerated context (2026-05-16)

This spec was drafted on 2026-05-12 against an assumed Claude-Code + Gemini backend pair where both use env-var auth and neither needs a host bind mount. Two changes have since landed that affect this spec materially. They do **not** invalidate F4's core architecture (per-spawn proxy sidecar, `--network=none`, expanded `SNAPSHOT_EXCLUSION_PATTERNS`, verify CLI, threat-model audit) — but they require three FR re-aimings before implementation.

**Change 1 — Gemini cut, Codex added.** Gemini was dropped as a supported backend on 2026-05-16 (see RFC Decisions and [Accelerated Work & Reordering](../../docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md#accelerated-work--reordering-2026-05)). Codex (`march-spawn-codex:latest`) is the second backend. Implications:

- **SD-001 is resolved by being replaced.** "Gemini hostname set" is moot. The same shape of question now applies to Codex: what hostname(s) does `chatgpt.com` / OpenAI's API serve from for the Codex CLI? Tracked as the new [SD-008](#specification-debt-2026-05-16-additions).
- All Gemini references in scenarios, FRs, and assumptions (US1 AS7, US2 AS3, FR-001, Assumption §4) should be read as **applying to Codex** at render/cut time. Examples:
  - FR-001: "The Codex backend's value MUST be set per [SD-008](#specification-debt-2026-05-16-additions)'s resolution" replaces the Gemini sentence.
  - US2 AS3: "Given the `codexBackend` implementation, **When** the dispatch action reads `codexBackend.allowedEgressHosts`, **Then** the value matches the OpenAI/Codex hostname set as resolved by SD-008."

**Change 2 — Codex uses credential-mount auth.** Codex bind-mounts the host's `CODEX_HOME` directory read-only into the container at `/march/codex-auth`; the entrypoint copies it into the in-container home (`cp -R /march/codex-auth/. /march/codex-home`). This is a **typed exception** to the "no host bind mounts ever" invariant — it is intrinsic to the backend, declared on `SpawnBackend`, not operator-authored. Implications:

- **US5's bind-mount reject validator must admit a typed exception.** As written, FR-012 rejects any `-v` / `--mount` / `--volume` flag — which would block every Codex spawn. The validator must instead reject any bind-mount flag *whose source path is not declared by the selected backend's credential-mount spec*. The exception is anchored on the `SpawnBackend` interface (per the amended multi-backend spec), so the validator is still structurally enforced: a contributor cannot quietly add a bind mount without first declaring it on a registered backend. New [SD-009](#specification-debt-2026-05-16-additions) tracks the validator's exception predicate.
- **The `SpawnBackend` interface now has 6 members, not 5.** F4's US2 / FR-002 / SC-007 expand it from F3's 4 to 5 (`allowedEgressHosts`). The amended multi-backend spec adds `credentialMount?: BackendCredentialMountSpec` as a 6th, optional member. F4's "exactly five members" assertions should be relaxed to "at least five required members including `allowedEgressHosts`, plus an optional `credentialMount`" — or F4 can defer to the multi-backend spec's interface declaration for the canonical shape.
- **A2 threat-model row** in the US6 audit table should note credential-mount as a typed exception with its own residual-risk note: the host's `CODEX_HOME` is exposed read-only to the spawn container, so any secrets co-located there beyond Codex's own auth tokens would leak. Operators should not store unrelated secrets in `CODEX_HOME`. Tracked as [SD-010](#specification-debt-2026-05-16-additions).

The architecture is otherwise unchanged. `--network=none` + proxy sidecar still applies to Codex; the snapshot exclusion list still applies; the verify CLI's A1/A3/A4/A5/A7/A8 controls still apply with no change. Only A2's "no bind mounts" expected-shape needs the typed-exception relaxation.


**Input**: `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md` — Milestone 1: Spawn (Appendix A: Spawn Sandbox Threat Model — A1–A8)
**Source Feature Map**: `docs/rfcs/2026-001-march-orchestration-platform/01-spawn.features.md` — Feature 4: Spawn Sandbox Security

## Clarifications

### Session 2026-05-12

- Q: Does F4 grow `SpawnConfig` beyond the F3-narrowed 6 fields? → A: Yes. F4 adds `pidsLimit` (A8 fork-bomb defense) and `readOnlyRootfs` (A1/A2 persistence defense, with tmpfs `/tmp` as the writable scratch path). Final field set: `capDrop`, `user`, `networkMode`, `memoryLimit`, `cpuLimit`, `timeoutSeconds`, `pidsLimit`, `readOnlyRootfs`. `[Critical Assumption]`
- Q: Does F4 promote A6 (output-channel manipulation) to its own user story? → A: No. F4 publishes A6 mitigation requirements as a contract subsection inside US6 (the audit story). F5 (Spawn Output Extraction) implements them. F4 does not ship runtime output validation. `[Critical Assumption]`
- Q: Does F4 re-open F3's "SpawnBackend interface closed at 4 members" decision? → A: Yes, formally. US2 adds `allowedEgressHosts: readonly string[]` as the 5th member, and the spec explicitly supersedes F3's FR-005 / SC-005 / line-222 invariant. Rationale: A7 mitigation is intrinsically per-backend (Claude needs `api.anthropic.com`; Gemini needs Google API hosts) and belongs alongside `requiredEnvVars` / `baseImage`, not on container posture. `[Critical Assumption]`
- Q: What is Claude Code's allowed egress host set? → A: `["api.anthropic.com"]`. Directly stated in RFC Appendix A7 (LLM Credentials and Network Access — mitigations bullet citing `api.anthropic.com`) and RFC Appendix C4 (Claude Code Backend — Network requirements paragraph).
- Q: What is Gemini's allowed egress host set? → A: Best inference is `["generativelanguage.googleapis.com"]`, but the RFC does not pin a hostname (only "Gemini API endpoints", plural — see RFC Appendix A7 mitigations bullet) and Gemini CLI may need additional Google auth/discovery hosts. Recorded as SD-001.
- Q: What is the verify CLI's report format and exit-code contract? → A: Structured JSON to stdout (one object per A1–A8 control with `status: "pass" | "fail" | "n/a"` and the inspected vs. expected values). Exit codes mirror F2: `0` = all controls pass, `1` = one or more controls fail, `2` = usage error (bad args, unknown spawn-id, no such container). Reuses `SUCCESS` / `ERROR` / `USAGE_ERROR` from `src/exit-codes.ts`.
- Q: Does `march spawn verify` work on stopped/historical spawns? → A: No. Running containers only — verify shells out to `docker inspect <container-id>` resolved from the SpawnRecord. Stopped containers no longer have an attached network or proxy sidecar to inspect, and forensic post-mortem of completed spawns is out of F4 scope.
- Q: Does the proxy sidecar specification choose a concrete image (tinyproxy / mitmproxy / custom)? → A: No. The spec defines the contract (HTTP CONNECT proxy, hostname allowlist evaluated at CONNECT time, separate container on a private user-defined Docker network, spawn container runs `--network=none` and routes via `HTTP_PROXY` / `HTTPS_PROXY` env vars). The concrete image choice is implementation detail and is deferred to render/cut.
- Q: Is the snapshot exclusion expansion (US3) additive or does it change matching semantics? → A: Purely additive. New patterns extend the existing `SNAPSHOT_EXCLUSION_PATTERNS` array consumed by `isExcludedPath` in `src/snapshot.ts`. Pattern syntax (basename glob vs trailing-slash directory segment) follows the existing convention; no engine changes.
- Q: Does the bind-mount validator (US5) parse operator input? → A: No. It inspects the composed `docker run` argv array assembled by `launchSpawnContainer` and rejects launch with `ERROR` exit if any of `-v`, `--mount`, or `--volume` flags are present. The Claude Max OAuth bind-mount of `~/.claude/` is explicitly listed as deferred-to-post-M1 in Out of Scope, and the validator structurally enforces that ruling.

### Assumptions

- F3 (Multi-Backend Execution Interface) lands before F4 implementation begins. F4's spec writes against the post-F3 narrowed `SpawnConfig` (6 fields, no `envWhitelist` — `envWhitelist` is reborn as `SpawnBackend.requiredEnvVars`) and the post-F3 `SpawnBackend` interface (4 members: `name`, `baseImage`, `requiredEnvVars`, `buildEntrypoint`). The current in-tree `src/spawn-config.ts` still carries `envWhitelist` because F3's PR has not yet merged on this branch — this is expected and not a blocker.
- The auth pre-flight check (per-backend `requiredEnvVars` presence verification) is owned by F3 (US6). F4 does NOT re-claim it. The stale comment in `src/container-launch.ts` (the doc-comment paragraph beginning "Env-vars are passed via `-e VAR` passthrough…") is wrong post-F3 and is incidentally cleaned up when F4 modifies that file.
- "No bind mounts ever" is enforced as a code-level invariant by US5's validator, not by code-review discipline alone. This makes the OAuth deferral structurally enforced — a future contributor cannot quietly slip `~/.claude/` into the launch argv.
- The RFC's preference for IP-based outbound restrictions (Appendix A4 / A7) is operationally infeasible for cloud APIs that rotate CDN IPs. F4 resolves this by performing allowlist evaluation at the **proxy layer** (hostname-based, evaluated at HTTP CONNECT time) rather than at the container's `--network` layer. The spawn container itself runs `--network=none` and reaches the proxy via a private user-defined Docker network. No DNS resolution happens inside the spawn container.
- Resource ceilings inherited from F2 (`memoryLimit: "4g"`, `cpuLimit: "2"`, `timeoutSeconds: 3600`) are evaluated in US6 against the threat model and retained without change. Per-spawn override is Hatchery's (M2) job.
- `pidsLimit` and `readOnlyRootfs` are static across backends — they live on `SpawnConfig`, not `SpawnBackend`. The per-backend egress allowlist is intrinsically backend-coupled and lives on `SpawnBackend`.
- The verify CLI's optional `--probe` flag is for sandbox auditing, not CI smoke. Probe failure (a CONNECT to `1.1.1.1:443` succeeding) is the verification *failure* mode; in air-gapped CI the probe should be omitted.
- The proxy sidecar's lifecycle is tied 1:1 to the spawn container via a private Docker network created at dispatch time and torn down when the spawn container exits. Cleanup of the sidecar and the private network reuses F2's reverse-order cleanup chain (Stage 4 cleanup grows by two artifacts: proxy container, private network).
- Verify operates on running containers only. The spawn must still be running when `march spawn verify <spawn-id>` is invoked. This is a pragmatic scope bound — once the spawn has exited, the network/proxy posture has been torn down and is no longer observable via `docker inspect`.

## Artifact Hierarchy

RFC → Milestone → Feature → User Story → Slice → Tasks

## User Scenarios & Testing

### User Story 1: Restrict Outbound Network Egress (Priority: P1)

As an operator, I want my spawn container to be unable to reach any host on the internet other than the LLM backend's API endpoints, so that an LLM running in full-auto mode cannot exfiltrate the repository's contents, leak credentials via DNS, or pivot to other services on my host or network.

**Why this priority**: This is the largest open gap in the F2 baseline. F2 ships `networkMode: "bridge"` with full outbound internet access — directly contradicting the RFC's claim that spawns have "no outbound network access" (RFC Design Considerations and Milestone 1 Success Criterion). Without this story, the operator cannot trust the sandbox.

**Independent Test**: Dispatch a spawn that deliberately attempts to reach a non-allowlisted host (e.g., `curl https://example.com` as part of the prompt). Verify the request fails with a connection-refused or 403 from the proxy. Then verify the spawn's legitimate request to `api.anthropic.com` (or the selected backend's allowlisted host) succeeds.

**Acceptance Scenarios**:

1. **Given** a Claude Code spawn is dispatched, **When** the spawn container is created, **Then** the container is launched with `--network=none` and joined to a private user-defined Docker network named per spawn (e.g., `march-spawn-net-<spawn-id>`).
2. **Given** the private spawn network, **When** the dispatch runs, **Then** an HTTP CONNECT proxy sidecar container is started attached to that private network at `docker run` time AND a follow-up `docker network connect bridge <proxy-container>` attaches it to the default Docker bridge as well — making the proxy sidecar the **only** multi-homed component (private network for the spawn-side ingress, bridge for the operator-side egress). The spawn container itself is single-homed (private network only).
3. **Given** a running spawn, **When** the backend CLI inside the spawn container reads `HTTP_PROXY` and `HTTPS_PROXY` (or the equivalent backend-specific configuration), **Then** all outbound HTTPS requests are routed to the proxy sidecar via its Docker DNS name on the private spawn network (e.g., `http://march-spawn-proxy-<spawn-id>:8080`) — NOT via `127.0.0.1` / loopback, which would not reach a separate container.
4. **Given** the proxy sidecar, **When** a CONNECT request arrives for a host listed in the selected backend's `allowedEgressHosts`, **Then** the proxy permits the connection.
5. **Given** the proxy sidecar, **When** a CONNECT request arrives for any host NOT in the selected backend's `allowedEgressHosts` (including by-IP requests like `1.1.1.1:443`), **Then** the proxy refuses the connection and the spawn observes a connection error.
6. **Given** a Claude Code spawn, **When** the proxy is queried for its allowlist, **Then** the allowlist is exactly `["api.anthropic.com"]` per US2.
7. **Given** a Gemini spawn, **When** the proxy is queried for its allowlist, **Then** the allowlist matches the resolved Gemini hostname set per US2 and SD-001.
8. **Given** a spawn container, **When** the operator inspects its DNS configuration, **Then** the container has no DNS resolver configured (because `--network=none` strips `/etc/resolv.conf`); name resolution happens only inside the proxy sidecar.
9. **Given** the spawn container exits (success, failure, or timeout), **When** F2's reverse-order cleanup runs, **Then** the proxy sidecar container is stopped and removed AND the private user-defined Docker network is removed.
10. **Given** a proxy-sidecar startup failure (image unavailable, port collision, daemon error), **When** dispatch attempts to launch, **Then** the dispatch fails with a clear error citing the proxy as the failure cause, the spawn container is not launched, and the worktree/branch are cleaned up.

---

### User Story 2: Per-Backend Egress Allowlist on `SpawnBackend` (Priority: P1)

As a March maintainer, I want each registered backend to declare exactly which outbound hostnames it requires, so that the proxy sidecar's allowlist is sourced from the same single source of truth that already owns base image, env vars, and entrypoint argv — and so that a future backend addition is a self-contained change.

**Why this priority**: US1's proxy enforcement needs a per-backend allowlist as input. Without US2, the allowlist would either live as a hardcoded constant in F4 code (re-introducing the cross-backend leakage F3 just removed) or in a parallel `BackendNetworkPolicy` registry (duplicating F3's lookup surface). US2 keeps the post-F3 architecture's single-source-of-truth principle intact.

**Independent Test**: Read the `SpawnBackend` interface declaration. Verify it has exactly five members: `name`, `baseImage`, `requiredEnvVars`, `buildEntrypoint`, and `allowedEgressHosts: readonly string[]`. Read the `claudeCodeBackend` and `geminiBackend` implementations and verify each declares its own hostname set.

**Acceptance Scenarios**:

1. **Given** the `SpawnBackend` interface declaration, **When** a developer reads it, **Then** it declares exactly five members. The fifth, `allowedEgressHosts`, is `readonly string[]`.
2. **Given** the `claudeCodeBackend` implementation, **When** the dispatch action reads `claudeCodeBackend.allowedEgressHosts`, **Then** the value is `["api.anthropic.com"]`.
3. **Given** the `geminiBackend` implementation, **When** the dispatch action reads `geminiBackend.allowedEgressHosts`, **Then** the value matches the Gemini API hostname set as resolved by SD-001 (current best inference: `["generativelanguage.googleapis.com"]`).
4. **Given** the `SpawnBackend` interface change, **When** F3's spec is read, **Then** F4's spec explicitly supersedes F3's FR-005 ("`SpawnBackend` interface MUST be defined with exactly four members") and FR-012's narrowed `SpawnConfig` is preserved unchanged. The supersession is acknowledged in F4's Clarifications, not silent.
5. **Given** the dispatch pipeline, **When** the proxy sidecar is configured at Stage 4 (Launch), **Then** the allowlist passed to the proxy is sourced from `selectedBackend.allowedEgressHosts` — not from a global constant, not from `SpawnConfig`, and not from a parallel registry.
6. **Given** a future contributor adds a third backend, **When** they implement the `SpawnBackend` interface, **Then** the type system requires them to provide an `allowedEgressHosts` value, making the per-backend egress decision a compile-time enforcement rather than a runtime omission.

---

### User Story 3: Expand Snapshot Exclusion Patterns (Priority: P1)

As an operator, I want a comprehensive set of credential patterns excluded from the worktree snapshot, so that secrets accidentally tracked in my repository (SSH keys, cloud credentials, language-package tokens, browser keystores) cannot reach the LLM and be embedded in its output.

**Why this priority**: F2 ships a deliberately minimal exclusion list (`.env`, `.env.*`, `*.pem`, `*.key`, `.secrets/`, `credentials.json`) that misses common credential patterns. The RFC Appendix A5 explicitly calls out "scanning the snapshot for known secret patterns" as a mitigation; F4 raises the floor by expanding the pattern list. Without this story, a tracked SSH private key or `.aws/credentials` file lands in the spawn's container.

**Independent Test**: Create a fixture worktree containing one file matching each new excluded pattern (`id_rsa`, `id_ed25519`, `keystore.p12`, `bundle.pfx`, `.npmrc`, `.aws/credentials`, etc.). Run the snapshot step. Verify each fixture file is excluded from the resulting build context.

**Acceptance Scenarios**:

1. **Given** the post-F4 `SNAPSHOT_EXCLUSION_PATTERNS` array, **When** a developer reads it, **Then** the array contains the F2 baseline (`.env`, `.env.*`, `*.pem`, `*.key`, `.secrets/`, `credentials.json`) AND the F4 expansion: `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`, `*.p12`, `*.pfx`, `*.jks`, `.npmrc`, `.pypirc`, `.netrc`, `.aws/`, `.ssh/`, `.gnupg/`, `.docker/config.json`, `.kube/config`.
2. **Given** a worktree containing a tracked file at `.ssh/id_rsa`, **When** the snapshot is built, **Then** the file is excluded from the build context (matched by both the `id_rsa` basename pattern AND the `.ssh/` directory-segment pattern, either is sufficient).
3. **Given** a worktree containing a tracked file at `subdir/keystore.p12`, **When** the snapshot is built, **Then** the file is excluded from the build context (basename pattern `*.p12` matches at any depth, per the existing `isExcludedPath` semantics).
4. **Given** a worktree containing a tracked file at `.aws/credentials`, **When** the snapshot is built, **Then** the file is excluded from the build context (directory-segment pattern `.aws/` matches the parent directory at any depth).
5. **Given** the matching engine in `src/snapshot.ts`, **When** US3 lands, **Then** the existing `isExcludedPath` semantics (basename glob with `*` and `?` wildcards; directory-segment literal with trailing slash) are preserved unchanged. Only the pattern list grows.
6. **Given** the existing F2 test that asserts the exact contents of `SNAPSHOT_EXCLUSION_PATTERNS`, **When** US3 lands, **Then** the test is updated to reflect the expanded list. This is an explicit test-update task, mirroring F3's `envWhitelist` removal pattern.

---

### User Story 4: Operator Sandbox Verification CLI (Priority: P1)

As an operator, I want to run a single command against a live spawn and get back a structured report saying whether each Appendix A control is enforced as expected, so that I can trust the sandbox without manually constructing `docker inspect` queries or memorizing the threat model.

**Why this priority**: The feature's stated user-facing value is "Verification commands confirm the sandbox posture." The RFC's Milestone 1 Success Criterion says "the operator can verify that the spawn had no network access and no disk access beyond the sandbox." Without this story, F4's hardening is invisible — the operator has no surface to confirm the sandbox is what F4 promised.

**Independent Test**: Dispatch a spawn. While it is running, run `march spawn verify <spawn-id>`. Verify the exit code is 0 and the JSON report contains entries for A1, A2, A3, A4, A5, A7, A8 with `status: "pass"` and the inspected/expected values populated. Then dispatch a spawn with a deliberately weakened config (e.g., a test fixture that drops the cap-drop flag) and verify the same command exits 1 and the affected control reports `status: "fail"`.

**Acceptance Scenarios**:

1. **Given** a running spawn, **When** the operator runs `march spawn verify <spawn-id>`, **Then** the command resolves the container ID via the SpawnRecord, runs `docker inspect`, and emits a structured JSON report to stdout.
2. **Given** the JSON report, **When** the operator reads it, **Then** it contains one entry per Appendix A control (A1, A2, A3, A4, A5, A7, A8 — A6 is skipped because it is F5's scope) with fields `control`, `status` (`"pass"` | `"fail"` | `"n/a"`), `expected`, and `observed`.
3. **Given** the verify command, **When** all controls report `pass`, **Then** the command exits with code 0 (`SUCCESS`).
4. **Given** the verify command, **When** any control reports `fail`, **Then** the command exits with code 1 (`ERROR`) and the failed controls are clearly identifiable in the JSON report.
5. **Given** a spawn-id that does not exist (no SpawnRecord), **When** the operator runs `march spawn verify <bad-id>`, **Then** the command exits with code 2 (`USAGE_ERROR`) and prints a clear "no such spawn" message to stderr.
6. **Given** a spawn-id whose recorded container has been removed (operator ran `docker rm`), **When** the operator runs verify, **Then** the command exits with code 2 and prints a clear "container no longer exists" message.
7. **Given** a stopped spawn (`status: "stopped"` in the SpawnRecord), **When** the operator runs verify, **Then** the command exits with code 2 and prints a clear "verify only works on running spawns; this spawn is stopped" message. Verifying terminated/historical spawns is out of F4 scope.
8. **Given** the verify command with the optional `--probe` flag, **When** the operator runs it against a running spawn, **Then** the command additionally executes a CONNECT probe to a known-blocked host (`1.1.1.1:443`) from inside the spawn container; the A4 control reports `pass` only if the probe fails to connect.
9. **Given** the verify command, **When** the JSON report is read by another tool (e.g., a CI script), **Then** the report's structure is stable across runs and documented in the contracts file.
10. **Given** the verify command, **When** the operator runs `march spawn verify --help`, **Then** usage output describes the `<spawn-id>` argument and the `--probe` flag.

---

### User Story 5: Bind-Mount Reject Validator + Claude Max OAuth Deferral (Priority: P1)

As a March maintainer, I want a hard validator at Stage 4 (Launch) that refuses to launch any spawn whose `docker run` argv contains a bind-mount flag, so that the no-host-filesystem-access invariant is structurally enforced rather than maintained by code-review discipline — and so that the explicit ruling to defer Claude Max OAuth bind-mounts to post-M1 is self-policing.

**Why this priority**: F2 happens to use no bind mounts because the snapshot-into-image design has no need for them. But the Claude Max OAuth path that F3 deferred to F4 is the textbook way someone would re-introduce a bind mount (`-v ~/.claude:/.claude:ro`). Without a validator, a future contributor could quietly weaken A2 in pursuit of OAuth support. The validator pre-empts that drift.

**Independent Test**: Dispatch a spawn under normal conditions and verify it succeeds (no false positives). Then patch `launchSpawnContainer` to inject a `-v /tmp:/tmp` argument before the validator and verify that dispatch fails with a clear "bind mount rejected" error, the worktree and image are cleaned up, and the SpawnRecord is marked failed.

**Acceptance Scenarios**:

1. **Given** the Stage 4 (Launch) validator runs, **When** the composed `docker run` argv is inspected, **Then** the validator iterates the argv and rejects any occurrence of `-v`, `--mount`, `--volume`, or any flag whose value contains the bind-mount pattern (`<host-path>:<container-path>`).
2. **Given** the validator rejects an argv, **When** dispatch responds, **Then** the command exits with code 1 (`ERROR`), prints a clear message naming the offending flag, and triggers F2's reverse-order cleanup (no container created, image removed, worktree and branch cleaned up).
3. **Given** a normal F2/F3 dispatch under post-F4 code, **When** the validator runs, **Then** it observes no bind-mount flags and silently allows the launch. The validator MUST NOT introduce any false positives against the existing F2/F3 acceptance scenarios.
4. **Given** the F4 spec, **When** an operator reads the Out of Scope section, **Then** Claude Max OAuth (read-only `~/.claude/` bind-mount) is explicitly listed as deferred to post-M1, with the rationale that any OAuth-via-bind-mount path must first be re-evaluated against the A2 threat model.
5. **Given** a future contributor wishes to reopen the OAuth bind-mount path, **When** they attempt to add `-v ~/.claude:/.claude:ro` to the launch argv, **Then** the validator rejects the launch and the test suite fails — forcing the contributor to either remove the bind mount or explicitly modify the validator (a reviewable, intentional change).
6. **Given** the validator, **When** a future legitimate need for tmpfs mounts arises (e.g., `--tmpfs /tmp` to support `readOnlyRootfs`), **Then** `--tmpfs` is whitelisted as an explicit exception — tmpfs mounts do NOT bind host filesystem paths and are safe under A2.

---

### User Story 6: Threat-Model Audit + A6 Contract for F5 (Priority: P2)

As a March maintainer (and the Hatchery / future-feature owner downstream), I want a single audit document that lists each Appendix A control (A1–A8), the file/line where it is enforced today, the test that asserts it, and its residual risk — so that future contributors can see the threat-model coverage at a glance, and so that F5's spec author has an explicit contract for the A6 (output-channel manipulation) requirements F5 must implement.

**Why this priority**: A1, A2 (workdir), A3, A8 are already mitigated by F2/F3 — F4 records the evidence rather than reimplementing. A6 (output manipulation) is F5's implementation territory but F4 must publish the requirement contract so F5 isn't free-form. P2 because the audit is documentation-heavy with no runtime delta beyond the `SpawnConfig` field additions noted below.

**Independent Test**: Read the spec's Threat-Model Audit table (rendered as part of this story). Verify every Appendix A control (A1–A8) has a row with `Mitigation`, `Owning Feature`, `Evidence (file:line)`, `Verification`, and `Residual Risk` columns populated. Verify the A6 row's "Mitigation" column links to the A6 contract subsection that enumerates the requirements F5 must implement.

**Acceptance Scenarios**:

1. **Given** the spec's Threat-Model Audit section (rendered as part of US6), **When** an operator reads it, **Then** every Appendix A control (A1, A2, A3, A4, A5, A6, A7, A8) has a row with the columns `Control`, `Mitigation`, `Owning Feature`, `Evidence`, `Verification`, `Residual Risk`.
2. **Given** the A1 (Container Escape) row, **When** read, **Then** the mitigation cites `cap-drop=ALL` and the non-root `march` user, the owning feature is F2, the evidence cites `src/spawn-config.ts` `SPAWN_CONFIG.capDrop` and `SPAWN_CONFIG.user` and `src/container-launch.ts` argv composition, and the verification cites `march spawn verify`'s A1 control check (US4) and the F2 acceptance scenarios for US5 (Launch).
3. **Given** the A2 (Volume Mount Misconfiguration) row, **When** read, **Then** the mitigation cites the snapshot-via-COPY model (F2) AND F4's Stage 4 bind-mount reject validator (US5), the residual risk explicitly notes the deferred Claude Max OAuth path.
4. **Given** the A3 (Env Var Leakage) row, **When** read, **Then** the mitigation cites F3's `SpawnBackend.requiredEnvVars` per-backend whitelist AND F3's auth pre-flight (US6 of F3), the evidence cites the F3 spec's FR-011 / FR-013 / FR-014, and the verification cites `march spawn verify`'s A3 control check (verifies the running container's env contains exactly the selected backend's `requiredEnvVars` plus the F4-injected `HTTP_PROXY` and `HTTPS_PROXY` proxy env vars per FR-006, with no other keys present).
5. **Given** the A4 (DNS / Network Information Leakage) row, **When** read, **Then** the mitigation cites US1's `--network=none` + proxy sidecar architecture, the verification cites `march spawn verify`'s A4 control check and the optional `--probe` flag.
6. **Given** the A5 (Snapshotted Context Contains Secrets) row, **When** read, **Then** the mitigation cites US3's expanded `SNAPSHOT_EXCLUSION_PATTERNS`, the residual risk notes that the list is non-exhaustive and Hatchery (M2) makes it per-profile-extensible.
7. **Given** the A6 (Output Manipulation) row, **When** read, **Then** the mitigation links to the A6 contract subsection (this story's deliverable) and identifies F5 (Spawn Output Extraction) as the implementation owner. The residual risk notes that F5's spec must reference this contract.
8. **Given** the A6 contract subsection, **When** read by F5's spec author, **Then** it enumerates: (a) treat all spawn output as untrusted input, (b) validate JSON structure before processing, (c) validate that git patches only touch files within the worktree (no path-escape), (d) apply patches to the worktree's branch only (never main, never directly to `repoPath`), (e) reject malformed JSON without crashing.
9. **Given** the A7 (LLM Credentials and Network Access) row, **When** read, **Then** the mitigation cites US1's per-backend egress restriction AND F3's per-backend `requiredEnvVars`, the verification cites `march spawn verify`'s A7 control check (combined with A4's network probe).
10. **Given** the A8 (Resource Exhaustion) row, **When** read, **Then** the mitigation cites the inherited `memoryLimit`, `cpuLimit`, `timeoutSeconds` AND the new `pidsLimit` (fork-bomb defense, F4 addition) AND `readOnlyRootfs` (persistence defense, F4 addition), the verification cites `march spawn verify`'s A8 control check.
11. **Given** the post-F4 `SpawnConfig`, **When** a developer reads its TypeScript declaration, **Then** the field set is exactly: `capDrop`, `user`, `networkMode`, `memoryLimit`, `cpuLimit`, `timeoutSeconds`, `pidsLimit`, `readOnlyRootfs` (8 fields). The post-F3 narrowed shape (6 fields) is the basis; F4 adds the 2 new fields. The post-F4 `networkMode` value is `"none"` (F4 mutation per FR-020), not `"bridge"`.
12. **Given** `pidsLimit` is added to `SpawnConfig`, **When** Stage 4 (Launch) composes the `docker run` argv, **Then** the `--pids-limit <value>` flag is emitted with the value sourced from `SPAWN_CONFIG.pidsLimit`. The numeric value is open in SD-004.
13. **Given** `readOnlyRootfs` is added to `SpawnConfig`, **When** Stage 4 composes the argv, **Then** the `--read-only` flag is emitted (no value) AND a `--tmpfs /tmp` flag is also emitted to provide a writable scratch path. Whether additional writable paths (e.g., `~/.claude/`) are needed for the backend CLIs is open in SD-002.

### Edge Cases

- The proxy sidecar fails to start (image unavailable, port collision, daemon error): dispatch fails before the spawn container launches; cleanup runs against the partial Stage-4 artifacts only (no spawn container exists yet); SpawnRecord is marked `failed` with the proxy error in the diagnostic message.
- The proxy sidecar crashes mid-spawn: the spawn loses outbound connectivity and observes connection-refused errors on subsequent backend API calls. The spawn's behavior depends on the backend CLI's error handling; F4 does NOT attempt to restart the proxy. The SpawnRecord captures the eventual exit code; verification (if requested) reports A4 as `pass` (still no egress) but the operator sees the broken-spawn outcome.
- The operator runs `march spawn verify` against a spawn on a host that has switched to a different Docker daemon between dispatch and verify: `docker inspect` fails; verify exits 2 with a clear "no such container on this daemon" message.
- A backend's allowed egress hostname resolves to multiple A records and the proxy sees the connection by IP: the proxy MUST evaluate the allowlist by the CONNECT request's hostname (the original SNI), not by the resolved IP. CONNECT-by-IP requests are rejected because they bypass the hostname check.
- A spawn dispatched by a future Hatchery (M2) profile that overrides `allowedEgressHosts`: out of F4 scope; M2 specifies how profile-driven overrides interact with the `SpawnBackend`-level allowlist (likely union or replace).
- A spawn under `readOnlyRootfs` whose backend CLI writes outside `/tmp` (e.g., Claude Code writing to `~/.claude/` for session state): the write fails. Whether F4 ships additional tmpfs mounts to cover this is open in SD-002. Failing-fast at backend startup is preferable to silent breakage.
- The bind-mount validator encounters `--tmpfs` (a legitimate tmpfs mount, not a bind mount): allowed per US5 AS6. The validator's allowlist of permitted flags is explicit in the contracts.
- A future contributor adds a third backend with `allowedEgressHosts` that overlaps another backend's set: the proxy is per-spawn and per-backend, so overlap is not a runtime concern. The contracts file documents that allowlist independence is per-backend, not per-host.
- A spawn that genuinely needs no network (e.g., a prompt that just generates code without API calls — hypothetical): the proxy sidecar still starts and sits idle. This is intentional — F4 does not optimize for zero-API-call spawns.
- The `--probe` flag is invoked against a spawn whose backend has consumed all its rate-limit quota and `1.1.1.1:443` happens to be reachable from the proxy's perspective via a NAT that strips the SNI: false-pass risk for A4. Documented as a residual-risk note in US4's contract; the probe is opt-in, not the primary verification mechanism.

## Dependency Order

Recommended implementation sequence:

| ID  | Title                                                              | Depends On  | Artifact |
|-----|--------------------------------------------------------------------|-------------|----------|
| US2 | Per-Backend Egress Allowlist on `SpawnBackend`                     | —           | —        |
| US3 | Expand Snapshot Exclusion Patterns                                 | —           | —        |
| US5 | Bind-Mount Reject Validator + Claude Max OAuth Deferral            | —           | —        |
| US6 | Threat-Model Audit + A6 Contract for F5                            | US2, US3, US5 | —      |
| US1 | Restrict Outbound Network Egress                                   | US2, US6    | —        |
| US4 | Operator Sandbox Verification CLI                                  | US1, US6    | —        |

## Requirements

### Functional Requirements

- **FR-001**: Each registered `SpawnBackend` MUST declare an `allowedEgressHosts: readonly string[]` field listing the exact hostnames (no wildcards) the backend's CLI requires for outbound HTTPS traffic. The Claude Code backend's value MUST be `["api.anthropic.com"]`. The Gemini backend's value MUST be set per SD-001's resolution.
- **FR-002**: The `SpawnBackend` interface MUST expand from F3's 4 members to 5 members by adding `allowedEgressHosts`. F4's spec explicitly supersedes F3's "interface stays at four members" decision (F3 FR-005, SC-005).
- **FR-003**: At Stage 4 (Launch) of the dispatch pipeline, the spawn container MUST be launched with `--network=none`. The container MUST NOT be joined to the default Docker `bridge` network or any other network with default-allow egress.
- **FR-004**: At Stage 4, a private user-defined Docker network MUST be created per spawn (e.g., `march-spawn-net-<spawn-id>`). The network MUST be created with `--internal` (or any equivalent driver option that forbids a default route to the host's external interfaces), so that containers attached only to this network have NO route to the public internet. The spawn container and the proxy sidecar container MUST both be joined to this private network. The spawn container's only outbound path MUST be the proxy sidecar.
- **FR-005**: At Stage 4, an HTTP CONNECT proxy sidecar container MUST be launched attached to the private spawn network at `docker run` time AND additionally attached to the default Docker `bridge` network via a follow-up `docker network connect bridge <proxy-container>` — the proxy is intentionally multi-homed (private network for spawn-side ingress, bridge for operator-side egress). The sidecar MUST be configured with the selected backend's `allowedEgressHosts` as its hostname allowlist. The sidecar MUST refuse CONNECT requests for hosts NOT on the allowlist AND MUST refuse CONNECT-by-IP requests (where no hostname is available for matching).
- **FR-006**: The spawn container MUST receive `HTTP_PROXY` and `HTTPS_PROXY` environment variables pointing to the proxy sidecar's Docker DNS name on the private spawn network (e.g., `http://march-spawn-proxy-<spawn-id>:8080`). The values MUST NOT be `127.0.0.1` / `localhost` — loopback addresses inside the spawn container resolve to the spawn container itself, not the sidecar (which is a separate container). The Docker DNS resolution happens automatically inside any user-defined network. (Pass-through form — value computed at launch time, not stored in `SpawnBackend.requiredEnvVars`.)
- **FR-007**: At spawn termination (success, failure, or timeout), the proxy sidecar container AND the private spawn network MUST be cleaned up. Cleanup follows F2's reverse-order cleanup chain: spawn container → proxy sidecar → private network → snapshot image → worktree → branch.
- **FR-008**: `SNAPSHOT_EXCLUSION_PATTERNS` MUST be expanded to include the F2 baseline plus the F4 additions: `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`, `*.p12`, `*.pfx`, `*.jks`, `.npmrc`, `.pypirc`, `.netrc`, `.aws/`, `.ssh/`, `.gnupg/`, `.docker/config.json`, `.kube/config`. The matching engine (`isExcludedPath` semantics — basename glob with `*`/`?`, directory-segment literal with trailing slash) MUST NOT change.
- **FR-009**: A new CLI verb `march spawn verify <spawn-id>` MUST be registered as a sibling of `march spawn dispatch`. It MUST emit a structured JSON report to stdout matching the canonical `SandboxVerificationReport` shape defined in `spawn-sandbox-security.data-model.md` Entity 4: a top-level object with `spawnId`, `containerId`, `verifiedAt`, `controls[]`, and `overall` fields, plus one `ControlReport` entry per Appendix A control (A1, A2, A3, A4, A5, A7, A8 — A6 omitted). Each `ControlReport` entry contains `control`, `name` (human-readable), `status` (`"pass"` | `"fail"` | `"n/a"`), `expected`, `observed`, and `mismatch` (required when `status === "fail"`, omitted otherwise). The data-model file is the canonical source of truth for field names, types, and optionality — this FR MUST NOT diverge from it. Exit codes: `0` (all pass), `1` (one or more fail), `2` (usage error).
- **FR-010**: `march spawn verify` MUST reject invocations against stopped spawns or against spawn-ids whose container has been removed, exiting with code 2 and a clear message in either case.
- **FR-011**: `march spawn verify` MUST accept an optional `--probe` flag that, when present, executes a CONNECT probe to `1.1.1.1:443` from inside the spawn container; the A4 control reports `pass` only if the probe fails to connect.
- **FR-012**: At Stage 4 (Launch), a bind-mount reject validator MUST inspect the composed `docker run` argv array. If the argv contains any `-v`, `--mount`, or `--volume` flag, OR any value matching the bind-mount pattern (`<host-path>:<container-path>` with a leading `/`), the launch MUST be rejected and the dispatch MUST exit with code 1, triggering F2's reverse-order cleanup.
- **FR-013**: `--tmpfs` MUST be explicitly whitelisted by the bind-mount validator. tmpfs mounts do NOT bind host filesystem paths and are safe under A2.
- **FR-014**: `SpawnConfig` MUST grow from F3's narrowed 6 fields to 8 fields by adding `pidsLimit: number` (kernel-pids ceiling for fork-bomb defense, A8) and `readOnlyRootfs: boolean` (rootfs is read-only, A1/A2).
- **FR-015**: When `SPAWN_CONFIG.readOnlyRootfs` is `true`, Stage 4 MUST emit `--read-only` to `docker run` AND emit `--tmpfs /tmp` (and any additional writable paths required by the backend CLIs as resolved by SD-002) to provide writable scratch space.
- **FR-016**: When `SPAWN_CONFIG.pidsLimit` is set, Stage 4 MUST emit `--pids-limit <value>` to `docker run`. The numeric value is set per SD-004's resolution; default if SD-004 is unresolved at implementation time is `512`.
- **FR-017**: The threat-model audit table (rendered in the spec under US6) MUST cover all 8 Appendix A controls (A1–A8) with the columns `Control`, `Mitigation`, `Owning Feature`, `Evidence`, `Verification`, `Residual Risk`. Each row MUST cite a specific evidence file:line OR a Specification Debt entry — empty cells are not permitted.
- **FR-018**: The A6 (Output Manipulation) requirement contract subsection MUST enumerate the mitigations F5 (Spawn Output Extraction) must implement: treat output as untrusted input, validate JSON structure before processing, validate patches touch only files within the worktree, apply patches only to the worktree's branch, reject malformed JSON without crashing.
- **FR-019**: F4 MUST NOT re-implement F3's auth pre-flight (per-backend `requiredEnvVars` presence verification). The audit table cites F3 as the owning feature for that mitigation. F4's modifications to `src/container-launch.ts` MAY incidentally remove the stale F4-claim comment but MUST NOT introduce a duplicate pre-flight check.
- **FR-020**: `SPAWN_CONFIG.networkMode` MUST be mutated from `"bridge"` (F2/F3 value) to `"none"` (F4 value) as part of the same change set that adds `pidsLimit` and `readOnlyRootfs` (US6's `SpawnConfig` extension). The mutation is a precondition for US1's proxy sidecar architecture (FR-003) — the spawn container's `--network=none` flag at `docker run` time MUST be sourced from this constant.

### Key Entities

- **`SpawnBackend` (5-member, supersedes F3's 4-member shape)**: First-class registry entity defined by F3, extended by F4 with `allowedEgressHosts: readonly string[]`. The egress allowlist is intrinsic to the backend identity (Claude needs `api.anthropic.com`; Gemini needs Google API hosts) and is consumed by US1's proxy sidecar at Stage 4.
- **`SpawnConfig` (8-field, supersedes F3's 6-field shape)**: F3's narrowed compile-time security/resource constant, extended by F4 with `pidsLimit: number` (A8) and `readOnlyRootfs: boolean` (A1/A2). Hatchery (M2) replaces this constant with declarative per-profile configuration; the F4 extensions seed M2's profile schema.
- **Spawn Network Topology**: A per-spawn private user-defined Docker network plus a proxy sidecar container, created at Stage 4 and torn down at spawn termination. The spawn container runs `--network=none` and routes outbound traffic via `HTTP_PROXY` / `HTTPS_PROXY` env vars to the sidecar.
- **`SandboxVerificationReport` (transient stdout payload)**: The structured JSON report emitted by `march spawn verify`. Per-control entries with `status`/`expected`/`observed`. Not persisted to disk in F4 — purely stdout for operator/CI consumption.
- **Threat-Model Audit Table (spec artifact)**: A 6-column table (Control, Mitigation, Owning Feature, Evidence, Verification, Residual Risk) covering A1–A8. Lives in this spec as part of US6's deliverable. Authoritative documentation of how each Appendix A control is enforced.
- **A6 Requirement Contract (spec artifact)**: A bulleted contract subsection inside US6 enumerating the A6 mitigations F5 (Spawn Output Extraction) must implement. F4 publishes; F5 consumes.

## Assumptions

- F3 (Multi-Backend Execution Interface) lands before F4 implementation begins. The current `src/spawn-config.ts` carries `envWhitelist` because F3's PR has not merged on this branch — that's expected.
- Cloud APIs (Anthropic, Google) will continue to use rotating CDN IPs. Hostname-based allowlisting at the proxy layer is the durable solution; IP-pinning is rejected.
- The HTTP CONNECT proxy is a viable upstream choice — both Claude Code CLI and Gemini CLI honor `HTTP_PROXY` / `HTTPS_PROXY` environment variables for outbound traffic. (To be verified during render/cut; if either backend bypasses the proxy via a direct TCP path, US1's mechanism may need adjustment.)
- Resource ceilings inherited from F2 (`memoryLimit: "4g"`, `cpuLimit: "2"`, `timeoutSeconds: 3600`) are correct for typical Claude Code and Gemini sessions and remain unchanged in F4. Per-backend or per-profile sizing is Hatchery's (M2) job.
- The bind-mount validator's flag list (`-v`, `--mount`, `--volume` reject; `--tmpfs` allow) is exhaustive against current Docker. New Docker flags require explicit handling.
- Verify operates on running containers only. The dispatch pipeline does NOT create the proxy sidecar / network on a verify-only run; verify never dispatches a spawn.

## Specification Debt

| ID     | Description | Source Category | Impact | Confidence | Status | Resolution |
|--------|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Gemini backend `allowedEgressHosts` hostname set is not pinned to a specific FQDN in the RFC. RFC line 235 says only "Gemini API endpoints" (plural, no host). Gemini CLI may also need Google auth/discovery hosts (e.g., `oauth2.googleapis.com`). Current best inference: `["generativelanguage.googleapis.com"]`. Verification needed against actual Gemini CLI behavior at render/cut time. | Integration | High | Low | resolved | **2026-05-16**: Moot — Gemini was cut from the supported-backends list (see [Accelerated context](#accelerated-context-2026-05-16)). The same shape of question now applies to Codex; tracked as [SD-008](#specification-debt-2026-05-16-additions). |
| SD-002 | `readOnlyRootfs` interaction with the backend CLIs is unverified. Claude Code may write to `~/.claude/` for session state, plugin sync, and CLAUDE.md discovery (RFC Appendix C); Gemini CLI may write to `~/.gemini/` similarly. With `readOnlyRootfs: true`, those writes fail unless additional tmpfs mounts are declared. The spec's tmpfs `/tmp` may not be sufficient. Resolution requires running the backends under `--read-only` and observing the failures. | Edge Cases | High | Medium | open | — |
| SD-003 | Proxy-sidecar lifecycle ownership is unspecified at the contract level. Open questions: (a) which Stage 4 sub-step creates the proxy and the private network? (b) what is the cleanup ordering when the proxy fails to start vs. when the spawn container fails to start? (c) how are the proxy's logs surfaced for diagnostics? The reconciled plan specifies the topology but not the lifecycle. To be resolved at render. | Functional Scope | High | Low | open | — |
| SD-004 | `pidsLimit` numeric ceiling is not specified. A typical Claude Code spawn has Node + backend CLI + git + a few subprocesses (~10–50 pids steady state). LSP / plugin workers may push it higher. Inference: `512` is a safe default that leaves room for legitimate fan-out without permitting fork-bomb DoS. Final value pending measurement of actual Claude Code and Gemini subprocess fan-out. | Non-Functional Quality | Medium | Medium | open | — |
| SD-005 | Allowlist semantics for wildcard / subdomain matching are unspecified. If Anthropic ever serves from `api-eu.anthropic.com` or similar, does the proxy match exact-host-only or suffix? This affects the `SpawnBackend.allowedEgressHosts` contract (string[] vs glob[] vs structured rule[]) and the proxy implementation. Inference: exact-host-only initially (tightest posture). Relaxation deferred to actual API behavior observation. | Domain & Data Model | Medium | Medium | open | — |
| SD-006 | SC-009 hardcodes a single `tmpfs` mount entry for `/tmp`, and the data-model A2 expected shape pins `mountCount: 1`. SD-002 explicitly leaves room for additional tmpfs mounts (e.g., `~/.claude/`, `~/.gemini/`) if the backend CLIs require writable home paths under `readOnlyRootfs`. If SD-002 resolves with additional tmpfs mounts, SC-009 and the data-model A2 expected shape need to grow correspondingly. Tracked separately so SD-002's resolution explicitly closes both. | plan-review:Internal contradiction | Important | Low | open | — |
| SD-007 | A7 verification source is unspecified. Data-model Entity 4 A7 `observed` says "read from the proxy sidecar's runtime configuration" but no contract specifies the surface. Candidates: (a) `docker inspect <proxy>` and parse `ALLOWLIST` env var; (b) a structured proxy-image-specific health endpoint; (c) re-derive from `selectedBackend.allowedEgressHosts` without reading the running proxy. Resolution depends on proxy image choice (SD-003). To be resolved at render. | plan-review:Logical gap | Important | Low | open | — |

### Specification Debt — 2026-05-16 additions

These items track gaps introduced by the post-drafting backend change (see [Accelerated context](#accelerated-context-2026-05-16)).

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-008 | Codex backend `allowedEgressHosts` hostname set is not pinned. Replaces SD-001 (which was Gemini-specific and is now moot). The Codex CLI reaches OpenAI's API and may also need auth/discovery hosts. Current best inference at the time of this amendment is unverified — needs measurement against the actual Codex CLI traffic during F4 render/cut. Recorded as `["chatgpt.com"]` placeholder; verify and revise. | Integration | High | Low | open | — |
| SD-009 | US5's bind-mount reject validator (FR-012) must admit a typed exception for backend-declared credential mounts (Codex's `/march/codex-auth → CODEX_HOME` read-only mount). Open questions: (a) how does the validator obtain the allowed-source list — read `selectedBackend.credentialMount?.hostSource` directly, or accept a separately-passed allow-set? (b) is the in-container target path also constrained (e.g., must live under `/march/`)? (c) what error message does the validator emit when a `-v` is present that does NOT match the declared credential mount? Recommended lean: read `selectedBackend.credentialMount` directly; constrain target to start with `/march/`; error names the offending flag and notes that only the selected backend's declared credential mount is permitted. Resolution required before F4 implementation begins, or F4 silently blocks every Codex spawn. | clarify:Functional Scope | Critical | Medium | open | — |
| SD-010 | A2 threat-model row in the US6 audit table needs to acknowledge Codex's credential-mount as a typed exception with a documented residual risk: the host's `CODEX_HOME` directory is exposed read-only to the spawn container, so any secrets co-located in `CODEX_HOME` beyond Codex's own auth tokens will be visible to the LLM. Recommended lean: add a residual-risk bullet to the A2 row stating "Codex credential mount exposes the entirety of `CODEX_HOME` read-only; operators must not store unrelated secrets there" and an operator-facing note in the Hatchery `codex` profile (when added per the Hatchery F1 spec's [SD-018](../2026-05-12-003-profile-schema-and-validation-library/profile-schema-and-validation-library.spec.md)). | clarify:Constraints | High | Medium | open | — |
| SD-011 | The `SpawnBackend` interface member count: F4's US2/FR-002/SC-007 assert "exactly five members" (adds `allowedEgressHosts` to F3's four). The amended multi-backend spec adds an optional `credentialMount?: BackendCredentialMountSpec` as a sixth member. F4's assertions should be relaxed to "at least the five required members" or defer to the multi-backend spec for the canonical declaration. Recommended lean: defer — F4 owns `allowedEgressHosts` semantically, the multi-backend spec owns the full interface shape. | plan-review:Assumption-output drift | Important | Low | open | — |

## Out of Scope

- **Hatchery-managed declarative security profiles** (Milestone 2). F4 ships the hardcoded post-F4 `SpawnConfig` and per-backend `allowedEgressHosts` constants. M2 makes them per-profile-editable.
- **Secondary isolation layers** (gVisor, rootless Docker, Kata Containers, Firecracker). The threat model does not currently demand them; F4 relies on Docker's namespace isolation as enforced by `cap-drop=ALL`, non-root user, `--network=none`, `--read-only`, and the resource limits. Document as future-option in the residual-risk column for A1.
- **Claude Max OAuth bind-mount of `~/.claude/`**. F3 deferred this to F4; F4 explicitly defers it to post-M1. The bind-mount validator (US5) structurally enforces this deferral. Reopening requires a new feature with its own A2 threat-model review.
- **Auth pre-flight check** (per-backend `requiredEnvVars` presence). Owned by F3 (US6). F4 references it in the audit table but does not duplicate it.
- **Output validation, patch parsing, JSON sanitization** — owned by F5 (Spawn Output Extraction) per the feature map. F4 publishes the A6 contract requirements; F5 implements.
- **Worktree, container, image, branch cleanup after merge** — owned by Brood (Milestone 3).
- **Verifying stopped or terminated spawns**. `march spawn verify` works on running containers only. Forensic post-mortem of completed spawns is out of F4 scope.
- **Host-side proxy daemon** (a single shared proxy across all spawns on the host). RFC Appendix A7 lists this as a future option; F4 chooses per-spawn proxy sidecars for simpler isolation. Document as future-option in residual-risk for A4/A7.
- **Secret-pattern scanning** of the snapshot beyond pattern-list exclusion. RFC Appendix A5 mentions "scanning the snapshot for known secret patterns"; F4 ships pattern-list expansion only. Entropy-based or signature-based scanning is a future capability.
- **Operator-configurable exclusion patterns**. Configurability is Hatchery's (M2) job. F4 ships the expanded hardcoded list.
- **Verify report persistence**. The verify CLI emits stdout JSON; it does not write a file or update the SpawnRecord. Persistence is operator-driven (`march spawn verify <id> > report.json`).
- **CI-gating verification command** (`march spawn audit-config` or similar that statically inspects `SPAWN_CONFIG` + registered backends without running a spawn). F4 ships the per-spawn `verify` command; static config audit is a Hatchery-era feature.
- **Backend CLIs that bypass HTTP_PROXY / HTTPS_PROXY**. F4 assumes both validated backends honor these env vars. If render/cut discovers a bypass, US1's mechanism is revisited (likely with a CONNECT-style transparent proxy at the network layer).

## Success Criteria

### Measurable Outcomes

- **SC-001**: `docker inspect <spawn-container>` for any F4-dispatched spawn reports `NetworkMode: "none"` AND no `Mounts` entry of type `bind`. The container is joined to a private user-defined Docker network whose only other member is the proxy sidecar.
- **SC-002**: `docker exec <spawn-container> curl https://example.com` (or any non-allowlisted host) fails with a connection error. `docker exec <spawn-container> curl https://api.anthropic.com` (or the selected backend's allowlisted host) succeeds (modulo backend auth).
- **SC-003**: `march spawn verify <spawn-id>` against a healthy F4 spawn exits 0 and reports `pass` for A1, A2, A3, A4, A5, A7, A8.
- **SC-004**: `march spawn verify <spawn-id> --probe` against a healthy F4 spawn reports A4 as `pass` (the probe to `1.1.1.1:443` fails to connect).
- **SC-005**: A test fixture worktree containing a tracked file at each new exclusion pattern (`.ssh/id_rsa`, `subdir/keystore.p12`, `.aws/credentials`, etc.) snapshots into a build context that contains none of those files, verifiable by listing the build-context directory.
- **SC-006**: A modified `launchSpawnContainer` that injects `-v /tmp:/tmp` into the argv causes dispatch to fail at Stage 4 with a clear "bind mount rejected" error; no container is created; the worktree, image, and branch are cleaned up.
- **SC-007**: The `SpawnBackend` interface declaration in code contains exactly five members. The Claude Code backend's `allowedEgressHosts` is `["api.anthropic.com"]`. The Gemini backend's value matches SD-001's resolution.
- **SC-008**: The post-F4 `SpawnConfig` declaration contains exactly eight fields: `capDrop`, `user`, `networkMode`, `memoryLimit`, `cpuLimit`, `timeoutSeconds`, `pidsLimit`, `readOnlyRootfs`. `envWhitelist` is absent (removed by F3).
- **SC-009**: `docker inspect <spawn-container>` reports `HostConfig.PidsLimit: 512` (or SD-004's resolved value) AND `HostConfig.ReadonlyRootfs: true` AND a `Mounts` entry of type `tmpfs` for `/tmp`.
- **SC-010**: The threat-model audit table in this spec covers all 8 Appendix A controls (A1–A8) with every cell populated to a file:line evidence pointer or a Specification Debt entry. No empty cells.
- **SC-011**: F2's existing acceptance scenarios (US1–US7 in `spawn-dispatch.spec.md`) and F3's acceptance scenarios (US1–US7 in `multi-backend-execution-interface.spec.md`) continue to hold under post-F4 code, modulo:
  - Network-related scenarios update to assert `--network=none` + proxy sidecar instead of `bridge`.
  - The bind-mount validator does not introduce false positives against any normal F2/F3 dispatch.
  - The `SpawnBackend` interface assertions update to expect 5 members, not 4.
  - The `SpawnConfig` field-set assertions update to expect 8 fields, not 6.
- **SC-012**: The proxy sidecar and the private spawn network are both removed when the spawn container exits (verifiable via `docker network ls` and `docker ps -a` showing no `march-spawn-net-<id>` network and no proxy sidecar container post-cleanup).
