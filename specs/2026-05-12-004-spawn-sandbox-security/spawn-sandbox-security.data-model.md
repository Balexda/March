# Data Model: Spawn Sandbox Security

## Overview

This model captures the data shapes F4 introduces or extends to enforce the RFC's Appendix A threat model: an extended `SpawnBackend` interface (5 members), an extended `SpawnConfig` constant (8 fields), the per-spawn network topology (private Docker network + proxy sidecar) created at Stage 4, and the structured verification report emitted by `march spawn verify`. Most F4 changes are additive extensions to F2/F3 entities — the sole new persistent-style entity is the verification report, which is a transient stdout payload, not an on-disk artifact.

## Entities

### 1) SpawnBackend (extended — 5 members, supersedes F3's 4-member shape)

Purpose: First-class registry entity defined by F3. F4 extends it with `allowedEgressHosts` so the per-backend network egress allowlist is sourced from the same single source of truth as the backend's base image, env vars, and entrypoint argv. Promoting the allowlist onto `SpawnBackend` keeps the post-F3 architecture's "every per-backend concern lives on the backend" principle intact and avoids re-introducing the cross-backend leakage F3 just removed.

| Field/Method | Type | Required | Notes |
|--------------|------|----------|-------|
| `name` | string | Yes | Registry key. Inherited from F3 unchanged. |
| `baseImage` | string | Yes | Docker image tag with the backend CLI pre-installed. Inherited from F3 unchanged. |
| `requiredEnvVars` | `readonly string[]` | Yes | Environment variable names the backend requires. Inherited from F3 unchanged. |
| `buildEntrypoint` | `(promptFilePath: string) => readonly string[]` | Yes | Container entrypoint argv builder. Inherited from F3 unchanged. |
| `allowedEgressHosts` | `readonly string[]` | Yes | **NEW in F4.** Exact hostnames the backend's CLI requires for outbound HTTPS traffic. No wildcards in F4 — see SD-005. Consumed by US1's proxy sidecar at Stage 4 as the CONNECT-time hostname allowlist. |

Validation rules:
- `allowedEgressHosts` must be a non-empty array of strings — every backend in M1 (Claude Code, Gemini) requires at least one outbound host to function.
- Each element must be a syntactically valid hostname (RFC-952/1123 labels separated by dots; no scheme, no port, no path).
- Element matching is case-insensitive at the proxy layer (DNS hostnames are case-insensitive).
- Duplicates within a single backend's array are permitted but redundant. Cross-backend overlaps are unrestricted (the proxy is per-spawn / per-backend; no global uniqueness constraint).

#### Concrete F4 Implementations

**`claudeCodeBackend`** (extension to F3's implementation):

| Member | Value |
|--------|-------|
| `name` | `"claude-code"` |
| `baseImage` | `"march-base:latest"` |
| `requiredEnvVars` | `["ANTHROPIC_API_KEY"]` |
| `buildEntrypoint(p)` | `["sh", "-c", \`claude -p "$(cat ${p})" --output-format json --dangerously-skip-permissions --bare --no-session-persistence\`]` |
| `allowedEgressHosts` | `["api.anthropic.com"]` |

**`geminiBackend`** (extension to F3's implementation):

| Member | Value |
|--------|-------|
| `name` | `"gemini"` |
| `baseImage` | `"march-gemini-base:latest"` |
| `requiredEnvVars` | `["GEMINI_API_KEY"]` |
| `buildEntrypoint(p)` | `["sh", "-c", \`gemini --prompt "$(cat ${p})" --approval-mode=yolo --output-format json\`]` |
| `allowedEgressHosts` | `["generativelanguage.googleapis.com"]` (best inference per SD-001 — pending render/cut verification of Gemini CLI's actual outbound footprint) |

Note: F4's spec explicitly supersedes F3's "interface stays at four members" decision (F3 FR-005, F3 SC-005, plus `multi-backend-execution-interface.spec.md` Assumptions — the bullet beginning "The `SpawnBackend` interface promoted in F3 is the canonical dispatch contract going forward"). The supersession is documented in F4's Clarifications session 2026-05-12 and surfaced in F4's FR-002.

---

### 2) SpawnConfig (extended — 8 fields, supersedes F3's 6-field shape)

Purpose: F3's narrowed compile-time security/resource constant, extended by F4 with two new fields that close the remaining A1/A2/A8 hardening gaps. `pidsLimit` defends against fork-bomb DoS (A8); `readOnlyRootfs` prevents in-container persistence and tampering with the rootfs (A1, A2). Hatchery (M2) replaces this constant with declarative per-profile configuration; the F4 extensions seed M2's profile schema with the broader posture.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `capDrop` | `readonly string[]` | Yes | Linux capabilities to drop. Inherited from F2 unchanged. Value: `["ALL"]`. |
| `user` | string | Yes | Non-root user identifier. Inherited from F2 unchanged. Value: `"march"`. |
| `networkMode` | string | Yes | Docker network mode. **F4 changes the value from `"bridge"` to `"none"`.** The runtime network connectivity is provided by the per-spawn private user-defined Docker network (Entity 3) plus the proxy sidecar (Entity 4), not by the container's `--network` flag. |
| `memoryLimit` | string | Yes | Container memory limit. Inherited from F2 unchanged. Value: `"4g"`. |
| `cpuLimit` | string | Yes | Container CPU limit. Inherited from F2 unchanged. Value: `"2"`. |
| `timeoutSeconds` | number | Yes | Maximum execution time before the container is killed. Inherited from F2 unchanged. Value: `3600`. |
| `pidsLimit` | number | Yes | **NEW in F4.** Maximum number of kernel pids the spawn container may create. Defends against fork-bomb DoS (A8). Default value: `512` (per SD-004; pending measurement-driven refinement). Stage 4 emits `--pids-limit <value>` to `docker run`. |
| `readOnlyRootfs` | boolean | Yes | **NEW in F4.** When `true`, the container's rootfs is mounted read-only. Stage 4 emits `--read-only` to `docker run` AND emits `--tmpfs /tmp` to provide writable scratch. Additional writable tmpfs mounts may be required by the backend CLIs (e.g., `~/.claude/`); resolution is open in SD-002. Default value: `true`. |

Validation rules:
- `capDrop` must contain `"ALL"` (inherited from F2 — A1 mitigation).
- `networkMode` must be `"none"` (F4 mutation — A4 mitigation; runtime connectivity comes from the proxy sidecar, not the container's network).
- `memoryLimit` must match Docker's memory format (e.g., `"4g"`, `"512m"`).
- `cpuLimit` must be a positive number formatted as a string.
- `timeoutSeconds` must be a positive integer.
- `pidsLimit` must be a positive integer ≥ 64 (below this the spawn cannot reasonably start).
- `readOnlyRootfs` must be a boolean.

Note: `envWhitelist` is **absent** — removed by F3 (F3 FR-012, F3 SC-007). Per-backend env vars live on `SpawnBackend.requiredEnvVars`. F4 does not reintroduce this field.

---

### 3) Spawn Network Topology (per-spawn ephemeral)

Purpose: The runtime network configuration F4 creates per spawn at Stage 4, replacing F2's `bridge` default. Consists of a private user-defined Docker network plus a proxy sidecar container. Both are owned by the dispatch action and are torn down when the spawn container exits.

| Component | Type | Required | Notes |
|-----------|------|----------|-------|
| Private spawn network | Docker user-defined network | Yes | Named `march-spawn-net-<spawn-id>`. Created with `--internal` so the network has NO route to the public internet — the spawn container, attached only here, cannot reach the outside world directly. The spawn container and the proxy sidecar are the only members. The spawn container has no other network attachment; the proxy sidecar is additionally attached to the default Docker bridge for outbound egress (the only multi-homed component in the topology). |
| Proxy sidecar container | Docker container | Yes | Named `march-spawn-proxy-<spawn-id>`. Joined to BOTH the private spawn network AND a default-bridge network for outbound access. Configured with the selected backend's `allowedEgressHosts` as its CONNECT-time hostname allowlist. Image is implementation detail — see SD-003. |
| Spawn container's proxy env vars | Docker env vars | Yes | `HTTP_PROXY` and `HTTPS_PROXY` set at launch time to the proxy sidecar's URL on the private spawn network — Docker DNS name (e.g., `http://march-spawn-proxy-<spawn-id>:8080`), NOT `127.0.0.1` / loopback (which would resolve to the spawn container itself). Computed values, not stored in `SpawnBackend.requiredEnvVars`. |

Lifecycle:

1. `absent` → `created`
   - Trigger: Stage 4 (Launch) begins.
   - Effects: The private spawn network is created via `docker network create --internal march-spawn-net-<spawn-id>`. The proxy sidecar container is launched on this network with its allowlist configured AND additionally attached to the default Docker bridge via `docker network connect bridge <proxy-container>` so the proxy can reach the operator's network for outbound CONNECT. The spawn container is launched with `--network=none`, then attached to the private spawn network via `docker network connect`. The spawn container receives `HTTP_PROXY` / `HTTPS_PROXY` env vars pointing to the sidecar's Docker DNS name on the private network (e.g., `http://march-spawn-proxy-<spawn-id>:8080`) — never `127.0.0.1` / loopback.

2. `created` → `removed`
   - Trigger: Spawn container exits (success, failure, or timeout) — Stage 6 (Wait) returns.
   - Effects: The proxy sidecar container is stopped and removed. The private spawn network is removed. Both teardown steps run unconditionally as part of F2's reverse-order cleanup chain. Cleanup ordering (reverse of creation): spawn container → proxy sidecar → private spawn network → snapshot image → worktree → branch.

3. `created` → `failed-startup`
   - Trigger: Either the proxy sidecar fails to start OR the spawn container fails to attach to the private spawn network.
   - Effects: Cleanup runs against whichever components were created. Dispatch fails with `ERROR` (1) and the SpawnRecord captures the failure cause.

Note: The Spawn Network Topology is not persisted as a separate entity — it is a runtime composition of Docker primitives. Documenting it here makes the relationships and lifecycle inspectable for the F4 audit story (US6) and for `march spawn verify` (US4).

---

### 4) SandboxVerificationReport (transient stdout payload)

Purpose: The structured JSON report emitted by `march spawn verify <spawn-id>`. Per-control entries with observed/expected values. Transient by design — F4 does NOT persist this to disk. Operators or CI may redirect stdout to a file (`march spawn verify <id> > report.json`) but the persistence contract is operator-driven.

#### Top-level shape

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `spawnId` | string | Yes | The SpawnId verified, mirrored from the SpawnRecord. |
| `containerId` | string | Yes | The Docker container ID inspected, mirrored from the SpawnRecord. |
| `verifiedAt` | string | Yes | ISO 8601 timestamp of when verification ran. |
| `controls` | array of ControlReport | Yes | One entry per Appendix A control checked. Order is A1, A2, A3, A4, A5, A7, A8. A6 is omitted because F4 does not implement A6 (F5 does). |
| `overall` | string | Yes | `"pass"` if every entry in `controls` is `"pass"` or `"n/a"`; `"fail"` if any entry is `"fail"`. |

#### `ControlReport` shape

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `control` | string | Yes | The Appendix A control identifier: `"A1"`, `"A2"`, `"A3"`, `"A4"`, `"A5"`, `"A7"`, `"A8"`. |
| `name` | string | Yes | Human-readable control name (e.g., `"Container Escape"`). |
| `status` | string | Yes | One of `"pass"`, `"fail"`, `"n/a"`. `"n/a"` is reserved for controls that cannot be verified at runtime (currently none in F4 — every checked control has an observable signal). |
| `expected` | object | Yes | The control's expected configuration as derived from `SpawnConfig` and the selected backend. Shape varies per control (see below). |
| `observed` | object | Yes | The actual configuration read from `docker inspect`. Same shape as `expected`. |
| `mismatch` | string | Conditional | Required when `status === "fail"`. Human-readable description of the diff. Omitted when `status === "pass"` or `"n/a"`. |

Per-control `expected`/`observed` shapes (informal):

| Control | Shape |
|---------|-------|
| A1 (Container Escape) | `{ capDrop: string[], user: string }` |
| A2 (Volume Mount) | `{ mountCount: number, mountTypes: string[] }` — expected: `{ mountCount: 1, mountTypes: ["tmpfs"] }` (the `/tmp` tmpfs); fail if any `bind` mount is observed. |
| A3 (Env Leakage) | `{ env: string[] }` — expected: exactly the selected backend's `requiredEnvVars` plus the proxy env vars (`HTTP_PROXY`, `HTTPS_PROXY`); fail if any extra env keys are present. |
| A4 (DNS / Network) | `{ networkMode: string, attachedNetworks: string[], probeBlocked?: boolean }` — `probeBlocked` populated only when `--probe` was passed. |
| A5 (Snapshot Secrets) | `{ exclusionPatternsVersion: string }` — pass if the running container's snapshot image carries an `org.opencontainers.image.labels.io.march.snapshot.exclusion-patterns-version` label (or the equivalent `LABEL` in the generated Dockerfile, key `io.march.snapshot.exclusion-patterns-version`) whose value matches the post-F4 patterns version constant (e.g., `"f4-2026-05-12"`). The label is set by `writeSpawnDockerfile` at Stage 3 (Snapshot) — `LABEL io.march.snapshot.exclusion-patterns-version="f4-2026-05-12"` — and is the only signal verify can read at runtime to confirm which exclusion list shipped into the snapshot. Limited verification — primary assertion remains on the snapshot test fixtures (US3 acceptance scenarios), not the running container. |
| A7 (Egress Hosts) | `{ allowedEgressHosts: string[] }` — expected: the selected backend's `allowedEgressHosts`; observed: read from the proxy sidecar's runtime configuration. |
| A8 (Resource Exhaustion) | `{ memoryBytes: number, nanoCpus: number, pidsLimit: number, readOnlyRootfs: boolean }` |

---

### 5) SnapshotExclusionPattern (formalized)

Purpose: The pattern entries that compose `SNAPSHOT_EXCLUSION_PATTERNS` in `src/snapshot.ts`. Already exists as an array literal in F2; F4 promotes the per-pattern rationale to documentation by enumerating each new pattern's threat (A5 sub-vector).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `pattern` | string | Yes | Either a basename glob (`*` and `?` wildcards, no `/`) matched against the path's final segment at any depth, OR a directory-segment literal with trailing `/` matched against any interior segment. Engine semantics: the existing `isExcludedPath` in `src/snapshot.ts`. |
| `category` | string | (documentation) | The credential category the pattern targets (e.g., `"SSH key"`, `"PKCS12 keystore"`, `"npm auth token"`). For audit traceability; not present in the runtime array. |

#### F4 expansion (new patterns added to the F2 baseline)

| Pattern | Category |
|---------|----------|
| `id_rsa` | SSH private key (RSA, default name) |
| `id_ed25519` | SSH private key (Ed25519, default name) |
| `id_ecdsa` | SSH private key (ECDSA, default name) |
| `id_dsa` | SSH private key (DSA, legacy default name) |
| `*.p12` | PKCS12 keystore (Java, browser, certificate bundles) |
| `*.pfx` | PKCS12 keystore (Microsoft naming variant) |
| `*.jks` | Java KeyStore (legacy, may contain private keys) |
| `.npmrc` | npm registry auth (`_auth`, `_authToken`) |
| `.pypirc` | PyPI / TestPyPI upload credentials |
| `.netrc` | Generic HTTP/FTP credentials store |
| `.aws/` | AWS CLI credentials and config (directory) |
| `.ssh/` | SSH config and keys (directory — catches everything in `~/.ssh/`) |
| `.gnupg/` | GnuPG keyring directory |
| `.docker/config.json` | Docker registry auth credentials |
| `.kube/config` | Kubernetes cluster credentials |

The F2 baseline patterns (`.env`, `.env.*`, `*.pem`, `*.key`, `.secrets/`, `credentials.json`) remain unchanged. Total post-F4 pattern count: 21.

## Relationships

- **`SpawnBackend.allowedEgressHosts` is consumed by the Spawn Network Topology's proxy sidecar configuration** at Stage 4 (Launch). One backend → one allowlist → one proxy sidecar instance per spawn.
- **`SpawnConfig.networkMode = "none"` and the Spawn Network Topology are coupled.** With `networkMode = "none"`, the spawn container has no default network access; the private spawn network + proxy sidecar provides the only egress path. Changing `networkMode` away from `"none"` would invalidate the topology.
- **`SpawnConfig.readOnlyRootfs` and tmpfs mounts are coupled.** When `readOnlyRootfs = true`, at minimum a `--tmpfs /tmp` mount is required so the spawn has writable scratch space. Additional tmpfs mounts may be required per SD-002.
- **The Bind-Mount Reject Validator (US5) operates on the composed `docker run` argv** before container creation. It does not interact with persisted entities; it inspects the in-flight argv array.
- **`SandboxVerificationReport` reads from the SpawnRecord (F2) to resolve the spawn-id → container-id mapping.** It does not modify the SpawnRecord. It reads from `docker inspect` output to populate `observed` fields.
- **The Threat-Model Audit Table (spec artifact in US6) cross-references all of the above** as the audit story's primary deliverable. It is documentation, not a runtime entity.

## State Transitions

### Spawn Network Topology lifecycle (per-spawn)

1. `absent` → `created`
   - Trigger: Stage 4 (Launch) begins.
   - Effects: Private network created; proxy sidecar launched on it with the backend's allowlist; spawn container launched with `--network=none` and attached to the private network; spawn container's env populated with proxy URLs.

2. `created` → `removed`
   - Trigger: Spawn container exits.
   - Effects: Proxy sidecar stopped and removed; private network removed.

3. `created` → `partial-rollback`
   - Trigger: Stage 4 fails after some topology components were created (e.g., proxy started but spawn container failed to attach).
   - Effects: F2's reverse-order cleanup runs against whichever components exist. The dispatch action does not leave dangling proxy containers or networks.

### `SpawnConfig` schema lifecycle (across milestones)

| Milestone | `SpawnConfig` shape |
|-----------|---------------------|
| F2 (post-F2)  | 7 fields: `capDrop`, `user`, `networkMode = "bridge"`, `memoryLimit`, `cpuLimit`, `timeoutSeconds`, `envWhitelist` |
| F3 (post-F3)  | 6 fields: drops `envWhitelist` (moved to `SpawnBackend.requiredEnvVars`) |
| F4 (post-F4)  | 8 fields: F3's 6 plus `pidsLimit` and `readOnlyRootfs`; `networkMode` value mutates from `"bridge"` to `"none"` |
| M2 (Hatchery) | Replaced by declarative per-profile configuration; F4's `SpawnConfig` becomes the seed for the first opinionated profile |

### `SpawnBackend` schema lifecycle (across milestones)

| Milestone | `SpawnBackend` member count |
|-----------|------------------------------|
| F2 (post-F2)  | 4 (interface stub: `name`, `baseImage`, `buildEntrypoint`, `requiredEnvVars`) |
| F3 (post-F3)  | 4 (interface formalized at exactly 4 members; F3 explicitly closes additions) |
| F4 (post-F4)  | 5 (F4 supersedes F3's "closed at 4" decision and adds `allowedEgressHosts`) |
| M2 (Hatchery) | Hatchery profiles may layer additional per-profile fields (e.g., `additionalAllowedHosts`); the interface itself remains the canonical contract |

## Identity & Uniqueness

- **`SpawnBackend` instances are uniquely identified by `name`** (inherited from F3). F4 does not change this — F4 only extends the per-instance shape.
- **`SpawnConfig` is a singleton compile-time constant** in F4 (per F2/F3). Hatchery (M2) introduces multiple instances keyed by profile name.
- **The Spawn Network Topology is uniquely identified per spawn** by the SpawnId. The private network's name is `march-spawn-net-<spawn-id>`; the proxy sidecar's name is `march-spawn-proxy-<spawn-id>`. Both are derived from the same SpawnId that names the spawn container and worktree.
- **`SandboxVerificationReport` instances are not persisted** — they exist only as the stdout payload of one `march spawn verify` invocation. No identity scheme is required.
- **`SnapshotExclusionPattern` entries are deduplicated by string equality** within `SNAPSHOT_EXCLUSION_PATTERNS`. The compile/match logic in `isExcludedPath` is short-circuit: a path that matches any pattern is excluded; ordering does not affect the result.
