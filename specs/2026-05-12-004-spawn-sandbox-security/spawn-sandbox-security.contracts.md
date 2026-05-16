# Contracts: Spawn Sandbox Security

## Overview

This document defines the interface contracts F4 introduces or modifies: the extended `SpawnBackend` interface (5 members, supersedes F3's 4-member shape), the extended `SpawnConfig` constant (8 fields with a mutated `networkMode` value), the per-spawn private Docker network + proxy sidecar contract created at Stage 4, the `march spawn verify` CLI surface, the bind-mount reject validator at Stage 4, and the threat-model audit table that locks down the A1–A8 mitigation evidence. F2/F3 contracts that F4 supersedes or extends are noted explicitly so the F2/F3 contracts files' forward-pointers resolve correctly.

## Interfaces

### march spawn verify (new CLI verb)

**Purpose**: Inspect a running spawn and emit a structured report mapping each Appendix A control to its observed posture.
**Consumers**: The operator (interactive use) and CI scripts (parsing the JSON report).
**Providers**: The March CLI binary, registered as a sibling of `march spawn dispatch` via Feature 1's CLI dispatch.

#### Signature

```
march spawn verify <spawn-id> [--probe]
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `<spawn-id>` | string (positional) | Yes | The SpawnId of the spawn to verify. Used to look up the SpawnRecord at `~/.march/spawns/<spawn-id>.json`, which provides the container ID. |
| `--probe` | flag | No | When present, the verification additionally executes a CONNECT probe to a known-blocked host (`1.1.1.1:443`) from inside the spawn container; the A4 control reports `pass` only if the probe fails to connect. Opt-in because (a) it requires the spawn container to be alive and (b) it is for sandbox auditing, not CI smoke. |

#### Outputs

| Effect | Location | Description |
|--------|----------|-------------|
| Verification report | stdout | A `SandboxVerificationReport` JSON object (see Data Model Entity 4 for shape). One entry per A1, A2, A3, A4, A5, A7, A8 control. |
| Diagnostic messages | stderr | Human-readable error/notice text when verification cannot proceed (no such spawn, container removed, spawn stopped, etc.). |

#### Exit Codes

| Condition | Exit Code | Description |
|-----------|-----------|-------------|
| All checked controls report `pass` | `0` (`SUCCESS`) | The spawn's runtime posture matches the F4 expected configuration. |
| One or more controls report `fail` | `1` (`ERROR`) | The verification ran successfully but observed a posture violation. The JSON report's `controls[].status` identifies the failing controls and `controls[].mismatch` describes the diff. |
| Usage error: missing or unknown spawn-id, container removed, spawn already stopped, `docker inspect` failed | `2` (`USAGE_ERROR`) | The verification could not be performed. A clear message names the cause on stderr. |

#### Error Conditions

| Condition | Exit Code | Description |
|-----------|-----------|-------------|
| `<spawn-id>` argument missing | 2 | Usage error — argv parser rejects the invocation; help output printed. |
| No SpawnRecord at `~/.march/spawns/<spawn-id>.json` | 2 | "no such spawn" message on stderr. |
| SpawnRecord's `status` is `"stopped"` or `"failed"` | 2 | "verify only works on running spawns; this spawn is stopped" message on stderr. |
| `docker inspect <container-id>` returns "no such container" | 2 | "container no longer exists (was it removed?)" message on stderr. |
| `docker inspect` succeeds but the container is in `Exited` state | 2 | Same as the SpawnRecord-stopped case — the spawn's runtime state has been torn down. |
| Backend not registered (e.g., SpawnRecord references a backend the running CLI doesn't know about) | 2 | "unknown backend in SpawnRecord" message on stderr. |
| `--probe` requested but the spawn container has no `docker exec` capability (very rare, e.g., container exited between the inspect call and the probe call) | 2 | "could not execute probe" message on stderr. The structured JSON report IS still emitted to stdout — the A4 `ControlReport` entry has `status: "n/a"` and `mismatch` omitted, so a downstream JSON consumer sees the unverifiable-A4 outcome alongside the other controls' results. The exit code 2 reflects that verification could not be completed (not that controls failed); the report is the diagnostic, the exit code is the routing signal. |

---

### SpawnBackend (extended — 5 members, supersedes F3's 4-member shape)

**Purpose**: Promote the per-backend egress-host allowlist onto the same registry entity that already owns base image, env vars, and entrypoint argv.
**Consumers**: The dispatch action's Stage 4 (Launch); the `march spawn verify` command (to read the expected `allowedEgressHosts` for the A7 control check).
**Providers**: F4 extends F3's two backend implementations (`claudeCodeBackend`, `geminiBackend`) with `allowedEgressHosts` values.

#### Interface (extended at 5 members in F4)

```typescript
interface SpawnBackend {
  /** Registry key. Inherited from F3 unchanged. */
  readonly name: string;

  /** Docker image tag containing this backend's CLI pre-installed.
   *  Inherited from F3 unchanged. */
  readonly baseImage: string;

  /** Names of host environment variables that must be set (and
   *  non-empty) before the spawn can run. Forwarded into the
   *  container as `-e <VAR>` passthroughs. Inherited from F3
   *  unchanged. */
  readonly requiredEnvVars: readonly string[];

  /** Returns the `docker run` exec argv that runs this backend's
   *  CLI inside the container against the given in-container
   *  prompt-file path. Inherited from F3 unchanged. */
  buildEntrypoint(promptFilePath: string): readonly string[];

  /** Exact hostnames this backend's CLI requires for outbound HTTPS
   *  traffic. Consumed by US1's per-spawn proxy sidecar at Stage 4
   *  as the CONNECT-time hostname allowlist. No wildcards in F4
   *  (see SD-005). NEW IN F4 — supersedes F3's "closed at 4
   *  members" decision (F3 FR-005, SC-005). */
  readonly allowedEgressHosts: readonly string[];
}
```

The F3 spec's "interface stays at four members" claim (F3 FR-005, F3 SC-005, plus `multi-backend-execution-interface.spec.md` Assumptions — the bullet beginning "The `SpawnBackend` interface promoted in F3 is the canonical dispatch contract going forward") is **explicitly superseded** by F4. The supersession is recorded in F4's Clarifications (session 2026-05-12, Q3) and FR-002.

#### Concrete Implementations (F4 extension)

**`claudeCodeBackend`**:

| Member | Value |
|--------|-------|
| `allowedEgressHosts` | `["api.anthropic.com"]` |

(All other members unchanged from F3.)

**`geminiBackend`**:

| Member | Value |
|--------|-------|
| `allowedEgressHosts` | `["generativelanguage.googleapis.com"]` (best inference per SD-001 — pending render/cut verification of Gemini CLI's actual outbound footprint) |

(All other members unchanged from F3.)

---

### SpawnConfig (extended — 8 fields, with a mutated `networkMode` value)

**Purpose**: F3's narrowed compile-time security/resource constant, extended by F4 with two new fields and a mutated network mode.
**Consumers**: Stage 4 (Launch) of the dispatch pipeline.
**Providers**: F4 ships the post-F4 `SpawnConfig` constant.

#### Shape

```typescript
interface SpawnConfig {
  /** F2 inherited. */
  readonly capDrop: readonly string[];      // ["ALL"]
  /** F2 inherited. */
  readonly user: string;                    // "march"
  /** F4 mutates value from "bridge" to "none". The runtime network
   *  connectivity comes from the per-spawn private user-defined
   *  Docker network plus the proxy sidecar, not from this flag. */
  readonly networkMode: string;             // "none" (F4)
  /** F2 inherited. */
  readonly memoryLimit: string;             // "4g"
  /** F2 inherited. */
  readonly cpuLimit: string;                // "2"
  /** F2 inherited. */
  readonly timeoutSeconds: number;          // 3600
  /** NEW IN F4. Maximum kernel pids the spawn container may create.
   *  Defends against fork-bomb DoS (A8). Stage 4 emits
   *  `--pids-limit <value>`. Default: 512 (per SD-004). */
  readonly pidsLimit: number;
  /** NEW IN F4. When true, container rootfs is read-only. Stage 4
   *  emits `--read-only` AND `--tmpfs /tmp` for writable scratch.
   *  Additional tmpfs mounts may be required (see SD-002). */
  readonly readOnlyRootfs: boolean;         // true (F4)
}
```

`envWhitelist` is **absent** — removed by F3 (F3 FR-012). Per-backend env vars live on `SpawnBackend.requiredEnvVars`. F4 does not reintroduce this field.

---

### Spawn Network Topology (per-spawn, internal contract)

**Purpose**: Define the per-spawn ephemeral Docker network + proxy sidecar that replaces F2's `bridge` network for outbound traffic.
**Consumers**: Stage 4 (Launch) of the dispatch pipeline; F2's reverse-order cleanup chain.
**Providers**: A new module under `src/` (likely `src/spawn-network.ts` or analogous) that owns the lifecycle.

#### Topology

```
                      ┌──────────────────────────┐
                      │ default Docker bridge    │  outbound to internet
                      └────────────┬─────────────┘
                                   │ (proxy is multi-homed:
                                   │  attached to bridge via
                                   │  Stage 4.2b)
                      ┌────────────▼─────────────┐
                      │ march-spawn-proxy-<id>   │  HTTP CONNECT proxy
                      │ (sidecar container)      │  with hostname allowlist =
                      │                          │  selectedBackend.allowedEgressHosts
                      └────────────┬─────────────┘
                                   │ (proxy is also attached to
                                   │  the internal private network)
                      ┌────────────▼─────────────┐
                      │ march-spawn-net-<id>     │  private user-defined
                      │ (Docker network,         │  Docker network — created
                      │  --internal: no route    │  with --internal so the
                      │  to public internet)     │  spawn cannot bypass the
                      └────────────┬─────────────┘  proxy by reaching the
                                   │                outside world directly
                      ┌────────────▼─────────────┐
                      │ march-spawn-<id>         │  spawn container
                      │ (--network=none at run,  │  HTTP_PROXY / HTTPS_PROXY
                      │  attached only to        │  env vars point to the
                      │  march-spawn-net-<id>    │  sidecar's Docker DNS name
                      │  in Stage 4.4)           │  on the private network —
                      │                          │  NEVER 127.0.0.1 / loopback
                      └──────────────────────────┘
```

#### Stage 4 sub-steps (F4 extension)

The F2 `Validate → Worktree → Snapshot → Launch → Handoff → Wait → Record` pipeline's Stage 4 (Launch) grows from "single `docker run`" to a sequenced sub-pipeline:

| Sub-step | Action | Cleanup-on-failure ordering |
|----------|--------|-----------------------------|
| 4.1 Network create | `docker network create --internal march-spawn-net-<spawn-id>` (the `--internal` flag forbids any default route to the host's external interfaces — containers attached only to this network have NO route to the public internet, satisfying FR-004) | None (no prior topology yet) |
| 4.2a Proxy launch | `docker run -d --name march-spawn-proxy-<spawn-id> --network march-spawn-net-<spawn-id> -e ALLOWLIST="<hosts>" <proxy-image>` (proxy starts attached only to the private network, with no outbound path yet — that lands in 4.2b) | Remove network (4.1) |
| 4.2b Proxy bridge attach | `docker network connect bridge march-spawn-proxy-<spawn-id>` (multi-homes the proxy: private network for spawn-side ingress, default bridge for operator-side egress; the proxy is the **only** multi-homed component in the topology) | Remove proxy (4.2a) + network (4.1) |
| 4.3 Spawn launch | `docker run -d --name march-spawn-<spawn-id> --network=none --read-only --tmpfs /tmp --pids-limit <n> ... <spawn-image>` (with bind-mount validator running first against the composed argv) | Remove proxy + network |
| 4.4 Spawn network attach | `docker network connect march-spawn-net-<spawn-id> march-spawn-<spawn-id>` (spawn becomes single-homed on the internal private network — `--network=none` at create time is replaced by exactly one attached network and no route to the public internet); set the spawn container's `HTTP_PROXY` / `HTTPS_PROXY` env vars to the proxy's Docker DNS name on the private network (`http://march-spawn-proxy-<spawn-id>:8080`) | Remove spawn container + proxy + network |

#### Lifecycle ordering (F4 extension)

The F2 reverse-order cleanup chain grows by two artifacts:

```
F2 cleanup order: container → snapshot image → worktree → branch
F4 cleanup order: container → proxy sidecar → private network → snapshot image → worktree → branch
```

Cleanup of the proxy sidecar and private network runs **regardless** of the spawn's exit status (success, failure, timeout) — they are torn down whenever the spawn container is no longer running. The F2 contract that "the stopped container remains available for Feature 5" is preserved: the spawn container itself is not removed, but its network attachment is torn down. F5 reads the spawn container's stdout via `docker logs <container-id>` (or equivalent), which does NOT require an active network attachment.

---

### Bind-Mount Reject Validator (Stage 4 internal contract)

**Purpose**: Structurally enforce the no-host-filesystem-access invariant by inspecting the composed `docker run` argv and refusing launch if any bind-mount flag is present.
**Consumers**: Stage 4.3 (Spawn launch sub-step), runs immediately before `docker run` is invoked.
**Providers**: A function in the dispatch action or `src/container-launch.ts` (likely `validateNoBindMounts(argv: readonly string[]): void`).

#### Algorithm

```
for i, arg in argv:
  if arg in {"-v", "--mount", "--volume"}:
    REJECT with "bind mount flag '<arg>' is not permitted"
  if arg starts with "--mount=" or "--volume=":
    REJECT with "bind mount flag '<arg>' is not permitted"
  if arg starts with "-v=":
    REJECT with "bind mount flag '<arg>' is not permitted"
  // Allow --tmpfs explicitly — tmpfs mounts do not bind host paths.
```

#### Allowlist of Permitted Mount-Adjacent Flags

| Flag | Permitted? | Rationale |
|------|-----------|-----------|
| `-v <host>:<container>` | NO (rejected) | Bind mount — A2 violation |
| `--volume <host>:<container>` | NO (rejected) | Bind mount — same as `-v` |
| `--mount type=bind,...` | NO (rejected) | Bind mount — explicit form |
| `--mount type=volume,...` | NO (rejected) | Named Docker volume — also forbidden in M1 (no persistence between spawns); revisit when Hatchery adds opt-in volumes |
| `--tmpfs <container-path>` | YES (allowed) | tmpfs mount — no host filesystem access; required for `readOnlyRootfs` to leave `/tmp` writable |
| `--read-only` | YES (allowed) | Read-only rootfs — A1/A2 hardening; required by F4 |

#### Failure Behavior

When the validator rejects an argv:

1. The dispatch command exits with code 1 (`ERROR`).
2. A clear message is printed to stderr naming the rejected flag and a hint that bind mounts are forbidden in M1.
3. F2's reverse-order cleanup runs against any artifacts created prior to Stage 4.3: the proxy sidecar and the private spawn network are removed; the snapshot image is removed; the worktree and branch are cleaned up.
4. The SpawnRecord is marked `failed` with the validator error in the diagnostic message.

The validator is invoked **before** `docker run` for the spawn container. It is not invoked against the proxy sidecar's argv (the proxy is internal infrastructure and uses no bind mounts by construction; if a future change requires a tmpfs for the proxy, that's also fine).

---

### Snapshot Exclusion Patterns (extended — 21 entries)

**Purpose**: Define the patterns excluded from the worktree snapshot to prevent secrets from reaching the LLM.
**Consumers**: `createBuildContext` in `src/snapshot.ts` via `isExcludedPath`.
**Providers**: F4 extends `SNAPSHOT_EXCLUSION_PATTERNS` from F2's 6 entries to 21 entries (additive).

#### Engine semantics (unchanged from F2)

The matching engine in `src/snapshot.ts` is preserved. Two pattern shapes:

| Shape | Semantics |
|-------|-----------|
| Basename glob (`*` and `?` wildcards, no `/`) | Matches the path's final segment at any depth. E.g., `*.p12` excludes `keystore.p12` AND `subdir/keystore.p12`. |
| Directory-segment literal (trailing `/`, no wildcards) | Matches any interior or final segment equal to the literal. E.g., `.aws/` excludes any path containing a `.aws` directory segment. |

#### Post-F4 pattern list

```typescript
export const SNAPSHOT_EXCLUSION_PATTERNS: readonly string[] = [
  // F2 baseline
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  ".secrets/",
  "credentials.json",
  // F4 expansion (A5 mitigation)
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "*.p12",
  "*.pfx",
  "*.jks",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".aws/",
  ".ssh/",
  ".gnupg/",
  ".docker/config.json",
  ".kube/config",
];
```

Total post-F4 pattern count: 21 (6 inherited + 15 added).

The existing F2 unit test that asserts the exact contents of `SNAPSHOT_EXCLUSION_PATTERNS` is updated to reflect the expanded list — an explicit task at render/cut time, mirroring F3's `envWhitelist` removal pattern.

---

### Threat-Model Audit Table (spec deliverable)

**Purpose**: Lock down the A1–A8 mitigation evidence as a single inspectable table covering every Appendix A control. Acts as both audit documentation and the contract surface F5 (and any future security-adjacent features) reads to understand what's already enforced.
**Consumers**: F5's spec author (reads the A6 row's contract subsection); future feature owners; security reviewers.
**Providers**: F4's spec (this document and the spec.md US6 section).

#### Table

| Control | Mitigation | Owning Feature | Evidence | Verification | Residual Risk |
|---------|-----------|----------------|----------|--------------|---------------|
| **A1** Container Escape | `--cap-drop=ALL` AND non-root user `march` AND `--read-only` rootfs (F4) | F2 (cap-drop, user); F4 (readOnlyRootfs) | `src/spawn-config.ts` `SPAWN_CONFIG.capDrop`, `.user`, `.readOnlyRootfs`; `src/container-launch.ts` argv composition | F4 US4 `march spawn verify` A1 control check; F2 acceptance scenarios for US5 (Launch); F4 acceptance scenarios for US6 (`pidsLimit`/`readOnlyRootfs` flags emitted) | Docker namespace isolation is the only barrier. Secondary isolation layers (gVisor, rootless Docker, Kata) are explicit non-goals for M1 unless threat model demands. Residual risk accepted. |
| **A2** Volume Mount Misconfiguration | Snapshot via COPY (no bind mounts in F2 dispatch) AND F4 Stage-4 bind-mount reject validator (US5) AND `--read-only` rootfs (F4 US6) | F2 (snapshot model); F4 (validator + readOnlyRootfs) | `src/snapshot.ts` `createBuildContext` (no host paths); F4 US5 validator | F4 US4 `march spawn verify` A2 control check (`Mounts` array contains only tmpfs entries); F4 US5 acceptance scenario with injected `-v` flag | Claude Max OAuth bind-mount of `~/.claude/` is deferred to post-M1 (F4 Out of Scope) — must be re-evaluated against A2 before any reopening. |
| **A3** Environment Variable Leakage | Per-backend `requiredEnvVars` whitelist (F3) AND auth pre-flight check (F3 US6) | F3 | F3 spec FR-011, FR-013, FR-014; `src/container-launch.ts` env-flag composition (post-F3) | F4 US4 `march spawn verify` A3 control check (running container's env contains exactly `selectedBackend.requiredEnvVars` plus the proxy env vars, no others); F3 SC-009 | If a future backend requires non-env-var auth (token files, OAuth flows), per-backend whitelist semantics need extension. Tracked as F3 Out of Scope. |
| **A4** DNS / Network Information Leakage | Spawn container runs `--network=none`; outbound traffic routed via per-spawn proxy sidecar with hostname allowlist evaluated at HTTP CONNECT time (F4 US1) | F4 (US1, US2) | `src/spawn-config.ts` `SPAWN_CONFIG.networkMode = "none"`; `src/spawn-network.ts` (or analogous) Stage 4 topology | F4 US4 `march spawn verify` A4 control check (`NetworkMode == "none"`, attached only to private spawn network); optional `--probe` flag asserts CONNECT to `1.1.1.1:443` is blocked | Backend CLIs that bypass `HTTP_PROXY` / `HTTPS_PROXY` would defeat the proxy. Both validated backends honor these env vars (assumption — to be verified at render/cut). Per-spawn proxy lifecycle ownership is open in SD-003. |
| **A5** Snapshotted Context Contains Secrets | Snapshot from `git ls-files` only (F2 — excludes untracked and gitignored files) AND expanded `SNAPSHOT_EXCLUSION_PATTERNS` (F4 US3) | F2 (git-tracked-only); F4 (expanded list) | `src/snapshot.ts` `listTrackedFiles` + `SNAPSHOT_EXCLUSION_PATTERNS` (post-F4: 21 entries) | F4 US3 acceptance scenario with fixture worktree per pattern; F4 US4 `march spawn verify` A5 control check (limited — best-inferred from a build-time label on the image) | The pattern list is non-exhaustive — new credential formats may be missed (e.g., HashiCorp Vault tokens). Hatchery (M2) makes the list per-profile-extensible. Entropy-based scanning is a future capability. |
| **A6** Output Manipulation | F4 publishes the requirement contract (this row links to the contract subsection below); F5 (Spawn Output Extraction) implements | F4 (contract); F5 (implementation) | A6 contract subsection (immediately below this table) | F5's acceptance scenarios (to be written by F5's spec author against the F4 contract) | F4 does NOT implement runtime output validation. F5's spec must reference the F4 contract. If F5 fails to satisfy the contract, A6 is unmitigated — surface in F5's plan-review. |
| **A7** LLM Credentials and Network Access | Per-backend `requiredEnvVars` (F3) AND per-backend `allowedEgressHosts` egress restriction via the proxy sidecar (F4 US1, US2) | F3 (credentials); F4 (egress restriction) | F3 FR-007, FR-008 (credential whitelist); F4 FR-001, FR-005 (egress allowlist) | F4 US4 `march spawn verify` A7 control check (the running proxy's allowlist matches `selectedBackend.allowedEgressHosts`) combined with A4's network probe | API keys (Gemini, Anthropic) are still exfiltratable to the allowlisted endpoint. Subscription rate limits and key rotation are out-of-band mitigations, not enforced by F4. Claude Max OAuth (rotatable session tokens) is deferred. |
| **A8** Resource Exhaustion | `--memory`, `--cpus`, `--pids-limit` (F4 addition), `--timeout` (Stage 6 wall-clock kill, F2) | F2 (memory/cpu/timeout); F4 (pidsLimit) | `src/spawn-config.ts` `SPAWN_CONFIG.memoryLimit`, `.cpuLimit`, `.timeoutSeconds`, `.pidsLimit` (F4); `src/container-launch.ts` argv composition | F4 US4 `march spawn verify` A8 control check (`HostConfig.PidsLimit`, `Memory`, `NanoCpus` match expected) | Disk quota is not enforced (Docker doesn't trivially expose per-container disk quotas). The snapshot image's size puts an upper bound. Tracked as future-Hatchery work. |

#### A6 Output Manipulation — requirement contract for F5

F4 does not implement A6 mitigations. F5 (Spawn Output Extraction) implements them. F4 publishes the following contract that F5's spec MUST reference:

1. **All spawn output is untrusted input.** F5 MUST treat the JSON envelope, every field within it, and the embedded git patch as adversarial — even when the spawn appears to have exited cleanly with code 0. The LLM may have crafted any field to exploit the extraction process.
2. **Validate JSON structure before processing.** F5 MUST parse the JSON with explicit size/depth limits. F5 MUST NOT pass the parsed object to any code that assumes well-formed-ness without validation. Malformed JSON MUST cause F5 to reject the output cleanly (exit code, error message), not crash.
3. **Validate that git patches only touch files within the worktree.** F5 MUST inspect every patch hunk's target path and reject any path that escapes the worktree (path traversal via `..`, absolute paths, symlink targets pointing outside the worktree). Rejection MUST be explicit, not silent.
4. **Apply patches to the worktree's branch only.** F5 MUST never apply a patch directly to `main`, to `repoPath` (the source repo), or to any branch other than the spawn's `march/spawn/<spawn-id>` branch. The branch isolation is the F2 invariant; F5 preserves it.
5. **Reject malformed JSON without crashing.** F5 MUST handle parse errors, missing required fields, and type mismatches with a clean error path. The extraction process is itself a security boundary — a crash in the extractor (especially one that leaves partial state behind) is itself a A6 vulnerability.

F5's spec MUST reference this contract by URL or path. F5's plan-review SHOULD verify each of the 5 requirements maps to a concrete F5 acceptance scenario or FR.

---

### Dispatch Pipeline Integration (modified contract)

**Purpose**: Define how F4 changes F2's `Validate → Worktree → Snapshot → Launch → Handoff → Wait → Record` pipeline.
**Consumers**: The `march spawn dispatch` command implementation.
**Providers**: Internal modules under `src/`.

#### Stage-by-stage F4 changes

| Stage | F2/F3 Behavior | F4 Change |
|-------|----------------|-----------|
| 1. Validate | F3: per-backend image check + auth pre-flight | Unchanged. F4 does NOT add a duplicate auth pre-flight. |
| 2. Worktree | (per F2) | Unchanged. |
| 3. Snapshot | F2: git-tracked files minus exclusion list, baked via Dockerfile; F3: per-backend `baseImage` | Snapshot pipeline unchanged. The exclusion list (`SNAPSHOT_EXCLUSION_PATTERNS`) grows from 6 to 21 entries — additive expansion only. |
| **4. Launch** | F3: single `docker run` with hardcoded security flags, env-flag composition iterates `selectedBackend.requiredEnvVars` | **F4 splits into 4 sub-steps:** 4.1 network create, 4.2 proxy launch, 4.3 spawn launch (with bind-mount reject validator running first), 4.4 spawn network attach. The spawn container uses `--network=none`, `--read-only`, `--tmpfs /tmp`, `--pids-limit <n>`. The spawn container's env adds `HTTP_PROXY` / `HTTPS_PROXY` pointing to the proxy sidecar. |
| 5. Handoff | (per F2) | Unchanged — the prompt file write to `CONTAINER_PROMPT_PATH` is independent of network/security configuration. |
| 6. Wait | (per F2) | Unchanged — but cleanup at exit grows by two artifacts (proxy sidecar, private network) per the F4 reverse-order cleanup chain. |
| 7. Record | F3: `writeInitialSpawnRecord({backend: selectedBackend.name})` | Unchanged. The SpawnRecord schema does not grow in F4 — the verify CLI reads runtime state via `docker inspect`, not from the SpawnRecord. |

#### Cleanup ordering (F4 extension)

```
F2 cleanup order: container → snapshot image → worktree → branch
F4 cleanup order: container → proxy sidecar → private spawn network → snapshot image → worktree → branch
```

Cleanup of the proxy sidecar and private network runs **on every dispatch outcome** (success, failure, timeout) — they are spawn-scoped artifacts with no purpose outside the active spawn. The spawn container itself remains for F5 extraction (F2 invariant preserved).

---

### LaunchSpawnContainerInput (modified contract)

**Purpose**: Communicate per-spawn launch parameters to the launch sub-pipeline.
**Consumers**: The Stage 4 sub-pipeline (`launchSpawnContainer` and the new `setupSpawnNetwork` / `launchProxySidecar` helpers).
**Providers**: The dispatch action.

#### Shape change (F4 additions to F3's input)

| Field | F2/F3 | F4 |
|-------|-------|----|
| `spawnId` | `string` (required) | `string` (required, unchanged). |
| `backend` | `SpawnBackend` (required, F3 added) | `SpawnBackend` (required, unchanged). The function now also reads `backend.allowedEgressHosts` for proxy sidecar configuration (F4 addition). |
| `proxyEndpoint` | (n/a) | `string` (required, NEW in F4). The proxy sidecar's URL on the private spawn network (e.g., `http://march-spawn-proxy-<spawn-id>:8080`) — NOT a loopback URL. The hostname resolves via Docker DNS within the user-defined private network the spawn and proxy share. Computed by Stage 4.2 and passed forward into Stage 4.3 so it can be set as the spawn container's `HTTP_PROXY` / `HTTPS_PROXY` env vars. |

#### Behavioral guarantee

The Stage 4 sub-pipeline MUST be the only entry point that creates the proxy sidecar and private network. No backend implementation, no module outside the launch path, and no test harness short-circuits this — the proxy and network are tightly coupled to the spawn container's lifecycle. The bind-mount reject validator runs unconditionally at Stage 4.3 against the composed argv.

---

## F2 / F3 Contract Resolutions

F4 resolves these forward-pointers from F2 and F3:

| F2/F3 Section | F2/F3 Forward-Pointer | F4 Resolution |
|---------------|------------------------|----------------|
| `spawn-dispatch.spec.md` Clarifications session 2026-04-11 ("Feature 2 ships with the default Docker bridge network. … Feature 4 (Spawn Sandbox Security) is responsible for hardening the network policy.") | Unchanged from F2 | Implemented: F4 mutates `SpawnConfig.networkMode` from `"bridge"` to `"none"` and introduces the per-spawn proxy sidecar + private network for outbound traffic. F2's "known security gap" is closed. |
| `spawn-dispatch.contracts.md` Snapshot Exclusion List section ("This list is hardcoded in Feature 2. Feature 4 may expand it based on threat model evaluation.") | Unchanged from F2 | Implemented: F4 expands the list from 6 to 21 entries via US3 / FR-008. |
| `src/container-launch.ts` doc comment (the paragraph beginning "Env-vars are passed via `-e VAR` passthrough…") containing "Feature 4 may add a pre-flight check that the operator has `ANTHROPIC_API_KEY` set before reaching this stage." | Unchanged from F2 | F3 already pulled this into US6 of F3 (`multi-backend-execution-interface.contracts.md` F2 Contract Resolutions table). F4 does NOT re-claim it — the comment is stale and is incidentally cleaned up when F4 modifies the file. |
| `multi-backend-execution-interface.spec.md` FR-005 / SC-005 ("`SpawnBackend` interface MUST be defined with exactly four members") | Unchanged from F3 | **Superseded by F4.** The interface grows from 4 to 5 members (adding `allowedEgressHosts`). F4's Clarifications session 2026-05-12 Q3 records the supersession explicitly. |
| `multi-backend-execution-interface.spec.md` Out of Scope ("**Per-backend network policy / outbound-traffic hardening** — F4 (Spawn Sandbox Security) owns network-policy mitigations, including any per-backend allowlist of API endpoints (Gemini's API, `api.anthropic.com`).") | Unchanged from F3 | Implemented: F4 introduces `SpawnBackend.allowedEgressHosts` (US2) and the per-spawn proxy sidecar that enforces the per-backend allowlist (US1). |
| `multi-backend-execution-interface.spec.md` Out of Scope ("**OAuth / Claude-Max session auth** — RFC Appendix C4's flat-rate cost model. … Deferred to a follow-on feature once F4's threat model is settled.") | F4's threat-model ruling on bind-mounts | F4 explicitly defers Claude Max OAuth bind-mount to post-M1 (Out of Scope). The bind-mount reject validator (US5) structurally enforces this deferral. Reopening requires a new feature with its own A2 threat-model review. |

## Events / Hooks

No events or hooks are introduced by F4. The Herald event bus (Milestone 4) defines the event system. F4's modifications stay within the dispatch action, the Stage 4 sub-pipeline, the snapshot exclusion list, and the new `march spawn verify` command.

## Integration Boundaries

- **Feature 2 (Spawn Dispatch)**: F4 extends F2's Stage 4 (Launch) with the proxy sidecar + private network sub-pipeline. F2's pipeline ordering, branch/worktree naming, snapshot mechanism, and SpawnRecord schema are all preserved. F2's reverse-order cleanup chain grows by two artifacts.
- **Feature 3 (Multi-Backend Execution Interface)**: F4 extends F3's `SpawnBackend` interface with `allowedEgressHosts`, formally superseding F3's "closed at 4 members" decision. F4 does NOT re-claim F3's auth pre-flight (US6 of F3); the audit table cites F3 as the owning feature for A3.
- **Feature 5 (Spawn Output Extraction)**: F4 publishes the A6 (Output Manipulation) requirement contract that F5 must implement. F5 reads from the spawn container's stdout via `docker logs <container-id>` (or equivalent), which works without an active network attachment — so F4's network teardown at spawn exit does not block F5.
- **Feature 6 (PR Integration)**: F6 reads the SpawnRecord (unchanged in F4). F6 has no network dependency on the proxy sidecar.
- **Milestone 2 (Hatchery)**: M2 layers declarative per-profile configuration on top of F4's primitives. The post-F4 `SpawnConfig` (8 fields) and post-F4 `SpawnBackend.allowedEgressHosts` are the seed for M2's first opinionated profile. M2 may make `pidsLimit`, `readOnlyRootfs`, and the egress allowlist per-profile-editable; M2 may also relax the bind-mount reject validator for opt-in profile-driven mounts.
- **Milestone 3 (Brood)**: Brood's session-management code reads the SpawnRecord (unchanged). The proxy sidecar / private network are torn down when the spawn exits (F4 cleanup chain), so Brood inherits a clean state when it owns the worktree/branch lifecycle.
- **Docker CLI**: F4 grows the Docker surface area Stage 4 uses: `docker network create`, `docker network connect`, `docker network rm`, plus a second `docker run` (for the proxy sidecar). All invoked via `child_process` per the F2/F3 pattern.
- **External proxy image provisioning**: The HTTP CONNECT proxy image is implementation detail — see SD-003. Whether F4 builds a `march-proxy:latest` image, uses an off-the-shelf image (tinyproxy, mitmproxy), or runs a custom Node.js / Go binary is decided at render/cut. The contract above describes the image's behavior (HTTP CONNECT proxy, hostname allowlist via env var), not its identity.
