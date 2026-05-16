# Contracts: Profile Schema and Validation Library

## Overview

F1 ships a single integration boundary: a TypeScript profile module that exports a declarative `Profile` type and a pure validator. The profile module is the contract surface for F2 (filesystem layer), F4 (CLI verbs), F5 (Spawn dispatch consumer), and any future Hatchery consumer in M3+. The module has no inbound I/O dependency and no runtime dependency beyond TypeScript's standard library.

There is exactly one runtime entry point — `validateProfile(input: unknown): ValidationResult`. Every other contract artifact is either a type the validator narrows to or a value the validator emits.

## Interfaces

### Profile Module Public API

**Purpose**: the entire externally-visible surface of F1.

**Consumers**:
- F2 (profile storage and resolution) calls `validateProfile` after parsing YAML from disk.
- F4 (Hatchery CLI surface) calls `validateProfile` for `march hatchery validate`.
- F5 (Spawn consumes Hatchery profile) imports `Profile` for type narrowing and `validateProfile` at dispatch time.
- F6 (Hatchery skills) — documentation only; the skill markdown references the public types and error codes.

**Providers**: F1 — sole owner of `src/profile/`.

#### Signature

```ts
// src/profile/index.ts (barrel)

// Validator entry point.
export function validateProfile(input: unknown): ValidationResult;

// Discriminated return type.
export type ValidationResult =
  | { ok: true;  value: Profile }
  | { ok: false; errors: readonly ValidationError[] };

// Error shape.
export interface ValidationError {
  readonly code: ValidationErrorCode;
  readonly path: string;       // JSON Pointer (RFC 6901); "" for root
  readonly message: string;    // operator-readable; not part of API contract
}

// Closed string-literal union of every reportable structural problem.
export type ValidationErrorCode =
  | "WrongType"
  | "MissingField"
  | "UnknownField"
  | "UnknownDiscriminator"
  | "UnsupportedSchemaVersion"
  | "InvalidName"
  | "InvalidImageReference"
  | "InvalidCapDrop"
  | "InvalidUser"
  | "InvalidMemoryLimit"
  | "InvalidCpuLimit"
  | "InvalidTimeout"
  | "InvalidEnvVarName"
  | "SnapshotMustBeReadOnly"
  | "InvalidMountTarget"
  | "EmptyAllowlist"
  | "InvalidHost"
  | "InvalidPort"
  | "InvalidProtocol"
  | "ToolOverlap";

// Top-level entity.
export interface Profile {
  readonly version: 1;
  readonly name: string;
  readonly baseImage: string;
  readonly container: ContainerSecurity;
  readonly resources: ResourceLimits;
  readonly fileMounts: readonly FileMount[];
  readonly snapshot?: SnapshotPolicy;
  readonly network: NetworkPolicy;
  readonly tools?: ToolsPolicy;
}

// Sub-types (full field shapes in the data-model document).
export interface ContainerSecurity { /* capDrop, user, envWhitelist */ }
export interface ResourceLimits    { /* memoryLimit, cpuLimit, timeoutSeconds */ }
export type     FileMount        = NamedVolumeMount | SnapshotMount;
export interface NamedVolumeMount  { /* kind: "named-volume" + name, target, readOnly */ }
export interface SnapshotMount     { /* kind: "snapshot" + target, readOnly: true */ }
export interface SnapshotPolicy    { /* include?, exclude */ }
export type     NetworkPolicy    = BridgeNetwork | NoneNetwork | AllowlistNetwork;
export interface BridgeNetwork     { /* mode: "bridge" */ }
export interface NoneNetwork       { /* mode: "none" */ }
export interface AllowlistNetwork  { /* mode: "allowlist" + allowlist */ }
export interface NetworkEndpoint   { /* host, port, protocol */ }
export interface ToolsPolicy       { /* allowed?, disallowed? */ }
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `input` | `unknown` | Yes | Any JS value. Typically the result of parsing a YAML file from F2, but the contract accepts anything — `null`, primitives, arrays, exotic objects all flow through. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| (return) | `ValidationResult` | Discriminated union; consumers narrow on `result.ok`. |
| `result.value` (when `ok: true`) | `Profile` | Structurally validated and TypeScript-narrowed view of the input. May be the same reference as the input (no defensive copy in M2). |
| `result.errors` (when `ok: false`) | `readonly ValidationError[]` | Non-empty, deterministically ordered list of structural problems. |

#### Error Conditions

The validator never throws. Every structural problem becomes a `ValidationError`. The full taxonomy is documented in the data-model document; the contract here is:

| Condition | Response | Description |
|-----------|----------|-------------|
| `input` is not an object | `{ ok: false, errors: [{ code: "WrongType", path: "", ... }] }` | Returned in a single error; no further validation attempted. |
| `input.version` is missing or not `1` | `{ ok: false, errors: [{ code: "UnsupportedSchemaVersion", path: "/version", ... }] }` | **Short-circuits** all other validation. The errors array contains exactly one entry. |
| Required field missing at any depth | One `MissingField` error per missing field, aggregated with other errors. The `EmptyAllowlist` rule below takes precedence over the generic `MissingField` for the specific case of `allowlist` under `mode: "allowlist"`. | Field's JSON-pointer path. |
| Field has wrong type at any depth | One `WrongType` error per offender. | Field's path. |
| Unknown property at any object level | One `UnknownField` error per unrecognized key. | Path to the unrecognized key, not the parent. |
| Unknown discriminator value (e.g., `FileMount.kind: "host-bind"`) | One `UnknownDiscriminator` at the discriminator's path. | Sibling fields of an unknown discriminator are not further validated (the discriminator's variant is unknown, so its sibling shape is unknown). |
| Domain rule violation (regex, enum, range) | The corresponding named code (e.g., `InvalidName`, `InvalidPort`). | Field's path. |
| `AllowlistNetwork` (`mode: "allowlist"`) with `allowlist` either **absent** or present-but-empty | A single `EmptyAllowlist` at `/network/allowlist`. Missing and empty both produce this code (not `MissingField`) so consumers handle a uniform "no allowed endpoints under allowlist mode" condition. | `/network/allowlist` |
| `tools.allowed` and `tools.disallowed` share an entry | One `ToolOverlap` at `/tools` with the offending name in `message`. | `/tools` |

#### Behavior Contracts

These guarantees are part of the contract — F2/F4/F5 may rely on them:

1. **Pure and total.** No I/O, no `Date`, no `Math.random`, no environment reads, no module-scoped mutable state. The function is referentially transparent — same input always produces the same output (byte-identical, including `errors[]` ordering).
2. **Never throws on `input` shape.** Any JS value goes through `validateProfile` and returns a `ValidationResult`. Throws only on programmer error (bugs in the validator).
3. **All-errors aggregation.** When `input.version === 1`, every other structural problem the validator can discover in one pass is reported. No first-fail short-circuit.
4. **Version short-circuit.** When `input.version` is missing or wrong, the validator returns exactly one error (`UnsupportedSchemaVersion`) — validating against a schema the input is not claiming to conform to would produce noise.
5. **Closed-world rejection.** Any property name not in the schema at its location produces `UnknownField`. This is **A3 structural enforcement** — there is no `env`, `envFile`, `environment`, or `passthrough` field that an operator can use to smuggle env vars past `envWhitelist`.
6. **Deterministic ordering.** `errors[]` is sorted lexicographically by `path` first, then by `code`. Snapshot tests are stable.
7. **No defensive copy in M2.** When `ok: true`, `result.value` may be the same reference as `input`. Consumers SHOULD NOT mutate `result.value`. (F2/F5 currently don't; if a future consumer wants mutation safety, F1 can add a `freezeProfile` helper in M3+.)
8. **No external schema-validation runtime dependency.** F1 ships a hand-rolled validator. The codebase has no Zod/Ajv/Yup, and F1 preserves that.

---

## Events / Hooks

F1 publishes no events and subscribes to none. The validator is a pure function and runs in the consumer's call stack. F2/F4/F5 are free to emit their own events (e.g., F4's `march hatchery validate` may log structured diagnostics) — but those events are not part of F1's contract.

---

## Integration Boundaries

### Inbound — none

F1 has no callers it depends on. It is a leaf module; consumers import the public API and call it directly.

### Outbound — TypeScript standard library only

F1 imports nothing outside `src/profile/` from the codebase. In particular:

- F1 does **not** import `src/spawn-config.ts`. The 1:1 mapping is enforced by a type-only test (`type _: Omit<SpawnConfig, "networkMode"> extends StructuralMatch<ContainerSecurity & ResourceLimits>`), not by a runtime import.
- F1 does **not** import `src/snapshot.ts` or any of its exports (`SNAPSHOT_EXCLUSION_PATTERNS`, `isExcludedPath`, `createBuildContext`, `BuildContextHandle`, `SnapshotError`). F1's `snapshot.exclude` is `string[]` precisely so consumers (F5) can feed it into the existing exclusion-matching logic in `src/snapshot.ts` — currently the exported `isExcludedPath` predicate and the private `compileExclusions` helper invoked by `createBuildContext` — *without* F1 needing to invoke or depend on that module. This decoupling is load-bearing because F5 will likely relocate or refactor that logic during the M1→M2 refactor.
- F1 does **not** import `js-yaml` or any other parser. F2 parses YAML; F1 validates the already-parsed `unknown`.

### Outbound — Module-export contract for F5

F5's refactor of `src/spawn-config.ts` is a contract obligation that F1's data model anticipates:

| M1 export (today) | F5 disposition | Migration target |
|-------------------|----------------|------------------|
| `BASE_IMAGE` constant (`src/spawn-config.ts`) | Deleted by F5. | `Profile.baseImage` field on the seeded `spawn` profile. |
| `SpawnConfig` interface (`src/spawn-config.ts`) | Deleted by F5. | `ContainerSecurity & ResourceLimits` (minus `networkMode`, which moves to `NetworkPolicy.mode`). |
| `SPAWN_CONFIG` constant (`src/spawn-config.ts`) | Deleted by F5. | The seeded `spawn` profile's `container` + `resources` fields, with values byte-identical to the M1 constant. |
| `SNAPSHOT_EXCLUSION_PATTERNS` constant (`src/snapshot.ts`) | Deleted by F5. | The seeded `spawn` profile's `snapshot.exclude` array, with values byte-identical to the M1 constant. |
| Exclusion-matching logic in `src/snapshot.ts` (the exported `isExcludedPath` predicate and the private `compileExclusions` helper invoked by `createBuildContext`) | Retained by F5; may be relocated or refactored within the profile/snapshot pipeline. | F5's runtime consumer of `Profile.snapshot.exclude`. |

The F5 contract is "byte-identical Docker invocation for the seeded `spawn` profile compared to M1's current run." F1's job is to admit a profile whose values reproduce the M1 constants verbatim; the byte-identity assertion is enforced at fixture level (`tests/fixtures/profile/valid/m1-spawn-parity.yaml` in US8) and at F5's regression-test level.

### Outbound — Module-export contract for F2

F2 imports `validateProfile`, `Profile`, `ValidationError`, `ValidationResult` from `src/profile/index.ts`. F2's loader:

1. Reads the on-disk YAML file (F2's I/O).
2. Parses YAML to a JS value of type `unknown` (F2's responsibility — parse-error handling is F2's, not F1's).
3. Invokes `validateProfile(parsed)`.
4. Branches on `result.ok`:
   - `true`: returns the typed `Profile` to F2's caller (F4 or F5).
   - `false`: returns the `ValidationError[]` wrapped in F2's loader-error shape, with the source file path attached.

F1 does **not** define how F2 surfaces errors. F2 owns the on-disk-context layer (filename, line/column from the YAML parser, etc.). F1's contract is the validator's pure input/output relationship only.

### Outbound — Module-export contract for F4

F4's CLI surface invokes `validateProfile` for `march hatchery validate` and renders `ValidationError[]` as operator diagnostics. F4 keys UX off `code` (e.g., color or icon by category) and prints `path` and `message` as the line content. F1's contract guarantees that:

- The `code` enumeration is stable within M2 (per [SD-005](profile-schema-and-validation-library.spec.md#specification-debt) leaning resolution; subject to operator final call). F4 may write a switch over codes without fear of code rename.
- The `path` is a valid JSON Pointer, so F4 can locate the offending location in the source YAML by cross-referencing the parser's position map.
- The `message` is operator-readable but its exact wording is not contractual; F4 should not snapshot-test message content if it wants to be resilient to phrasing tweaks.

### Outbound — Documentation contract for F6

F6's profile-authoring skill documents the schema. F1's contract is that:

- The TypeScript public types in `src/profile/index.ts` are the authoritative spec.
- The fixture corpus under `tests/fixtures/profile/` is the secondary spec (one valid fixture per profile shape, one invalid fixture per error code).
- The named error codes (`ValidationErrorCode`) are stable within M2 and may be referenced verbatim in skill markdown.

---

## Type-Only Contract Tests

F1 includes **compile-time** tests that enforce contract guarantees the runtime validator cannot:

1. **A2 structural enforcement.**
   ```ts
   type _NoHostPathMount = Extract<FileMount, { kind: "host-path" | "host-bind" | "bind" | "tmpfs" }>;
   //    ^?
   // expect-type: never
   ```

2. **A3 structural enforcement.**
   ```ts
   type _NoInlineEnv = Extract<keyof ContainerSecurity, "env" | "envFile" | "environment" | "passthrough">;
   //    ^?
   // expect-type: never
   ```

3. **M1 SpawnConfig assignability.**
   ```ts
   // The six retained M1 fields, structurally:
   type _M1Retained = Omit<{
     capDrop: readonly string[];
     user: string;
     memoryLimit: string;
     cpuLimit: string;
     timeoutSeconds: number;
     envWhitelist: readonly string[];
   }, never>;
   // ContainerSecurity & ResourceLimits must be assignable from _M1Retained:
   declare const m1: _M1Retained;
   const _: ContainerSecurity & ResourceLimits = {
     capDrop: m1.capDrop,
     user: m1.user,
     envWhitelist: m1.envWhitelist,
     memoryLimit: m1.memoryLimit,
     cpuLimit: m1.cpuLimit,
     timeoutSeconds: m1.timeoutSeconds,
   };
   ```

4. **`SnapshotMount.readOnly` literal-true.**
   ```ts
   type _SnapshotReadOnly = Extract<FileMount, { kind: "snapshot" }>["readOnly"];
   //    ^?
   // expect-type: true
   ```

These tests live alongside the runtime tests in `src/profile/*.test.ts` and run on every CI build. They are part of F1's contract — a future PR that weakens any of them MUST also document why the threat-model claim still holds.

---

## Fixture Corpus Contract

US8 ships a fixture corpus under `tests/fixtures/profile/` that serves as F1's secondary spec. The fixture contract is:

- **`tests/fixtures/profile/valid/`**: at least one fixture per documented profile shape:
  - `m1-spawn-parity.yaml`: encodes M1's `SPAWN_CONFIG` and `SNAPSHOT_EXCLUSION_PATTERNS` values byte-identically, validating as `ok: true`. F5's regression-test harness re-validates this fixture and asserts the produced `docker run` invocation equals M1's invocation byte-for-byte.
  - `pr-management-shape.yaml`: encodes the `pr-management` profile shape (broader `envWhitelist` for `GH_TOKEN`/`GITHUB_TOKEN`, `network.allowlist` including `api.github.com`, repo-snapshot file mount). Validates as `ok: true`, demonstrating F1's schema accommodates F3's second seeded profile.
- **`tests/fixtures/profile/invalid/`**: at least one fixture per `ValidationErrorCode` variant. Each fixture has a sidecar `<name>.expected.json` with:
  ```json
  {
    "expectedCodes": ["UnknownDiscriminator"],
    "expectedPaths": ["/fileMounts/0/kind"]
  }
  ```
  US8's coverage check asserts every `ValidationErrorCode` is exercised by at least one fixture.

This corpus is part of F1's deliverable — downstream features that change the schema MUST update fixtures and sidecar files in the same change.

---

## Contract Stability and Versioning

- **`Profile` schema version** is `1` and stable for the lifetime of M2. M3+ may introduce `version: 2` as a separate validator; M2's validator does not handle multi-version dispatch.
- **`ValidationErrorCode`** is stable within M2 — F4 and downstream tools may key UX off codes. M3+ may add codes; removals require a contract amendment.
- **`Profile` type fields** are stable within M2. Field additions are allowed in M3+ via a `version: 2` migration; deletions or renames require a `version` bump.
- **`ValidationError.message`** is operator-readable text, not a contractual surface. Consumers MUST NOT key behavior off `message` content.
- **`ValidationError.path`** is a JSON Pointer per RFC 6901; the pointer format is part of the contract.
- **Hand-rolled validator** vs. external library: F1's contract reserves the right to swap the implementation, but the public surface (the function signature, the result shape, the error-code enum, the behavior contracts in this document) is invariant.

---

## Out-of-Contract — Explicit Non-Goals

These are documented here so consumers know not to rely on them:

- **Defensive deep-copy of valid input**: `result.value` may be the same reference as `input`. F2/F5 SHOULD treat `Profile` values as immutable.
- **Tracking line/column positions from the source YAML**: F1 receives an `unknown` and has no view of the source text. F4 must cross-reference `path` with F2's parse-position map for line/column diagnostics.
- **Suggested fixes** in `ValidationError.message`: messages may suggest fixes ("did you mean `envWhitelist`?") but the suggestions are not a stable contract.
- **Multi-profile validation**: F1 validates one profile per call. Cross-profile concerns (name uniqueness, dependency cycles) are F2/F4's domain.
- **YAML-specific quirks**: F1 does not see YAML tags, anchors, or comments. If F2's parser produces non-JSON-compatible values (e.g., `Date` instances from `!!timestamp` tags), F1's behavior is `WrongType` at the offending path.
- **Runtime enforcement of A7 `network.allowlist`**: F1 ships the declarative surface; F5 wires it into Docker. F1's contract does not constrain how F5 enforces.
- **`tools` semantic enforcement**: F1 ships the field unconsumed. M3+ will define the consumer and add enforcement logic — possibly as a separate validator pass.
- **Forward compatibility of `version: 2` documents seen by M2's validator**: not supported. A `version: 2` document produces `UnsupportedSchemaVersion`.
