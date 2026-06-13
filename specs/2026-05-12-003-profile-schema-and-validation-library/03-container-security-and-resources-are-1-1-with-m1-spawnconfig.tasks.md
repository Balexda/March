# Tasks: Container Security and Resources are 1:1 with M1 SpawnConfig

**Source**: `specs/2026-05-12-003-profile-schema-and-validation-library/profile-schema-and-validation-library.spec.md` — User Story 3
**Data Model**: `specs/2026-05-12-003-profile-schema-and-validation-library/profile-schema-and-validation-library.data-model.md`
**Contracts**: `specs/2026-05-12-003-profile-schema-and-validation-library/profile-schema-and-validation-library.contracts.md`
**Story Number**: 03

---

## Slice 1: Validate SpawnConfig Parity Fields
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Extend `src/profile/` so the container security and resource-limit fields validate with the same value semantics as the retained M1 `SpawnConfig` fields.

**Justification**: This slice is a standalone increment because F5 implementers can validate the six retained M1 values through `Profile.container` and `Profile.resources`, while legacy `networkMode` is explicitly rejected as migrated out of the M1 shape.

**Addresses**: FR-005, FR-017, FR-018, FR-020, FR-021, FR-022, FR-024; Acceptance Scenarios 3.1-3.5

### Tasks

- [ ] **Prove retained SpawnConfig structural parity**

  Add type-oriented coverage around `src/profile/` and `src/hatchery/spawn-config.ts` showing that the retained M1 security and resource fields are structurally assignable to the profile container and resources subtypes. Keep the check scoped to AS 3.1 and the `networkMode` omission described by US3.

  _Acceptance criteria:_
  - `ContainerSecurity` and `ResourceLimits` remain exported through the profile barrel
  - The six retained `SpawnConfig` fields are assignable to the corresponding profile subtypes
  - `networkMode` is not part of the retained structural parity check
  - The check is compile-time only and adds no runtime dependency from `src/profile/` to Hatchery

- [ ] **Validate container security fields**

  Extend the profile validator for `Profile.container` in `src/profile/` so the security fields satisfy AS 3.1-AS 3.3. Preserve the total, aggregated-error behavior established by earlier stories while reporting container-field problems at their JSON-pointer paths.

  _Acceptance criteria:_
  - A valid M1-equivalent `container` block produces no container-field errors
  - Missing or malformed `capDrop` is reported with `InvalidCapDrop`
  - Accepted `user` forms satisfy AS 3.3
  - Invalid `user` values are reported with `InvalidUser`
  - Container errors use deterministic JSON-pointer paths

- [ ] **Validate resource limit fields**

  Extend the profile validator for `Profile.resources` so the resource ceiling fields satisfy AS 3.1 and AS 3.4. Keep the resource grammar aligned with the data model's M1 mapping rather than broadening to Docker's full accepted surface.

  _Acceptance criteria:_
  - A valid M1-equivalent `resources` block produces no resource-field errors
  - Invalid memory limits are reported with `InvalidMemoryLimit`
  - Invalid CPU limits are reported with `InvalidCpuLimit`
  - Invalid timeout values are reported with `InvalidTimeout`
  - Resource errors are aggregated and deterministically ordered with other validation errors

- [ ] **Reject legacy root networkMode**

  Extend root-level object validation enough to satisfy AS 3.5 without implementing the later `Profile.network` policy story. Treat legacy M1 `networkMode` as an unknown top-level field because the value has migrated to `Profile.network.mode`.

  _Acceptance criteria:_
  - A top-level `networkMode` field produces `UnknownField`
  - The error path points at `/networkMode`
  - Valid container and resource sections do not mask the legacy-field error
  - The task does not implement AS 5 network-policy validation

**PR Outcome**: Merging this slice lets profile authors and F5 implementers validate the six M1 `SpawnConfig` parity fields through `Profile.container` and `Profile.resources`, with legacy `networkMode` rejected at the profile boundary.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: `snapshot.include` semantics in M2 are ambiguous. Three readings: (a) allowlist — only listed paths plus the rest of the worktree minus `exclude`; (b) additive — explicitly add otherwise-excluded paths back; (c) advisory — accepted by schema, ignored by F2/F5 in M2 with M3 to define. Recommended lean: (c) — F1 accepts `include` as `string[]` of patterns mirroring `exclude` shape; downstream consumers in M2 ignore it. Resolution should land before F5 starts so the seeded `spawn` profile doesn't accidentally rely on either of (a) or (b). | clarify:Domain & Data Model | Medium | Medium | inherited | — |
| SD-002 | inherited from spec: `NetworkEndpoint.host` grammar is unspecified. Three readings: (a) RFC 1123 hostname only; (b) hostname + IPv4 literal; (c) hostname + IPv4 + IPv6 + CIDR. Recommended lean: (b) — F1 accepts hostnames and IPv4 literals, rejects IPv6 and CIDR in M2 with a TODO for M3+. `pr-management` profile only needs hostnames (`api.github.com`); operator may want CIDR for self-hosted endpoints. | clarify:Domain & Data Model | High | Medium | inherited | — |
| SD-003 | inherited from spec: `NetworkEndpoint.port` range and special-case semantics. Recommended lean: positive integer 1-65535, no wildcard. Operator may want "all ports for this host" via `port: 0` for future profiles; M2 does not support that. | clarify:Domain & Data Model | Medium | Medium | inherited | — |
| SD-004 | inherited from spec: `UnknownField` granularity — one error per unknown key (more actionable) vs. one error per parent path with a `keys: string[]` field (less noise for multi-typo profiles). Recommended lean: one per key. | clarify:Edge Cases | Low | Medium | inherited | — |
| SD-005 | inherited from spec: Error-code stability commitment — are the `ValidationErrorCode` strings a public API surface within M2 (F4 CLI keys UX off them, downstream tools may match) or internal? Recommended lean: stable within M2, may extend in M3+. Operator's call. | clarify:Constraints | Medium | Medium | inherited | — |
| SD-006 | inherited from spec: `FileMount.target` and `snapshot.exclude` pattern validation rules. Open questions: must `target` be absolute? Forbid `..` traversal? Forbid root `/`? Forbid host-sensitive paths like `/etc`/`/proc`? `InvalidMountTarget` code is in the error enum but its trigger conditions are unspecified. Recommended lean: require absolute POSIX `target`, reject `..` segments, reject empty/root; reject absolute paths and `..` segments in `snapshot.exclude` entries; no host-path denylist at F1 (runtime concern). | clarify:Edge Cases | High | Medium | inherited | — |
| SD-007 | inherited from spec: `container.user` regex precise grammar. Proposed `^([a-z_][a-z0-9_-]{0,31}\|[0-9]+(:[0-9]+)?)$`. Open question: does Docker accept `user:group` symbolic forms (e.g., `"march:march"`)? Recommended lean: accept symbolic `user:group` as an extension (`^([a-z_][a-z0-9_-]{0,31}(:[a-z_][a-z0-9_-]{0,31})?\|[0-9]+(:[0-9]+)?)$`). | clarify:Domain & Data Model | Medium | Medium | inherited | — |
| SD-008 | inherited from spec: `resources.memoryLimit` and `cpuLimit` grammar tightness. Proposed: memory `^[0-9]+[bkmgBKMG]$`, cpu `^[0-9]+(\.[0-9]+)?$`. Open question: should Docker's wider grammar (`"4GB"`, `"4 GiB"`, `"1.5"`) be accepted? Recommended lean: tight grammar matching M1 verbatim; if operator wants flexibility later, widen in M3+. | clarify:Domain & Data Model | Medium | Medium | inherited | — |
| SD-009 | inherited from spec: `envWhitelist` entry grammar — POSIX strict (`[A-Z_][A-Z0-9_]*`) or laxer (allow lowercase, allow leading digit, etc.)? Recommended lean: POSIX strict; pr-management's `GH_TOKEN`/`GITHUB_TOKEN` fit, and stricter grammar makes typos discoverable. | clarify:Terminology | Medium | Medium | inherited | — |
| SD-010 | inherited from spec: `capDrop` entry validation — is the set checked against documented Linux capability names (CAP_* + `"ALL"`), or is any uppercase string accepted? Recommended lean: validate against the documented capability set with case-sensitive `"ALL"` exception; protects against typos like `"NETWORK"` for `"NET_ADMIN"`. Operator may prefer forward-compatible "accept anything" stance. | clarify:Edge Cases | Medium | Medium | inherited | — |
| SD-011 | inherited from spec: `timeoutSeconds` upper bound. M1 hardcodes `3600`. Should F1 enforce a max (e.g., 24h)? Recommended lean: no upper bound in F1; operational sanity is F2/F4/F5's concern. | clarify:Non-Functional Quality | Low | Medium | inherited | — |
| SD-012 | inherited from spec: Performance budget for `validateProfile`. No latency/input-size constraint stated. F4 CLI validates ~1KB YAML — academic; US8 fixture-corpus testing batches validation — slightly more concrete. Recommended lean: target O(n) in input size, no specific budget, no DoS hardening on input size in F1. | clarify:Non-Functional Quality | Low | Medium | inherited | — |
| SD-013 | inherited from spec: `UnknownField` granularity is asserted as one-error-per-key in FR-005 and the Edge Cases section, but SD-004 still treats the granularity question as open. The artifacts have pre-adopted the leaning resolution. Either close SD-004 (one-per-key, matching FR-005) or soften FR-005 and the Edge Cases bullet to defer to SD-004. Operator decision needed for which way to consolidate. | plan-review:Assumption-output drift | Important | Low | inherited | — |
| SD-014 | inherited from spec: `NetworkEndpoint.host` grammar in data-model entity 7 ("DNS-resolvable hostname (RFC 1123) or IPv4 literal. CIDR and IPv6 deferred") asserts the lean-(b) resolution of SD-002 as definitive, while SD-002 itself remains open. Either close SD-002 with lean-(b) or soften entity 7's `host` row to defer the grammar to SD-002. | plan-review:Assumption-output drift | Important | Low | inherited | — |
| SD-015 | inherited from spec: `NetworkEndpoint.port` range (`[1, 65535]`, no wildcards) is asserted in data-model entities 7 and 11 as definitive while SD-003 remains open. Either close SD-003 with the asserted resolution or soften entities 7 and 11 to defer to SD-003. | plan-review:Assumption-output drift | Important | Low | inherited | — |
| SD-016 | inherited from spec: `ValidationErrorCode` is asserted as a public-API surface (data-model entity 11 and contracts "Contract Stability and Versioning" section) while SD-005 still marks the stability question as open. Either close SD-005 with the asserted resolution (codes stable within M2, extensible in M3+) or soften the data model and contracts to defer to SD-005. | plan-review:Assumption-output drift | Important | Low | inherited | — |
| SD-017 | inherited from spec: Codex's credential-mount auth (`/march/codex-auth -> CODEX_HOME`, read-only host-source bind) is not expressible under F1's current `FileMount` union (`named-volume` + `snapshot` only). Two viable resolutions: (a) introduce a third `FileMount` variant `credential-mount` with required `source: { fromBackend: string }` so the host source path is not operator-authored; (b) keep `FileMount` closed and locate credential mounts on the `SpawnBackend` interface in the multi-backend spec, treating them as backend-attached not profile-attached. Recommended lean: (b) — credential mounts are intrinsically per-backend, not per-profile, so they belong on the backend interface and the profile-validator stays clean. | clarify:Domain & Data Model | Critical | Medium | inherited | — |
| SD-018 | inherited from spec: F3 (default profile materialization) seeds `spawn` and `pr-management`. The accelerated `src/hatchery/legate-container.ts` constitutes a third real profile (the Legate container) whose ad-hoc config should migrate into the profile system to avoid two paths for hatchery profiles. Recommended lean: extend F3's seed list to include a `legate` profile and migrate `legate-container.ts` to read its config from there in the Stage B "brood lifecycle CLI" spec. F1 imposes no constraint here — `legate` is data, not schema. | clarify:Feature Boundaries / Scope Within the Milestone | Important | Medium | inherited | — |
| SD-019 | inherited from spec: The `pr-management` profile is the Steward profile (named 2026-05-16). The fixture corpus (FR-026/SC-006) should reflect the role name. Recommended lean: keep `pr-management` as the profile name and add a comment/sidecar mapping it to the Steward role. Operator may prefer renaming the profile to `steward`; that's a content decision, not an F1 schema decision. | clarify:Terminology | Low | Medium | inherited | — |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Validate SpawnConfig Parity Fields | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Profile Type Skeleton and Validator Surface | depends on | Uses the public profile module, subtype exports, validation result shape, and root non-object behavior created by Story 1. |
| User Story 2: Identity, Version, and `baseImage` Validation | depended upon by | The story is pairwise independent after Story 1, but implementations may share object-validation helpers and deterministic error ordering with identity validation. |
| User Story 4: A3 Structural Enforcement — `envWhitelist` is the Only Env Mechanism | depended upon by | Builds on the `container.envWhitelist` field shape and container-level validation extended by this story. |
| User Story 8: Profile Fixture Corpus as Schema Documentation | depended upon by | The final fixture corpus exercises the M1 parity values and container/resource error codes introduced by this story. |
