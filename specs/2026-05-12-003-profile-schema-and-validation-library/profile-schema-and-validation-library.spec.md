# Feature Specification: Profile Schema and Validation Library

**Spec Folder**: `2026-05-12-003-profile-schema-and-validation-library`
**Branch**: `feature/smithy/mark/02-hatchery-f1`
**Created**: 2026-05-12
**Status**: Draft  |  **Implementation status (2026-05-16)**: **Not started** — spec drafted, no code. This spec is the first concrete piece of Stage B spec #1 (hatchery declarative profiles) in the RFC backlog. When implementation begins, F1 lands the schema + validator; F2–F6 follow per `02-hatchery.features.md`. The accelerated `src/hatchery/legate-container.ts` and `src/hatchery/spawn-config.ts` are the consumers that will migrate to profile-backed config in F5.

## Accelerated context (2026-05-16)

This spec was drafted on 2026-05-12. Three bootstrap changes have landed since then that affect downstream features (F2–F6) and add two new real consumers without invalidating the F1 schema itself:

1. **Codex is the second backend, not Gemini.** Codex uses a **credential-mount** auth pattern: the host's `CODEX_HOME` directory is bind-mounted read-only into the container at `/march/codex-auth` and copied into the in-container home at entrypoint time. This mount is a typed exception to "no host bind mounts ever" (A2/FR-009) and must be expressible in the schema. As written, F1's `FileMount` discriminated union admits only `named-volume` and `snapshot` — there is no variant for "backend-declared credential mount." See [SD-017](#specification-debt-2026-05-16-additions).
2. **The `pr-management` profile is the Steward's profile.** The Steward role — a Claude Code interactive session **hosted in Castra** (the interactive-sessions host) that handles review/test/commit/push/PR after a spawn — was named in the RFC on 2026-05-16. The `pr-management` profile this spec already accommodates is the same profile, consumed by the Castra-hosted Steward that `src/hatchery/spawn-handoff.ts` launches via the Castra HTTP API (not a directly-launched agent-deck session). No schema change needed; the fixture corpus (US8/FR-026) should name the fixture `steward.yaml` or alias it.
3. **A third real consumer exists: the Legate container.** `src/hatchery/legate-container.ts` ships an ad-hoc Hatchery profile for the `legate-agent` + `legate-loop` pair. F3 (default profile materialization) only seeds `spawn` and `pr-management`; a `legate` profile should be added as a third seeded shape to make the migration of `legate-container.ts` into the profile system a pure swap. See [SD-018](#specification-debt-2026-05-16-additions).

None of these invalidate the F1 schema's core shape (Profile identity, container security, resources, network policy, snapshot policy, A2/A3/A5/A7 structural enforcement). The Gemini references in this spec (none direct — all surface as "two backends" in F3 narrative and the `BackendCredentialMountSpec` absence) can be ignored or replaced by Codex in fixtures.

4. **Container-service split: profiles are consumed inside the Hatchery service.** Hatchery now runs as a containerized Fastify service (`march hatchery serve`); the `march hatchery` CLI verbs (incl. `validate` from F4) are thin HTTP clients. F1 remains a **pure library**, but its *consumer* is the Hatchery service process — profile resolution and validation at dispatch time (F5) run server-side, not in an in-process call on the operator's host. The profile schema is the **single declarative source** for container config across **all** roles — spawn, the Castra-hosted Steward (`pr-management`), Legate, and future roles — so no role gets a bespoke config path. The schema itself stays transport- and topology-agnostic (the `march` network and `MARCH_*_URL` addressing are the service's concern, not the schema's).


**Input**: `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md` — Milestone 2: Hatchery
**Source Feature Map**: `docs/rfcs/2026-001-march-orchestration-platform/02-hatchery.features.md` — Feature 1: Profile Schema and Validation Library

## Clarifications

### Session 2026-05-12

- _Schema version literal enforcement_: `version` accepts only the integer literal `1` in M2. Any other value (including string `"1"`) produces `UnsupportedSchemaVersion`. `[Critical Assumption]`
- _No host-path mount variant_: `FileMount` is a discriminated union of `named-volume` and `snapshot` only. A2 (no host bind mounts) is enforced **both** by the type system (no `host-path` variant in the `FileMount` union) **and** at runtime — the validator emits `UnknownDiscriminator` for unknown `kind` values per FR-009. `[Critical Assumption]`
- _envWhitelist is the exclusive env mechanism_: Profile schema has no inline `env: { KEY: value }` map and no `envFile` or `passthrough` field. A3 is structurally enforced — the only way to admit env vars into a sandbox is to name them in `envWhitelist`. `[Critical Assumption]`
- _M1 SpawnConfig fields map 1:1 onto Profile.container + Profile.resources_: `container = { capDrop, user, envWhitelist }`, `resources = { memoryLimit, cpuLimit, timeoutSeconds }`. M1's `networkMode` is replaced by `Profile.network.mode` (discriminated). F5 is a pure rename for six fields and a replacement for the seventh. `[Critical Assumption]`
- _`snapshot.exclude` remains `string[]`_: Per scout finding, the pattern format used by `src/snapshot.ts` — encoded in the exported `SNAPSHOT_EXCLUSION_PATTERNS` constant and consumed by the exported `isExcludedPath` predicate (with `createBuildContext` applying it internally via a private `compileExclusions` helper) — is `readonly string[]` distinguishing basename globs from directory patterns by trailing `/`. F1 preserves this representation rather than introducing structured pattern objects.
- _`BASE_IMAGE` migration target is `Profile.baseImage`_: The seeded `spawn` profile encodes `march-base:latest` (M1's `BASE_IMAGE` value from the `BASE_IMAGE` constant in `src/spawn-config.ts`) into its `baseImage` field. This is what allows F5 to delete `src/spawn-config.ts` outright (not just `SPAWN_CONFIG`).
- _`baseImage` accepts but does not require digest pinning_: Docker reference grammar `name[:tag][@digest]` is accepted; M2 does not enforce digest pinning.
- _`name` regex_: `^[a-z][a-z0-9-]{0,62}$` — lowercase ASCII start, alphanumerics and hyphens only, 1–63 chars. Matches both `spawn` and `pr-management` (the two F3-seeded profile names) and gives F2 a filesystem-safe filename.
- _`network` is required (no implicit `bridge` fallback)_: Every profile must declare its network posture explicitly. M1's known `bridge` gap is closed at the schema layer by forcing the operator to type the choice.
- _Validator is pure and never throws on `unknown` input_: All structural problems become `ValidationError` entries; the function accepts arrays, primitives, `null`, and non-objects without throwing.
- _Closed-world validation_: Any property name not in the schema at its location produces `UnknownField`. This is how A3 is enforced — unknown `env`/`envFile` keys cannot smuggle env vars past the whitelist.
- _Errors are aggregated, not first-fail_: Validator returns all errors in a single `ValidationError[]`, deterministically ordered by JSON-pointer path then by code.
- _`UnsupportedSchemaVersion` short-circuits other validation_: If `version` is missing or not `1`, the validator returns just the version error. Validating against an unknown schema shape would produce noise.
- _F1 takes `unknown` (already parsed); F2 owns YAML parsing_: The validator signature is `validateProfile(input: unknown)`. YAML→object conversion and parse-error surfacing are F2's responsibility.
- _`name` uniqueness across profiles is out of scope for F1_: The validator validates a single profile in isolation. Collision detection belongs to F2 (filesystem catalogue) / F4 (CLI registry).
- _`pr-management` profile shape needs no F1 schema changes_: Broader allowlist (`api.github.com`), broader envWhitelist (`GH_TOKEN`, `GITHUB_TOKEN`), and repo-snapshot file mounts are all expressible under the reconciled schema. F1 is data-content-agnostic.
- _No external schema validation library_: "Pure validator" plus closed-world / aggregated-errors / discriminated-union requirements imply hand-rolled validation. The codebase has no Zod/Ajv/Yup; F1 stays consistent.
- _`tools.allowed` and `tools.disallowed` overlap is `ToolOverlap`_: A tool name appearing in both lists is contradictory and rejected, rather than silently resolved.
- _`snapshot` is optional at root_: When present, `exclude` is required and `include` is optional. Absent `snapshot` means F2/F5 fall back to documented defaults (deferred to those features).
- _`SnapshotMustBeReadOnly`_: The `{ kind: "snapshot", target, readOnly: true }` literal-true makes mutable snapshots unrepresentable; the named error covers the case where an operator authors `readOnly: false` literally on a snapshot mount.

## Artifact Hierarchy

RFC → Milestone → Feature → User Story → Slice → Tasks

## User Scenarios & Testing

### User Story 1: Profile Type Skeleton and Validator Surface (Priority: P1)

As an F2/F4/F5 implementer, I want a single canonical `Profile` TypeScript type and a `validateProfile(unknown): ValidationResult` function exported from `src/profile/`, so that every downstream consumer agrees on what a profile is and how to check one.

**Why this priority**: Every other story builds on this surface. Without the exported types and the function signature, F2 cannot type its loader, F4 cannot type its CLI verbs, and F5 cannot type its rename. The skeleton also pins the discriminated `ValidationResult` shape that all later stories produce.

**Independent Test**: Import `Profile`, `validateProfile`, `ValidationError`, `ValidationErrorCode`, and `ValidationResult` from the profile module. A type-only test asserts each name resolves to a documented public type. A runtime test calls `validateProfile(null)` and `validateProfile("string")` and asserts both return `{ ok: false, errors: [...] }` without throwing.

**Acceptance Scenarios**:

1. **Given** the F1 library is built, **When** a consumer writes `import { Profile, validateProfile } from "./profile/index.js"`, **Then** both names resolve to the documented public API and the consumer can use `Profile` in type positions.
2. **Given** any non-object input (`null`, `42`, `"string"`, an array), **When** `validateProfile` is called with it, **Then** the function returns `{ ok: false, errors: [{ code: "WrongType", path: "", message: ... }] }` and does not throw.
3. **Given** a consumer wants to narrow on the result, **When** they branch on `result.ok`, **Then** TypeScript narrows `result.value` to `Profile` in the truthy arm and `result.errors` to `ValidationError[]` in the falsy arm.

---

### User Story 2: Identity, Version, and `baseImage` Validation (Priority: P1)

As a profile author, I want `version`, `name`, and `baseImage` to be required top-level fields with documented rules, so that every profile has a stable identity, the schema can evolve forward-compatibly, and the migration target for M1's `BASE_IMAGE` is explicit.

**Why this priority**: Identity gates every other rule — the validator cannot report "error in profile X" without `name`, cannot version-gate field additions without `version`, and cannot serve as F5's `BASE_IMAGE` migration target without `baseImage`. P1 because all other stories assume these fields exist.

**Independent Test**: A fixture with `version: 1`, `name: "spawn"`, and `baseImage: "march-base:latest"` validates. Mutating any of the three fields (missing, wrong type, malformed value) produces exactly one error whose `code` matches the documented enum entry for that field.

**Acceptance Scenarios**:

1. **Given** a profile with `version: 1`, `name: "spawn"`, `baseImage: "march-base:latest"`, **When** validated, **Then** the three identity fields pass and any downstream errors come from other sections only.
2. **Given** a profile with `version: 2` (or `"1"`, or missing), **When** validated, **Then** the result is `{ ok: false }` and the **only** error is `{ code: "UnsupportedSchemaVersion", path: "/version" }` — version errors short-circuit other validation.
3. **Given** a profile with `name: "Spawn"` (uppercase), `name: "1spawn"` (leading digit), or `name: ""`, **When** validated, **Then** an `InvalidName` error is produced at `/name`.
4. **Given** a profile with `baseImage: ""`, `baseImage: 42`, or `baseImage: "march base:latest"` (whitespace), **When** validated, **Then** an `InvalidImageReference` (or `WrongType`) error is produced at `/baseImage`.
5. **Given** a profile with `baseImage: "march-base:latest@sha256:0123abcd..."` (digest-pinned), **When** validated, **Then** the field passes (digest pinning is accepted but not required).

---

### User Story 3: Container Security and Resources are 1:1 with M1 SpawnConfig (Priority: P1)

As an F5 implementer, I want the seven M1 `SpawnConfig` fields to map to `Profile.container.{capDrop, user, envWhitelist}` and `Profile.resources.{memoryLimit, cpuLimit, timeoutSeconds}` with byte-identical value semantics, so that F5's refactor is a pure rename and the seeded `spawn` profile produces byte-identical `docker run` invocations to M1.

**Why this priority**: This is the load-bearing mechanical foundation for the entire M1→M2 migration. If any field's value semantics drift, F5's "byte-identical regression guarantee" breaks. P1 because every other security story (US4, US6) builds on the field shapes pinned here. M1's `networkMode` field is intentionally replaced by `network.mode` in US5, not migrated as-is.

**Independent Test**: Take the `SPAWN_CONFIG` constant exported from `src/spawn-config.ts`, copy its six retained field values verbatim into a fixture profile's `container` and `resources` blocks, run `validateProfile`, and assert `ok: true`. A type-only test asserts `Profile["container"] & Profile["resources"]` is structurally assignable to `Omit<SpawnConfig, "networkMode">`.

**Acceptance Scenarios**:

1. **Given** a profile with `container: { capDrop: ["ALL"], user: "march", envWhitelist: ["ANTHROPIC_API_KEY"] }` and `resources: { memoryLimit: "4g", cpuLimit: "2", timeoutSeconds: 3600 }`, **When** validated, **Then** the six fields pass (matching M1's `SPAWN_CONFIG` verbatim).
2. **Given** `container.capDrop: []` (does not contain `"ALL"`), **When** validated, **Then** `InvalidCapDrop` at `/container/capDrop` is produced.
3. **Given** `container.user` matching either `"march"` (username) or `"1000:1000"` (numeric uid:gid), **When** validated, **Then** the field passes; other strings produce `InvalidUser`.
4. **Given** `resources.memoryLimit` matching `^[0-9]+[bkmgBKMG]$`, `resources.cpuLimit` matching `^[0-9]+(\.[0-9]+)?$`, `resources.timeoutSeconds` a positive integer, **When** validated, **Then** the fields pass. Violations produce the per-field code (`InvalidMemoryLimit`, `InvalidCpuLimit`, `InvalidTimeout`).
5. **Given** a profile with a top-level `networkMode` field (legacy M1 shape), **When** validated, **Then** `UnknownField` at `/networkMode` is produced — the field has migrated to `network.mode` and is no longer recognized.

---

### User Story 4: A3 Structural Enforcement — `envWhitelist` is the Only Env Mechanism (Priority: P1)

As a security-conscious operator, I want the `Profile` type to provide **no** way to express inline environment variable values (no `env: { KEY: value }`, no `envFile`, no `passthrough` escape hatch), so that A3 is enforced by the schema's shape and not by a runtime check that could be bypassed by a parser bug or a schema extension.

**Why this priority**: A3 is one of the four Appendix A constraints the feature explicitly promises to enforce structurally. If the schema admits any alternative env mechanism — even one validated against — A3 enforcement is one validator-bug away from a credential leak. P1 because this is the canary for the "structurally impossible" claim that justifies F1's whole shape.

**Independent Test**: A type-only test asserts that `Extract<keyof Profile["container"], "env" | "envFile" | "environment" | "passthrough">` is `never`. A runtime test submits a profile with `container.env: { FOO: "bar" }` and asserts the validator produces `UnknownField` at `/container/env`.

**Acceptance Scenarios**:

1. **Given** a profile with `container.envWhitelist: ["ANTHROPIC_API_KEY"]` and no other env-related field, **When** validated, **Then** the `container` block passes for env purposes.
2. **Given** a profile that adds `container.env: { ANTHROPIC_API_KEY: "sk-..." }` or `container.envFile: ".env"`, **When** validated, **Then** the validator produces `UnknownField` at the offending path.
3. **Given** `container.envWhitelist: ["FOO=bar"]` (operator tries to inline a value), **When** validated, **Then** `InvalidEnvVarName` is produced — entries are env var **names** only; Docker reads each value from the operator's environment at launch.
4. **Given** `container.envWhitelist: []`, **When** validated, **Then** the field passes (operator may legitimately opt out of all passthrough — for example, a profile that runs an offline tool).

---

### User Story 5: A7 Network Policy is a Closed Allowlist with Structured Endpoints (Priority: P1)

As a security-conscious operator, I want `Profile.network` to be a discriminated union of `bridge`, `none`, and `allowlist` postures, where `allowlist` mode requires structured `NetworkEndpoint[]` entries, so that A7 enforcement at the schema layer is unambiguous and F5's Docker-layer translation has a well-typed input.

**Why this priority**: A7 is the second of the four Appendix A constraints. M1 ships `networkMode: "bridge"` as a documented gap; F1 closes the schema-level gap by forcing every profile to type its posture and to enumerate endpoints when network access is granted. P1 because F5's runtime enforcement depends on a stable F1 input shape.

**Independent Test**: A fixture with `network: { mode: "allowlist", allowlist: [{ host: "api.anthropic.com", port: 443, protocol: "https" }] }` validates. A fixture with `network: { mode: "allowlist" }` (missing `allowlist`) is rejected with `EmptyAllowlist`. A fixture with `network: { mode: "bridge", allowlist: [...] }` is rejected with `UnknownField` (allowlist is only meaningful under `mode: "allowlist"`).

**Acceptance Scenarios**:

1. **Given** `network: { mode: "bridge" }`, **When** validated, **Then** the field passes (M1-equivalent posture, available for the seeded `spawn` profile's byte-identical replay).
2. **Given** `network: { mode: "none" }`, **When** validated, **Then** the field passes (strictest A7 posture — no outbound traffic).
3. **Given** `network: { mode: "allowlist", allowlist: [{ host: "api.anthropic.com", port: 443, protocol: "https" }] }`, **When** validated, **Then** the field passes.
4. **Given** `network: { mode: "allowlist" }` (no `allowlist` array) or `network: { mode: "allowlist", allowlist: [] }`, **When** validated, **Then** `EmptyAllowlist` at `/network/allowlist` is produced.
5. **Given** `network: { mode: "bridge", allowlist: [...] }` (allowlist outside its discriminator), **When** validated, **Then** `UnknownField` at `/network/allowlist` is produced.
6. **Given** an endpoint with `host: "http://foo"` (URL-shaped), `port: 0` or `port: 99999`, or `protocol: "smtp"`, **When** validated, **Then** the per-field code (`InvalidHost`, `InvalidPort`, `InvalidProtocol`) is produced.

---

### User Story 6: A2/A5 — File Mounts and Snapshot Policy Enforce Threat Model Structurally (Priority: P1)

As a security-conscious operator, I want `Profile.fileMounts` to be a closed discriminated union admitting only `named-volume` and `snapshot` variants (no `host-path` kind), and `Profile.snapshot.exclude` to remain a `string[]` whose entries match the pattern format that `src/snapshot.ts`'s exported `SNAPSHOT_EXCLUSION_PATTERNS` and `isExcludedPath` already use, so that A2 (no host bind mounts) is enforced by type and A5 (snapshot include/exclude) wires straight into M1's existing pattern engine without translation.

**Why this priority**: A2 and A5 are the third and fourth Appendix A constraints. A2 is the most consequential — a misconfigured bind mount exposes the host filesystem to an LLM agent — and the only way to make it structurally impossible is to omit the variant from the type. A5's `string[]` shape compat resolves a load-bearing scout-flagged conflict: any other representation forces F5 to translate, invalidating the pure-rename claim. P1 for both.

**Independent Test**: A type-only test asserts `Extract<FileMount, { kind: "host-path" }>` is `never`. A runtime test submits a profile with `fileMounts: [{ kind: "host-bind", source: "/etc", target: "/etc" }]` and asserts `UnknownDiscriminator` at `/fileMounts/0/kind`. A second runtime test submits a profile whose `snapshot.exclude` is the exact M1 `SNAPSHOT_EXCLUSION_PATTERNS` array (with `.secrets/` trailing slash) and asserts `ok: true` and that the returned `value.snapshot.exclude` is reference-equal-to-input or value-identical, preserving trailing slashes verbatim.

**Acceptance Scenarios**:

1. **Given** `fileMounts: [{ kind: "named-volume", name: "march-cache", target: "/cache", readOnly: false }]`, **When** validated, **Then** the entry passes.
2. **Given** `fileMounts: [{ kind: "snapshot", target: "/workspace", readOnly: true }]`, **When** validated, **Then** the entry passes.
3. **Given** `fileMounts: [{ kind: "snapshot", target: "/workspace", readOnly: false }]`, **When** validated, **Then** `SnapshotMustBeReadOnly` at `/fileMounts/0/readOnly` is produced.
4. **Given** `fileMounts: [{ kind: "host-path", source: "/etc/passwd", target: "/host-etc" }]`, **When** validated, **Then** `UnknownDiscriminator` at `/fileMounts/0/kind` is produced — `host-path` is not a recognized `FileMount.kind`.
5. **Given** `fileMounts: []`, **When** validated, **Then** the field passes (empty mount list is a valid baseline; the M1-equivalent `spawn` profile may legitimately have no runtime mounts because its snapshot is baked into the image, not mounted).
6. **Given** `snapshot.exclude: [".env", ".env.*", "*.pem", "*.key", ".secrets/", "credentials.json"]` (M1 values verbatim), **When** validated, **Then** the field passes and the returned value is structurally compatible with `compileExclusions(patterns)` — basename globs and trailing-slash directory entries are preserved as raw strings.
7. **Given** `snapshot.exclude: ["/absolute/path"]` or `snapshot.exclude: ["../escape"]`, **When** validated, **Then** the per-pattern error (`InvalidMountTarget`-class — exact code resolved per [SD-006](#specification-debt)) is produced.

---

### User Story 7: Optional `tools` Policy, Shipped But Unconsumed (Priority: P2)

As a forward-looking profile author, I want `tools: { allowed?: string[]; disallowed?: string[] }` to be an optional top-level field that the schema validates for shape (and rejects overlap), even though M2 has no runtime consumer for it, so that M3+ enforcement can land without a schema-version bump.

**Why this priority**: P2 because no M2 consumer reads it — F5 will explicitly ignore the field at dispatch time. But shipping the field now avoids a `version: 2` migration when an M3+ component arrives that does honor it.

**Independent Test**: Three fixtures — `tools` absent, `tools: { allowed: ["Bash"] }`, and `tools: { allowed: ["Bash"], disallowed: ["Bash"] }` — produce the expected outcomes (pass, pass, `ToolOverlap`).

**Acceptance Scenarios**:

1. **Given** a profile with `tools` absent, **When** validated, **Then** the result passes.
2. **Given** `tools: { allowed: ["Bash", "Read"], disallowed: ["WebFetch"] }`, **When** validated, **Then** the result passes.
3. **Given** `tools: { allowed: ["Bash"], disallowed: ["Bash"] }` (a tool in both lists), **When** validated, **Then** `ToolOverlap` at `/tools` (with the offending tool name in the message) is produced.
4. **Given** `tools: { allowed: [42] }` (non-string entry), **When** validated, **Then** `WrongType` at `/tools/allowed/0` is produced.
5. **Given** `tools: { allowed: [] }` or `tools: {}`, **When** validated, **Then** the result passes (empty or absent inner lists are valid).

---

### User Story 8: Profile Fixture Corpus as Schema Documentation (Priority: P2)

As an F4 CLI developer, an F5 refactorer, and a profile author, I want a curated set of valid and invalid YAML profile fixtures in `tests/fixtures/profile/`, each invalid fixture paired with its expected `ValidationError[]`, so that the corpus simultaneously documents the schema, serves as the integration test suite for `march hatchery validate`, and exercises every named `ValidationErrorCode`.

**Why this priority**: P2 because the corpus is build-time, not runtime. But it is what makes the schema knowable to humans (a YAML reader is more digestible than a TypeScript type) and what guarantees the named error codes stay live as the validator evolves.

**Independent Test**: A test enumerates every fixture under `tests/fixtures/profile/valid/` and asserts `validateProfile(parse(yaml))` returns `ok: true`. A second test enumerates `tests/fixtures/profile/invalid/` and asserts the produced `errors.map(e => e.code)` matches the sidecar `.expected.json` for each fixture. A third test asserts every `ValidationErrorCode` variant is exercised by at least one invalid fixture.

**Acceptance Scenarios**:

1. **Given** the `tests/fixtures/profile/valid/m1-spawn-parity.yaml` fixture, **When** validated, **Then** the result is `{ ok: true }` and its `container` + `resources` values are byte-identical to M1's `SPAWN_CONFIG`.
2. **Given** any invalid fixture, **When** validated, **Then** `result.errors.map(e => e.code)` equals the expected-codes list in the fixture's sidecar `.expected.json`.
3. **Given** the entire invalid-fixtures directory, **When** the per-code coverage check runs, **Then** every `ValidationErrorCode` variant is exercised by at least one fixture.
4. **Given** the `tests/fixtures/profile/valid/pr-management-shape.yaml` fixture (broader `envWhitelist` for `GH_TOKEN`/`GITHUB_TOKEN`, `network.allowlist` with `api.github.com`, repo-snapshot file mount), **When** validated, **Then** the result is `{ ok: true }` — confirming F1's schema accommodates F3's second seeded profile without changes.

---

### Edge Cases

- **Non-object root input** (`null`, primitive, array): validator returns `{ ok: false, errors: [{ code: "WrongType", path: "" }] }` without crashing.
- **`version` is missing or wrong**: validator short-circuits and returns only `UnsupportedSchemaVersion`; it does not produce a flood of unrelated errors from a schema the input is not claiming to conform to.
- **Multiple unknown top-level fields**: each produces a separate `UnknownField` so the operator gets a complete typo list in one pass.
- **`snapshot` absent**: the field is optional; absence is valid. F2/F5 fall back to documented defaults (their concern, not F1's).
- **`network: { mode: "allowlist", allowlist: [] }`**: empty allowlist in `allowlist` mode is rejected with `EmptyAllowlist`; the operator should use `mode: "none"` to express "no outbound traffic."
- **`envWhitelist: []`**: empty is valid — the M1 default has `["ANTHROPIC_API_KEY"]` but a tools-only profile may legitimately need no env passthrough.
- **Duplicate `fileMounts` entries** (two mounts with same `target`): out of scope for F1's structural validation — recorded as [SD-006](#specification-debt) for resolution alongside `InvalidMountTarget` semantics.
- **Container resource limit upper bounds** (`timeoutSeconds: 86400`): F1 requires positive integer but enforces no upper bound — operational sanity belongs to F4/F5.
- **`baseImage` with no tag** (`"march-base"`): accepted — Docker reference grammar permits bare names (implicit `:latest`). No warning issued in F1.
- **Profile with a single unrecognized discriminator on `network`** (e.g., `network: { mode: "host" }`): produces `UnknownDiscriminator` at `/network/mode` so the error matches the `FileMount.kind` family.

## Dependency Order

Recommended implementation sequence:

| ID  | Title                                                             | Depends On      | Artifact |
|-----|-------------------------------------------------------------------|-----------------|----------|
| US1 | Profile Type Skeleton and Validator Surface                       | —               | specs/2026-05-12-003-profile-schema-and-validation-library/01-profile-type-skeleton-and-validator-surface.tasks.md |
| US2 | Identity, Version, and `baseImage` Validation                     | US1             | specs/2026-05-12-003-profile-schema-and-validation-library/02-identity-version-and-baseimage-validation.tasks.md |
| US3 | Container Security and Resources are 1:1 with M1 SpawnConfig      | US1             | specs/2026-05-12-003-profile-schema-and-validation-library/03-container-security-and-resources-are-1-1-with-m1-spawnconfig.tasks.md |
| US4 | A3 Structural Enforcement — `envWhitelist` is the Only Env Mechanism | US1, US3     | specs/2026-05-12-003-profile-schema-and-validation-library/04-a3-structural-enforcement-envwhitelist-is-the-only-env-mechanism.tasks.md |
| US5 | A7 Network Policy is a Closed Allowlist with Structured Endpoints | US1             | specs/2026-05-12-003-profile-schema-and-validation-library/05-a7-network-policy-is-a-closed-allowlist-with-structured-endpoints.tasks.md |
| US6 | A2/A5 — File Mounts and Snapshot Policy Enforce Threat Model      | US1             | specs/2026-05-12-003-profile-schema-and-validation-library/06-a2-a5-file-mounts-and-snapshot-policy-enforce-threat-model-structurally.tasks.md |
| US7 | Optional `tools` Policy, Shipped But Unconsumed                   | US1             | specs/2026-05-12-003-profile-schema-and-validation-library/07-optional-tools-policy-shipped-but-unconsumed.tasks.md |
| US8 | Profile Fixture Corpus as Schema Documentation                    | US2, US3, US4, US5, US6, US7 | — |

US2–US7 are pairwise independent once US1 lands, so the bulk of the implementation work can begin in parallel. US8 is sequenced last because the corpus codifies the rule IDs that US2–US7 settle.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST export `Profile`, `validateProfile`, `ValidationResult`, `ValidationError`, and `ValidationErrorCode` from a single profile module (suggested `src/profile/index.ts`).
- **FR-002**: `validateProfile(input: unknown): ValidationResult` MUST be a synchronous, pure function: no I/O, no `Date.now()`, no `Math.random()`, no environment reads, no module-scoped mutable state.
- **FR-003**: `validateProfile` MUST never throw for any value of `input` (including `null`, primitives, arrays, and objects with circular references that may appear via parser bugs); structural problems become `ValidationError` entries.
- **FR-004**: `validateProfile` MUST aggregate all errors discovered in a single pass and return them in a single `errors: ValidationError[]` (no first-fail short-circuit), with one exception: an `UnsupportedSchemaVersion` error short-circuits all other validation and is returned alone.
- **FR-005**: `validateProfile` MUST emit one `UnknownField` per unrecognized property at every object level (root `Profile`, `container`, `resources`, each `FileMount` entry — including its variant-specific fields, `snapshot`, `network` and each of its discriminated variants, each `NetworkEndpoint`, and `tools`).
- **FR-006**: Each `ValidationError` MUST carry `{ code: ValidationErrorCode, path: string, message: string }` where `path` is an RFC-6901-style JSON pointer into the original input (empty string for root).
- **FR-007**: The returned `errors[]` MUST be deterministically ordered: by JSON-pointer lexicographic order first, then by `code` lexicographic order — so snapshot tests are stable across runs.
- **FR-008**: The `Profile` type MUST NOT contain any property at any nesting that admits inline env var values (no `env`, no `envFile`, no `environment`, no `passthrough`). The only env mechanism is `container.envWhitelist: string[]` listing variable names that Docker reads from the operator's environment at launch.
- **FR-009**: The `FileMount` type MUST be a discriminated union over `kind` admitting exactly `"named-volume"` and `"snapshot"`; no `"host-path"`, `"host-bind"`, `"bind"`, or any other variant exists. Unknown discriminators MUST produce `UnknownDiscriminator` errors.
- **FR-010**: The `SnapshotMount` variant MUST require `readOnly: true` as a literal-typed field. A `SnapshotMount` with `readOnly: false` MUST produce `SnapshotMustBeReadOnly`.
- **FR-011**: The `snapshot.exclude` field MUST be `string[]` so the array can be fed unchanged into the exclusion-matching logic in `src/snapshot.ts` (the exported `isExcludedPath` predicate and `createBuildContext` function, whose private `compileExclusions` helper interprets each pattern). Pattern entries are not interpreted by F1's validator; only structural type (string) and basic shape (non-empty, no absolute paths, no `..` traversals) are checked.
- **FR-012**: The `NetworkPolicy` type MUST be a discriminated union over `mode` admitting exactly `"bridge"`, `"none"`, and `"allowlist"`. The `"allowlist"` discriminator MUST require a non-empty `allowlist: NetworkEndpoint[]`; the `"bridge"` and `"none"` discriminators MUST NOT admit an `allowlist` field.
- **FR-013**: `NetworkEndpoint` MUST consist of `{ host: string, port: number, protocol: "http" | "https" | "tcp" }`. Schemes in `host` are forbidden; protocol carries that information.
- **FR-014**: `Profile.version` MUST accept only the literal integer `1` in M2. Any other value (including `"1"` as a string) MUST produce `UnsupportedSchemaVersion`.
- **FR-015**: `Profile.name` MUST match `^[a-z][a-z0-9-]{0,62}$`. Violations MUST produce `InvalidName`.
- **FR-016**: `Profile.baseImage` MUST match Docker reference grammar admitting `name[:tag][@digest]`. Bare names default to `:latest` per Docker convention; digest pinning is accepted but not required. Empty strings MUST produce `InvalidImageReference`.
- **FR-017**: `container.capDrop: string[]` MUST contain the literal string `"ALL"` (the comparison is case-sensitive, so `"all"` or `"All"` would not satisfy the rule — Docker's flag grammar requires uppercase). Absence produces `InvalidCapDrop`.
- **FR-018**: `container.user: string` MUST match a documented username-or-uid grammar. The precise grammar (including whether symbolic `user:group` forms like `"march:march"` are admitted) is resolved by [SD-007](#specification-debt); violations produce `InvalidUser`.
- **FR-019**: `container.envWhitelist: string[]` MUST contain entries matching POSIX env var name grammar `^[A-Z_][A-Z0-9_]*$`. Inline values (`"FOO=bar"`) MUST produce `InvalidEnvVarName`. An empty array is valid.
- **FR-020**: `resources.memoryLimit: string` MUST match Docker memory grammar `^[0-9]+[bkmgBKMG]$`. Violations produce `InvalidMemoryLimit`.
- **FR-021**: `resources.cpuLimit: string` MUST match positive-number grammar `^[0-9]+(\.[0-9]+)?$`. Violations produce `InvalidCpuLimit`.
- **FR-022**: `resources.timeoutSeconds: number` MUST be a positive integer. Violations produce `InvalidTimeout`.
- **FR-023**: `tools` (optional) MUST consist of `{ allowed?: string[], disallowed?: string[] }` (matching the feature map's canonical naming). A tool name appearing in both arrays MUST produce `ToolOverlap`. Empty inner arrays and an absent `tools` field are valid.
- **FR-024**: M1's `SpawnConfig` field semantics MUST be preserved 1:1 for the six retained fields (`capDrop`, `user`, `memoryLimit`, `cpuLimit`, `timeoutSeconds`, `envWhitelist`), in `Profile.container` and `Profile.resources`. M1's `networkMode` field is replaced by `Profile.network.mode`.
- **FR-025**: The `BASE_IMAGE` constant exported from `src/spawn-config.ts` (`"march-base:latest"`) is explicitly designated as the migration target for `Profile.baseImage`. F5 may delete the entire `src/spawn-config.ts` module after migrating both `SPAWN_CONFIG` and `BASE_IMAGE` into the seeded `spawn` profile.
- **FR-026**: F1 MUST ship a fixture corpus at `tests/fixtures/profile/`: at least one valid fixture for each documented profile shape (`m1-spawn-parity.yaml`, `pr-management-shape.yaml`) and at least one invalid fixture for each `ValidationErrorCode`. Each invalid fixture MUST have a sidecar `.expected.json` listing the expected error codes.

### Key Entities

- **Profile**: top-level entity; the declarative description of a container's posture. Contains identity (`version`, `name`), image (`baseImage`), security (`container`), resources (`resources`), mounts (`fileMounts`), snapshot policy (`snapshot?`), network policy (`network`), and optional tools (`tools?`).
- **ContainerSecurity** (`Profile.container`): the security-posture block holding `capDrop`, `user`, and `envWhitelist`. Maps 1:1 onto the security half of M1's `SpawnConfig`.
- **ResourceLimits** (`Profile.resources`): the resource-ceiling block holding `memoryLimit`, `cpuLimit`, and `timeoutSeconds`. Maps 1:1 onto the resource half of M1's `SpawnConfig`.
- **FileMount**: closed discriminated union of `NamedVolumeMount` and `SnapshotMount`. No host-path variant exists — A2 structural enforcement.
- **SnapshotPolicy** (`Profile.snapshot?`): include/exclude pattern lists for the build-context snapshot. `exclude` shape is `string[]` for compatibility with `compileExclusions`.
- **NetworkPolicy** (`Profile.network`): closed discriminated union over `mode` admitting `"bridge"`, `"none"`, and `"allowlist"`. The `"allowlist"` discriminator carries structured `NetworkEndpoint` entries.
- **NetworkEndpoint**: `{ host, port, protocol }` triple. Host is a name or IP literal; scheme is carried by `protocol`, not embedded in `host`.
- **ToolsPolicy** (`Profile.tools?`): optional `{ allowed?, disallowed? }` lists. Shipped in M2 but no M2 runtime consumer.
- **ValidationError**: a single structural problem. Carries `code` (named enum), `path` (JSON pointer), `message` (human-readable diagnostic).
- **ValidationResult**: discriminated union of `{ ok: true, value: Profile }` and `{ ok: false, errors: readonly ValidationError[] }`. Lets consumers narrow without exception handling.

## Assumptions

- M2 ships exactly one profile schema version (`version: 1`). M3+ may introduce `version: 2` as a separate validator; M2 makes no commitment to forward-compat at the schema-version level.
- F2 owns YAML parsing and surfaces parse errors before invoking `validateProfile`. F1 sees only already-parsed `unknown` values.
- F4 (CLI) is the primary human consumer of `ValidationError.message`. The message strings should be operator-readable but their exact wording is not part of the public API contract.
- F5 will migrate both `SPAWN_CONFIG` and `BASE_IMAGE` out of `src/spawn-config.ts` into the seeded `spawn` profile. F1's `Profile.baseImage` field is the explicit migration target.
- `compileExclusions` in `src/snapshot.ts:86` is treated as a stable consumer surface. F1's `snapshot.exclude` is `string[]` precisely to feed it without translation. F5 may relocate `compileExclusions` but is not required to change its signature.
- `pr-management` profile shape (broader allowlist, broader envWhitelist, repo-snapshot mount) is fully expressible under the reconciled schema. F1 imposes no profile-content constraints beyond structural validity.
- The codebase has no schema-validation library dependency, and the F1 validator is hand-rolled. Operators preferring Zod-/Ajv-style schema authoring would write a separate transformer; F1 ships the validator that downstream Hatchery features rely on.
- M1's `networkMode: "bridge"` gap (documented in the M1 spec) is closed at the M2 schema layer by forcing every profile to declare network posture explicitly; runtime enforcement of `mode: "allowlist"` is F5's concern.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | `snapshot.include` semantics in M2 are ambiguous. Three readings: (a) allowlist — only listed paths plus the rest of the worktree minus `exclude`; (b) additive — explicitly add otherwise-excluded paths back; (c) advisory — accepted by schema, ignored by F2/F5 in M2 with M3 to define. Recommended lean: (c) — F1 accepts `include` as `string[]` of patterns mirroring `exclude` shape; downstream consumers in M2 ignore it. Resolution should land before F5 starts so the seeded `spawn` profile doesn't accidentally rely on either of (a) or (b). | clarify:Domain & Data Model | Medium | Medium | open | — |
| SD-002 | `NetworkEndpoint.host` grammar is unspecified. Three readings: (a) RFC 1123 hostname only; (b) hostname + IPv4 literal; (c) hostname + IPv4 + IPv6 + CIDR. Recommended lean: (b) — F1 accepts hostnames and IPv4 literals, rejects IPv6 and CIDR in M2 with a TODO for M3+. `pr-management` profile only needs hostnames (`api.github.com`); operator may want CIDR for self-hosted endpoints. | clarify:Domain & Data Model | High | Medium | open | — |
| SD-003 | `NetworkEndpoint.port` range and special-case semantics. Recommended lean: positive integer 1–65535, no wildcard. Operator may want "all ports for this host" via `port: 0` for future profiles; M2 does not support that. | clarify:Domain & Data Model | Medium | Medium | open | — |
| SD-004 | `UnknownField` granularity — one error per unknown key (more actionable) vs. one error per parent path with a `keys: string[]` field (less noise for multi-typo profiles). Recommended lean: one per key. | clarify:Edge Cases | Low | Medium | open | — |
| SD-005 | Error-code stability commitment — are the `ValidationErrorCode` strings a public API surface within M2 (F4 CLI keys UX off them, downstream tools may match) or internal? Recommended lean: stable within M2, may extend in M3+. Operator's call. | clarify:Constraints | Medium | Medium | open | — |
| SD-006 | `FileMount.target` and `snapshot.exclude` pattern validation rules. Open questions: must `target` be absolute? Forbid `..` traversal? Forbid root `/`? Forbid host-sensitive paths like `/etc`/`/proc`? `InvalidMountTarget` code is in the error enum but its trigger conditions are unspecified. Recommended lean: require absolute POSIX `target`, reject `..` segments, reject empty/root; reject absolute paths and `..` segments in `snapshot.exclude` entries; no host-path denylist at F1 (runtime concern). | clarify:Edge Cases | High | Medium | open | — |
| SD-007 | `container.user` regex precise grammar. Proposed `^([a-z_][a-z0-9_-]{0,31}|[0-9]+(:[0-9]+)?)$`. Open question: does Docker accept `user:group` symbolic forms (e.g., `"march:march"`)? Recommended lean: accept symbolic `user:group` as an extension (`^([a-z_][a-z0-9_-]{0,31}(:[a-z_][a-z0-9_-]{0,31})?|[0-9]+(:[0-9]+)?)$`). | clarify:Domain & Data Model | Medium | Medium | open | — |
| SD-008 | `resources.memoryLimit` and `cpuLimit` grammar tightness. Proposed: memory `^[0-9]+[bkmgBKMG]$`, cpu `^[0-9]+(\.[0-9]+)?$`. Open question: should Docker's wider grammar (`"4GB"`, `"4 GiB"`, `"1.5"`) be accepted? Recommended lean: tight grammar matching M1 verbatim; if operator wants flexibility later, widen in M3+. | clarify:Domain & Data Model | Medium | Medium | open | — |
| SD-009 | `envWhitelist` entry grammar — POSIX strict (`[A-Z_][A-Z0-9_]*`) or laxer (allow lowercase, allow leading digit, etc.)? Recommended lean: POSIX strict; pr-management's `GH_TOKEN`/`GITHUB_TOKEN` fit, and stricter grammar makes typos discoverable. | clarify:Terminology | Medium | Medium | open | — |
| SD-010 | `capDrop` entry validation — is the set checked against documented Linux capability names (CAP_* + `"ALL"`), or is any uppercase string accepted? Recommended lean: validate against the documented capability set with case-sensitive `"ALL"` exception; protects against typos like `"NETWORK"` for `"NET_ADMIN"`. Operator may prefer forward-compatible "accept anything" stance. | clarify:Edge Cases | Medium | Medium | open | — |
| SD-011 | `timeoutSeconds` upper bound. M1 hardcodes `3600`. Should F1 enforce a max (e.g., 24h)? Recommended lean: no upper bound in F1; operational sanity is F2/F4/F5's concern. | clarify:Non-Functional Quality | Low | Medium | open | — |
| SD-012 | Performance budget for `validateProfile`. No latency/input-size constraint stated. F4 CLI validates ~1KB YAML — academic; US8 fixture-corpus testing batches validation — slightly more concrete. Recommended lean: target O(n) in input size, no specific budget, no DoS hardening on input size in F1. | clarify:Non-Functional Quality | Low | Medium | open | — |
| SD-013 | `UnknownField` granularity is asserted as one-error-per-key in FR-005 and the Edge Cases section, but SD-004 still treats the granularity question as open. The artifacts have pre-adopted the leaning resolution. Either close SD-004 (one-per-key, matching FR-005) or soften FR-005 and the Edge Cases bullet to defer to SD-004. Operator decision needed for which way to consolidate. | plan-review:Assumption-output drift | Important | Low | open | — |
| SD-014 | `NetworkEndpoint.host` grammar in data-model entity 7 ("DNS-resolvable hostname (RFC 1123) or IPv4 literal. CIDR and IPv6 deferred") asserts the lean-(b) resolution of SD-002 as definitive, while SD-002 itself remains open. Either close SD-002 with lean-(b) or soften entity 7's `host` row to defer the grammar to SD-002. | plan-review:Assumption-output drift | Important | Low | open | — |
| SD-015 | `NetworkEndpoint.port` range (`[1, 65535]`, no wildcards) is asserted in data-model entities 7 and 11 as definitive while SD-003 remains open. Either close SD-003 with the asserted resolution or soften entities 7 and 11 to defer to SD-003. | plan-review:Assumption-output drift | Important | Low | open | — |
| SD-016 | `ValidationErrorCode` is asserted as a public-API surface (data-model entity 11 and contracts "Contract Stability and Versioning" section) while SD-005 still marks the stability question as open. Either close SD-005 with the asserted resolution (codes stable within M2, extensible in M3+) or soften the data model and contracts to defer to SD-005. | plan-review:Assumption-output drift | Important | Low | open | — |

### Specification Debt — 2026-05-16 additions

These items track schema gaps surfaced by the bootstrap acceleration (see [Accelerated context](#accelerated-context-2026-05-16)).

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-017 | Codex's credential-mount auth (`/march/codex-auth → CODEX_HOME`, read-only host-source bind) is not expressible under F1's current `FileMount` union (`named-volume` + `snapshot` only). Two viable resolutions: (a) introduce a third `FileMount` variant `credential-mount` with required `source: { fromBackend: string }` so the host source path is *not* operator-authored (operator names a backend; the backend declares the path), preserving A2's "no operator-authored host paths" guarantee; (b) keep `FileMount` closed and locate credential mounts on the `SpawnBackend` interface in the multi-backend spec, treating them as backend-attached not profile-attached. Recommended lean: (b) — credential mounts are intrinsically per-backend (like `requiredEnvVars`), not per-profile, so they belong on the backend interface and the profile-validator stays clean. The "no host bind mounts" structural guarantee remains schema-level; backend credential mounts are a declared exception evaluated at launch composition. This satisfies operating-philosophy [rule 2 (minimum required access, not zero)](../../docs/operating-philosophy.md#2-minimum-required-access-not-zero-access): the access is peeled back through a **typed interface field** (`BackendCredentialMountSpec` on `SpawnBackend`), backend-declared rather than operator-authored — option (b) does not weaken that guarantee, it relocates the typed field from the profile to the backend interface. F4 (Spawn Sandbox Security) US5's bind-mount validator must admit this typed exception. | clarify:Domain & Data Model | Critical | Medium | open | — |
| SD-018 | F3 (default profile materialization) seeds `spawn` and `pr-management`. The accelerated `src/hatchery/legate-container.ts` constitutes a *third* real profile (the Legate container) whose ad-hoc config should migrate into the profile system to avoid two paths for hatchery profiles. Recommended lean: extend F3's seed list to include a `legate` profile and migrate `legate-container.ts` to read its config from there in the Stage B "brood lifecycle CLI" spec (RFC backlog #3). F1 imposes no constraint here — `legate` is data, not schema. Logged on F1 so F3 picks it up. | clarify:Feature Boundaries / Scope Within the Milestone | Important | Medium | open | — |
| SD-019 | The `pr-management` profile is the Steward profile (named 2026-05-16). The fixture corpus (FR-026/SC-006) should reflect the role name. Recommended lean: keep `pr-management` as the profile *name* (it's the workflow, not the role) and add a comment/sidecar mapping it to the Steward role. Operator may prefer renaming the profile to `steward`; that's a content decision, not an F1 schema decision. | clarify:Terminology | Low | Medium | open | — |

## Out of Scope

- **YAML parsing**: F2 owns conversion from on-disk YAML to in-memory `unknown`. F1 only sees parsed values.
- **Filesystem layout** (where profiles live, profile discovery, profile-name-to-file resolution): F2.
- **CLI verbs** (`march hatchery list/inspect/validate`): F4. F1 ships the validator that F4 calls.
- **Default profile content**: F3 (`march init` materializes `spawn` and `pr-management` YAML files).
- **Spawn dispatch consumption** (reading a resolved profile to configure `docker run`, including A7 runtime enforcement of `network.allowlist`): F5.
- **Hatchery skills** (operator-facing documentation of profile workflows, PR-management skill set): F6.
- **`tools` field runtime enforcement**: deferred to M3+ — F1 validates shape only.
- **Repo-local profile overrides** and **precedence layering** between `~/.march/profiles/` and a repo-checked-in directory: deferred beyond M2.
- **Profile authoring UX, interactive editing, or scaffolding commands**: out of scope for M2 — the operator's text editor is the authoring UX per the RFC's "declarative, version-controlled, editable files" stance.
- **Profile-name uniqueness across the profile directory**: F2/F4. F1 validates one profile in isolation.
- **Schema-version migration tooling** (`version: 1` → `version: 2`): out of scope; M3+ will introduce a parallel validator if needed.
- **JSON Schema, OpenAPI, or any external schema-spec export**: out of scope; the TypeScript types and the validator's named-rule corpus are the spec.

## Success Criteria

### Measurable Outcomes

- **SC-001**: `validateProfile` is a pure function — verified by a test that runs it 100 times on the same input and asserts byte-identical `ValidationResult` output each time, and a code-review check that the validator's transitive imports do not include `fs`, `child_process`, `path`, or any other I/O primitive.
- **SC-002**: M1's `SpawnConfig` shape can be encoded into a valid profile without loss — verified by a fixture (`tests/fixtures/profile/valid/m1-spawn-parity.yaml`) whose `container` and `resources` blocks carry M1's `SPAWN_CONFIG` values verbatim and whose validator output is `ok: true`.
- **SC-003**: M1's `SNAPSHOT_EXCLUSION_PATTERNS` array is acceptable as `Profile.snapshot.exclude` without modification — verified by a fixture that uses the exact M1 array (`[".env", ".env.*", "*.pem", "*.key", ".secrets/", "credentials.json"]`) and an assertion that the validator preserves the strings verbatim (trailing slashes intact).
- **SC-004**: Every named `ValidationErrorCode` is exercised by at least one invalid fixture — verified by US8's coverage check.
- **SC-005**: A profile attempting to express a host-bind mount, an inline env value, or a network allowlist outside `mode: "allowlist"` is rejected by the schema's shape (TypeScript) AND by the runtime validator (with `UnknownDiscriminator`, `UnknownField`, or `UnknownField` respectively) — verified by three structural-enforcement fixtures in US6/US4/US5.
- **SC-006**: The `pr-management` profile shape (broader envWhitelist for `GH_TOKEN`/`GITHUB_TOKEN`, `network.allowlist` including `api.github.com`, repo-snapshot mount) is expressible without F1 schema changes — verified by `tests/fixtures/profile/valid/pr-management-shape.yaml` returning `ok: true`.
- **SC-007**: F1 ships zero new runtime dependencies — verified by a `package.json` diff check that no new entries appear in `dependencies` after F1 lands.
- **SC-008**: The validator returns aggregated errors deterministically — verified by a test that submits a profile with 5+ distinct violations and asserts the returned `errors[]` is in JSON-pointer-then-code order across two runs.
