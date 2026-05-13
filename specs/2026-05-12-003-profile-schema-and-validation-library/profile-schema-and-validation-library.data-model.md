# Data Model: Profile Schema and Validation Library

## Overview

This data model defines the in-memory shape of a Hatchery `Profile`: the declarative, version-controlled description of a containerized March component's posture. The shape is the schema — F1 ships TypeScript types as the authoritative spec, and a hand-rolled validator that narrows `unknown` to `Profile` while structurally enforcing the Appendix A threat-model constraints A2 (no host bind mounts), A3 (env whitelist as the only env mechanism), A5 (snapshot include/exclude), and A7 (network endpoint allowlist).

The on-disk representation is YAML (F2's concern). F1 sees only the parsed-to-`unknown` value and is itself I/O-free.

The data model also pins the 1:1 mapping from M1's `SpawnConfig` interface and module-scope constants onto `Profile`'s security-and-resources subtree so F5's refactor is a pure rename.

## Entities

### 1) `Profile` (in-memory typed value)

Purpose: the root entity. Carries identity, image, security posture, resource ceilings, mount declarations, snapshot policy, network policy, and an optional tools policy. Persisted as YAML by F2; serialized via a stable property order for diffability (alphabetical within each object, with discriminators first).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `version` | `1` (literal) | Yes | Schema version. M2 accepts only the integer literal `1`. String `"1"` or any other value produces `UnsupportedSchemaVersion`. |
| `name` | `string` | Yes | Profile identifier. Must match `^[a-z][a-z0-9-]{0,62}$`. F2 uses this as the filename base. |
| `baseImage` | `string` | Yes | Container image reference (Docker grammar — `name[:tag][@digest]`). Migration target for the `BASE_IMAGE` constant exported from `src/spawn-config.ts`. |
| `container` | `ContainerSecurity` | Yes | Security-posture block. See entity 2. |
| `resources` | `ResourceLimits` | Yes | Resource-ceiling block. See entity 3. |
| `fileMounts` | `FileMount[]` | Yes | May be empty. Closed discriminated union; no host-path variant exists. See entity 4. |
| `snapshot` | `SnapshotPolicy` | No | Optional. When absent, F2/F5 fall back to documented defaults (out of F1 scope). See entity 5. |
| `network` | `NetworkPolicy` | Yes | Required. Discriminated union; every profile must declare its network posture explicitly. See entity 6. |
| `tools` | `ToolsPolicy` | No | Optional, shipped unconsumed in M2. See entity 7. |

Validation rules:
- All top-level fields not listed above produce `UnknownField` errors at their JSON-pointer paths.
- An invalid `version` short-circuits all other validation: the validator returns only `UnsupportedSchemaVersion` with no sibling errors.

---

### 2) `ContainerSecurity` (`Profile.container`)

Purpose: the security-posture block. Three fields, each maps 1:1 onto a field on M1's `SpawnConfig` interface exported from `src/spawn-config.ts`. F5's rename moves these from a module-scope constant into the resolved profile.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `capDrop` | `string[]` | Yes | Linux capabilities to drop. Must contain the literal string `"ALL"` (case-sensitive) per the M1 default. Other entries are accepted as-is; precise capability-name validation deferred (see [SD-010](profile-schema-and-validation-library.spec.md#specification-debt)). |
| `user` | `string` | Yes | Container user identifier. Either POSIX username (`^[a-z_][a-z0-9_-]{0,31}$`) or numeric `uid[:gid]` (`^[0-9]+(:[0-9]+)?$`). Precise grammar resolution pending [SD-007](profile-schema-and-validation-library.spec.md#specification-debt). |
| `envWhitelist` | `string[]` | Yes | Environment variable **names** to pass through from the operator's environment. Each entry matches `^[A-Z_][A-Z0-9_]*$`. Inline values (`"FOO=bar"`) are forbidden and produce `InvalidEnvVarName`. Empty array is valid. |

Validation rules:
- `capDrop` missing `"ALL"`: `InvalidCapDrop`.
- `user` matching neither pattern: `InvalidUser`.
- `envWhitelist` entry containing `=` or other non-name characters: `InvalidEnvVarName`.
- Any property name not in `{capDrop, user, envWhitelist}` at this level: `UnknownField`. This is the **A3 structural enforcement** rule — the type itself has no `env`, `envFile`, `environment`, or `passthrough` field, and the validator's closed-world check rejects them at the structural level.

**M1 mapping**:

| M1 source | Profile location | M1 default |
|-----------|------------------|------------|
| `SpawnConfig.capDrop` | `Profile.container.capDrop` | `["ALL"]` |
| `SpawnConfig.user` | `Profile.container.user` | `"march"` |
| `SpawnConfig.envWhitelist` | `Profile.container.envWhitelist` | `["ANTHROPIC_API_KEY"]` |

---

### 3) `ResourceLimits` (`Profile.resources`)

Purpose: the resource-ceiling block. Three fields, each maps 1:1 onto M1's `SpawnConfig`. Separated from `ContainerSecurity` because security posture and resource ceilings are distinct concerns even though M1 colocates them.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `memoryLimit` | `string` | Yes | Docker memory grammar `^[0-9]+[bkmgBKMG]$` (e.g., `"4g"`). Tighter grammar than Docker's full surface — see [SD-008](profile-schema-and-validation-library.spec.md#specification-debt). |
| `cpuLimit` | `string` | Yes | Positive number grammar `^[0-9]+(\.[0-9]+)?$` (e.g., `"2"` or `"1.5"`). |
| `timeoutSeconds` | `number` | Yes | Positive integer. No upper bound enforced in F1 (operational sanity is F2/F4/F5's concern — see [SD-011](profile-schema-and-validation-library.spec.md#specification-debt)). |

Validation rules:
- `memoryLimit` not matching: `InvalidMemoryLimit`.
- `cpuLimit` not matching: `InvalidCpuLimit`.
- `timeoutSeconds` not a positive integer: `InvalidTimeout`.

**M1 mapping**:

| M1 source | Profile location | M1 default |
|-----------|------------------|------------|
| `SpawnConfig.memoryLimit` | `Profile.resources.memoryLimit` | `"4g"` |
| `SpawnConfig.cpuLimit` | `Profile.resources.cpuLimit` | `"2"` |
| `SpawnConfig.timeoutSeconds` | `Profile.resources.timeoutSeconds` | `3600` |

---

### 4) `FileMount` (closed discriminated union)

Purpose: declares which mounts the container has at runtime. **A2 structural enforcement** lives here: the union is closed to two variants, neither of which admits a host filesystem path. Any other `kind` value on input produces `UnknownDiscriminator` at runtime, and the type system prevents the constraint from being silently weakened by a future schema extension.

```ts
type FileMount = NamedVolumeMount | SnapshotMount;
```

#### 4a) `NamedVolumeMount`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `kind` | `"named-volume"` (literal) | Yes | Discriminator. |
| `name` | `string` | Yes | Docker volume name. M1 has no precedent for named-volume use; field shape only enforces non-empty string. |
| `target` | `string` | Yes | Absolute POSIX path inside the container. See [SD-006](profile-schema-and-validation-library.spec.md#specification-debt) for full target validation rules. |
| `readOnly` | `boolean` | Yes | Whether the mount is read-only. Named volumes can legitimately be writable. |

#### 4b) `SnapshotMount`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `kind` | `"snapshot"` (literal) | Yes | Discriminator. |
| `target` | `string` | Yes | Absolute POSIX path inside the container. |
| `readOnly` | `true` (literal) | Yes | Literally `true`. A `readOnly: false` snapshot mount is structurally rejected (`SnapshotMustBeReadOnly`) — snapshots are by definition non-mutable in M2's threat model. |

Validation rules:
- Unknown `kind` (e.g., `"host-path"`, `"bind"`, `"tmpfs"`): `UnknownDiscriminator` at `/fileMounts/<i>/kind`.
- `SnapshotMount` with `readOnly: false`: `SnapshotMustBeReadOnly` at `/fileMounts/<i>/readOnly`.
- Missing required field: `MissingField` at the field path.
- Unknown property names within a variant: `UnknownField`.
- `target` validation (absolute, no `..`, no root, etc.): see [SD-006](profile-schema-and-validation-library.spec.md#specification-debt). The F1 enum reserves `InvalidMountTarget` for these conditions.

---

### 5) `SnapshotPolicy` (`Profile.snapshot?`)

Purpose: declares include/exclude patterns applied when materializing the build context from the worktree. **A5 structural surface** — the field shapes give operators a place to declare snapshot policy declaratively without code changes.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `include` | `string[]` | No | Optional. M2 semantics deferred (see [SD-001](profile-schema-and-validation-library.spec.md#specification-debt)) — F1 accepts shape only. |
| `exclude` | `string[]` | Yes (when `snapshot` present) | Patterns to exclude from the build context. **Shape-compatible** with the `compileExclusions` function exported from `src/snapshot.ts` — basename globs (no `/`) match a path's final segment; trailing-slash patterns (`.secrets/`) match any directory segment. F1 preserves these strings verbatim. |

Validation rules:
- `exclude` missing when `snapshot` is present: `MissingField`.
- Entries with absolute paths (`/foo`) or `..` traversals: `InvalidMountTarget`-class error (precise code per [SD-006](profile-schema-and-validation-library.spec.md#specification-debt)).
- Unknown property names at this level: `UnknownField`.

**M1 mapping**:

| M1 source | Profile location | M1 default |
|-----------|------------------|------------|
| `SNAPSHOT_EXCLUSION_PATTERNS` constant (`src/snapshot.ts`) | `Profile.snapshot.exclude` | `[".env", ".env.*", "*.pem", "*.key", ".secrets/", "credentials.json"]` |

---

### 6) `NetworkPolicy` (`Profile.network`, closed discriminated union)

Purpose: declares the container's network posture. **A7 structural surface** — every profile must commit to one of three modes, and `allowlist` mode requires a non-empty list of structured endpoints. Replaces M1's free-form `SpawnConfig.networkMode: string`.

```ts
type NetworkPolicy =
  | BridgeNetwork
  | NoneNetwork
  | AllowlistNetwork;
```

#### 6a) `BridgeNetwork`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `mode` | `"bridge"` (literal) | Yes | Discriminator. M1-equivalent posture. Documents the known M1 gap explicitly. |

No other properties allowed; an `allowlist` field under `mode: "bridge"` produces `UnknownField`.

#### 6b) `NoneNetwork`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `mode` | `"none"` (literal) | Yes | Discriminator. Strictest A7 posture — Docker `--network=none`. |

#### 6c) `AllowlistNetwork`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `mode` | `"allowlist"` (literal) | Yes | Discriminator. |
| `allowlist` | `NetworkEndpoint[]` | Yes | Must be non-empty. F5 owns the Docker-layer translation. |

Validation rules:
- Unknown `mode` (e.g., `"host"`, `"container"`): `UnknownDiscriminator` at `/network/mode`.
- `mode: "allowlist"` with missing or empty `allowlist`: `EmptyAllowlist` at `/network/allowlist`. (Operators expressing "no outbound traffic" should use `mode: "none"`.)
- `mode: "bridge"` or `mode: "none"` with an `allowlist` field present: `UnknownField` at `/network/allowlist`.

**M1 mapping**:

| M1 source | Profile location | M1 default |
|-----------|------------------|------------|
| `SpawnConfig.networkMode` | `Profile.network.mode` | `"bridge"` |

The M1→M2 transition is a **replacement**, not a rename. M1's string-typed `networkMode` field becomes a discriminated union. F5 maps the M1 value `"bridge"` to `{ mode: "bridge" }` in the seeded `spawn` profile; the `pr-management` profile uses `{ mode: "allowlist", allowlist: [...] }` instead.

---

### 7) `NetworkEndpoint` (within `AllowlistNetwork.allowlist`)

Purpose: structured description of a single endpoint that A7 enforcement at the Docker layer (F5) will allow.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `host` | `string` | Yes | DNS-resolvable hostname (RFC 1123) or IPv4 literal. CIDR and IPv6 deferred per [SD-002](profile-schema-and-validation-library.spec.md#specification-debt). No scheme prefix — protocol carries that information. |
| `port` | `number` | Yes | Integer in `[1, 65535]`. Wildcards deferred per [SD-003](profile-schema-and-validation-library.spec.md#specification-debt). |
| `protocol` | `"http" \| "https" \| "tcp"` | Yes | Closed enum. Other values produce `InvalidProtocol`. |

Validation rules:
- `host` matching neither pattern: `InvalidHost`.
- `port` outside range or non-integer: `InvalidPort`.
- `protocol` outside enum: `InvalidProtocol`.
- Unknown property at this level: `UnknownField`.

---

### 8) `ToolsPolicy` (`Profile.tools?`, optional)

Purpose: declares which backend tools are enabled or disabled. **Shipped in M2 but unconsumed** — no M2 runtime component reads it. Shipping the field avoids a `version: 2` migration when an M3+ component arrives that does honor it.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `enabled` | `string[]` | No | Optional. Tool names; F1 enforces shape only. Empty array valid. |
| `disabled` | `string[]` | No | Optional. Tool names; F1 enforces shape only. Empty array valid. |

Validation rules:
- A tool name appearing in both `enabled` and `disabled`: `ToolOverlap` at `/tools` (offending name included in message).
- Non-string entry: `WrongType` at the indexed path.
- Unknown property at this level: `UnknownField`.

---

### 9) `ValidationError`

Purpose: a single structural problem discovered during validation. Returned in the failure branch of `ValidationResult`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `code` | `ValidationErrorCode` | Yes | Named string-literal union. See entity 11 for the full enumeration. |
| `path` | `string` | Yes | JSON Pointer (RFC 6901) into the original input. Empty string `""` for root-level errors. Example: `/container/envWhitelist/0`. |
| `message` | `string` | Yes | Human-readable diagnostic. Not part of the public API contract beyond "operator-readable"; consumers should key UX off `code`. |

Validation rules:
- `code` MUST be one of the enumerated values in entity 11.
- `path` MUST be a valid JSON Pointer (leading `/` for non-root, `~0`/`~1` escaping for `~` and `/` in property names).

---

### 10) `ValidationResult`

Purpose: the discriminated return shape of `validateProfile`. Lets consumers narrow on `ok` without exception handling.

```ts
type ValidationResult =
  | { ok: true;  value: Profile }
  | { ok: false; errors: ValidationError[] };
```

Validation rules (i.e., guarantees about the return value):
- When `ok: true`, `value` is structurally and value-equivalent to the input, with no missing or extra fields.
- When `ok: false`, `errors` is non-empty and deterministically ordered (JSON-pointer lexicographic, then code lexicographic).
- `errors` carries every problem discovered in one pass (FR-004), except when an `UnsupportedSchemaVersion` is the first error reached, in which case `errors` contains only that one error.

---

### 11) `ValidationErrorCode` (named string-literal union)

Purpose: stable enumeration of every structural problem the validator can report. Treated as a public API surface within M2 per the leaning resolution of [SD-005](profile-schema-and-validation-library.spec.md#specification-debt); may extend in M3+.

| Code | When emitted | Path examples |
|------|--------------|----------------|
| `WrongType` | A field's runtime type does not match its declared type. | `/`, `/baseImage`, `/container/capDrop`, `/network/allowlist/0/port` |
| `MissingField` | A required field is absent. | `/baseImage`, `/container/user`, `/fileMounts/0/target` |
| `UnknownField` | A property name not in the schema appears at any object level. | `/env`, `/container/envFile`, `/network/allowlist` (when `mode: "bridge"`) |
| `UnknownDiscriminator` | A discriminator value (`FileMount.kind`, `NetworkPolicy.mode`) is outside its closed enumeration. | `/fileMounts/0/kind`, `/network/mode` |
| `UnsupportedSchemaVersion` | `version` is missing, not the literal `1`, or wrong type. | `/version` |
| `InvalidName` | `name` does not match `^[a-z][a-z0-9-]{0,62}$`. | `/name` |
| `InvalidImageReference` | `baseImage` does not match Docker reference grammar or is empty. | `/baseImage` |
| `InvalidCapDrop` | `container.capDrop` does not contain `"ALL"`. | `/container/capDrop` |
| `InvalidUser` | `container.user` matches neither username nor uid[:gid] pattern. | `/container/user` |
| `InvalidMemoryLimit` | `resources.memoryLimit` does not match `^[0-9]+[bkmgBKMG]$`. | `/resources/memoryLimit` |
| `InvalidCpuLimit` | `resources.cpuLimit` does not match `^[0-9]+(\.[0-9]+)?$`. | `/resources/cpuLimit` |
| `InvalidTimeout` | `resources.timeoutSeconds` is not a positive integer. | `/resources/timeoutSeconds` |
| `InvalidEnvVarName` | `container.envWhitelist` entry does not match POSIX env name grammar, or contains `=`. | `/container/envWhitelist/2` |
| `SnapshotMustBeReadOnly` | A `SnapshotMount` has `readOnly: false`. | `/fileMounts/0/readOnly` |
| `InvalidMountTarget` | A mount `target` or snapshot pattern violates path rules (absolute requirement, no `..`, etc.) — precise trigger conditions per [SD-006](profile-schema-and-validation-library.spec.md#specification-debt). | `/fileMounts/0/target`, `/snapshot/exclude/3` |
| `EmptyAllowlist` | `network.mode === "allowlist"` with missing or empty `allowlist`. | `/network/allowlist` |
| `InvalidHost` | `NetworkEndpoint.host` is empty, malformed, or contains a scheme. | `/network/allowlist/0/host` |
| `InvalidPort` | `NetworkEndpoint.port` is outside `[1, 65535]` or non-integer. | `/network/allowlist/0/port` |
| `InvalidProtocol` | `NetworkEndpoint.protocol` is outside `{"http", "https", "tcp"}`. | `/network/allowlist/0/protocol` |
| `ToolOverlap` | A tool name appears in both `tools.enabled` and `tools.disabled`. | `/tools` |

## Relationships

- A `Profile` 1:1 carries one `ContainerSecurity`, one `ResourceLimits`, one optional `SnapshotPolicy`, one `NetworkPolicy`, and one optional `ToolsPolicy`.
- A `Profile` 1:N carries `FileMount` entries; the list may be empty.
- An `AllowlistNetwork` (variant of `NetworkPolicy`) 1:N carries `NetworkEndpoint` entries; the list must be non-empty (else `EmptyAllowlist`).
- The relationships are pure containment (no foreign keys, no by-ID references); the entire profile is one in-memory tree.
- F1's `Profile.baseImage`, `Profile.container`, `Profile.resources`, and `Profile.snapshot.exclude` collectively contain the data that **replaces** the entire `src/spawn-config.ts` module and the `SNAPSHOT_EXCLUSION_PATTERNS` constant in `src/snapshot.ts`. F5 deletes those exports after the seeded `spawn` profile is in place.

## State Transitions

This is a declarative schema, not a stateful entity. There are no state transitions for `Profile` itself.

The validator's I/O shape is a single transition:

```
unknown  --[validateProfile]-->  ValidationResult
```

`ValidationResult` is itself a discriminated union with two states, neither of which transitions to the other. Consumers narrow on `result.ok` and act on `result.value` or `result.errors` accordingly.

## Identity & Uniqueness

- A `Profile` is uniquely identified within a profile registry by `Profile.name`. F1 validates `name` shape but **does not** enforce uniqueness — that is F2's concern (filesystem catalogue) and F4's concern (CLI registry list/inspect/validate).
- Within a single profile, `FileMount.target` values SHOULD be unique across the `fileMounts` array. F1 does not enforce this in M2 (deferred — see [SD-006](profile-schema-and-validation-library.spec.md#specification-debt)).
- Within a single profile, `NetworkEndpoint` entries SHOULD be unique by `(host, port, protocol)` triple. F1 does not enforce this in M2.
- `tools.enabled` and `tools.disabled` MUST NOT share entries (enforced via `ToolOverlap`).

## Module Layout

Suggested file structure under `src/profile/`:

- `src/profile/index.ts` — barrel re-export of `Profile`, `validateProfile`, `ValidationError`, `ValidationErrorCode`, `ValidationResult` and the public sub-types (`ContainerSecurity`, `ResourceLimits`, `FileMount`, `NamedVolumeMount`, `SnapshotMount`, `SnapshotPolicy`, `NetworkPolicy`, `BridgeNetwork`, `NoneNetwork`, `AllowlistNetwork`, `NetworkEndpoint`, `ToolsPolicy`).
- `src/profile/types.ts` — the TypeScript types (entities 1–8, 9–10), declarative-only.
- `src/profile/errors.ts` — the `ValidationErrorCode` string-literal union (entity 11), plus a small helper or two for path-building.
- `src/profile/validate.ts` — the hand-rolled validator implementing `validateProfile`.
- `tests/fixtures/profile/valid/*.yaml` — valid profile fixtures including `m1-spawn-parity.yaml` and `pr-management-shape.yaml`.
- `tests/fixtures/profile/invalid/*.yaml` plus sidecar `*.expected.json` — one fixture per `ValidationErrorCode` variant.
- `src/profile/*.test.ts` — type-only and runtime tests that consume the fixtures.

The exact filenames are an implementation detail; downstream commands (`smithy.cut`, `smithy.forge`) may relocate them.
