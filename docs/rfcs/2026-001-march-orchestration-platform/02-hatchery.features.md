# Feature Map: Hatchery

**Source RFC**: `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md`
**Milestone**: 2 — Hatchery
**Created**: 2026-05-11

## Features

### Feature 1: Profile Schema and Validation Library

**Description**: Define the declarative Hatchery profile data model and ship a pure, side-effect-free validator. The schema structurally enforces the Appendix A threat-model constraints — bind-mount rejection (A2), env whitelist as the only env mechanism (A3), snapshot include/exclude (A5), and per-backend network endpoint allowlist (A7) — so unsafe configurations are impossible by construction rather than caught at runtime. Every field currently on M1's `SpawnConfig` interface (`capDrop`, `user`, `networkMode`, `memoryLimit`, `cpuLimit`, `timeoutSeconds`, `envWhitelist`) maps 1:1 onto the profile schema so the M1 refactor in F5 is a pure rename, not a redesign.

**User-Facing Value**: The operator can author Hatchery profiles in a text editor with confidence that the schema rejects unsafe configurations at parse time. Every consumer of the profile system — `march init`, the Hatchery CLI verbs, and the Spawn dispatch pipeline — calls the same validator, so what `march hatchery validate` accepts is exactly what spawn dispatch will run.

**Scope Boundaries**:
- Includes: profile data model (TypeScript types + on-disk schema), structural enforcement of A2/A3/A5/A7 (no `bindMounts` field that accepts host paths; `envWhitelist` as the *only* env mechanism; `snapshot.include`/`snapshot.exclude` fields; `network.allowlist` for per-backend endpoints), 1:1 field mapping from M1 `SpawnConfig` to the profile schema, `version` and `name` identity fields, optional `tools?: { allowed?: string[]; disallowed?: string[] }` field shipped but unconsumed in M2, pure-function validator producing typed errors, profile-fixture test set (valid + invalid examples) that doubles as schema documentation
- Excludes: filesystem location and storage (F2), CLI surface (F4), default profile contents (F3), Spawn integration (F5), runtime enforcement of A7's allowlist at the Docker layer (F5), `tools` field enforcement (deferred — M3+ consumer)

### Feature 2: Profile Storage and Resolution

**Description**: Provide the filesystem layer that locates, reads, and resolves Hatchery profiles by name. A profile loader composes filesystem discovery with the F1 validator: given a profile name, it returns either a typed `Profile` object or a structured error. Storage location is user-level (`~/.march/profiles/`), matching the M1 precedent of `~/.march/spawns/`. Profile file format is YAML so operators can hand-edit with comments.

**User-Facing Value**: The operator has a single, predictable place where profiles live, and any tool or skill that needs a profile by name can resolve it consistently. Profiles are version-controllable by copying them out of the user directory into a repo if desired, but M2 does not introduce repo-local profile overrides.

**Scope Boundaries**:
- Includes: profile directory location (`~/.march/profiles/`), YAML file format and `.yaml` extension, profile-name-to-file resolution, loader that composes storage I/O with F1 validation, structured error reporting for missing/malformed profiles
- Excludes: schema definition or validation logic (F1), seeding default profiles (F3), CLI command wiring (F4), repo-local profiles or precedence layering (deferred beyond M2), interactive profile authoring or editing

### Feature 3: Default Profile Materialization via `march init`

**Description**: Extend M1's `march init` to seed the profile directory with two opinionated default Hatchery profiles, materializing them as editable YAML files so the operator sees exactly the defaults they will run. The first seeded profile (`spawn`) encodes M1's container/security values from `SPAWN_CONFIG` (`src/spawn-config.ts`) verbatim into the profile's container/security fields, **plus** M1's snapshot patterns from `SNAPSHOT_EXCLUSION_PATTERNS` (`src/snapshot.ts`) verbatim into the profile's `snapshot.exclude` field, plus the `ANTHROPIC_API_KEY` envWhitelist — so F5's M1 refactor is a regression-free swap. The second seeded profile demonstrates the schema generalizes to a different security posture (the success criterion "multiple security profiles can coexist"); its exact identity is the open question recorded in SD-001. Re-init is idempotent: existing profile files are not overwritten unless the operator passes `--force`.

**User-Facing Value**: A fresh `march init` lands two editable profile files in the operator's home directory. The operator can see what the opinionated defaults are, edit them, and trust that M2 ships an honest second profile that proves the schema generalizes beyond Spawn.

**Scope Boundaries**:
- Includes: extension of `march init` to write the two seeded YAML profiles to `~/.march/profiles/`, byte-faithful encoding of M1 `SPAWN_CONFIG` (`src/spawn-config.ts`) into the `spawn` profile's container/security fields, byte-faithful encoding of M1 `SNAPSHOT_EXCLUSION_PATTERNS` (`src/snapshot.ts`) into the `spawn` profile's `snapshot.exclude` field, the `ANTHROPIC_API_KEY` envWhitelist, idempotent seeding (skip-if-exists by default, `--force` flag to overwrite), inline doc comments inside each materialized YAML file
- Excludes: schema definition (F1), filesystem layout decision (F2 — this feature consumes that layout), CLI verbs that read or validate the seeded profiles (F4), the M1 refactor that consumes the `spawn` profile at dispatch time (F5), additional seeded profiles beyond the two (deferred to M3+ as those components arrive)

### Feature 4: Hatchery CLI Surface

**Description**: Add read-only Hatchery verbs to the March CLI — `march hatchery list`, `march hatchery inspect <name>`, and `march hatchery validate [<name>|--all]`. The verbs invoke F1's validator (no duplication of validation logic) and surface results as operator-readable diagnostics with file references where applicable. The CLI does not include `create`, `edit`, or `delete` verbs — the RFC's "declarative, version-controlled, editable files" stance means the operator's editor is the authoring UX.

**User-Facing Value**: The operator can discover what profiles exist, see their resolved contents, and check a profile (or every profile) for schema violations before dispatching a spawn. Validation exit codes integrate with scripted workflows. This satisfies the M2 success criterion "Profiles can be listed, inspected, and validated via the March CLI."

**Scope Boundaries**:
- Includes: `march hatchery list` (enumerate profiles via F2), `march hatchery inspect <name>` (load via F2 and pretty-print), `march hatchery validate [<name>|--all]` (validate one or all profiles via F1+F2 with named-rule diagnostics), scripted exit codes
- Excludes: profile mutation commands (`create`, `edit`, `delete`), interactive prompts, runtime profile consumption (F5), default profile seeding (F3), schema or storage definition (F1, F2)

### Feature 5: Spawn Consumes Hatchery Profile

**Description**: Refactor M1's Spawn dispatch pipeline to load its container configuration from a Hatchery profile instead of the hardcoded `SPAWN_CONFIG` constant. Add a `--profile <name>` flag to `march spawn dispatch` (default: `spawn`). Resolve the named profile via F2, validate via F1, and feed the resolved fields into the existing Stage 4 (Launch) and Stage 6 (Wait) consumers. Migrate M1's hardcoded snapshot exclusion list (`.env`, `.env.*`, credential files) into the seeded `spawn` profile's `snapshot.exclude` field. Implement A7 runtime enforcement at the Docker layer — translating the profile's `network.allowlist` into firewall rules, iptables, or a proxy mechanism (the exact enforcement primitive is a F5 spec-phase decision). The seeded `spawn` profile must produce **byte-identical** `docker run` invocations to M1's current behavior so the refactor introduces zero regression.

**User-Facing Value**: The operator can swap which security posture a spawn runs under by changing the `--profile` flag — no code change required. The M1 refactor is invisible to existing users of `march spawn dispatch` because the default profile reproduces M1's exact behavior. Operators who want a different posture (network allowlist for a different endpoint, different env whitelist, different resource limits) can copy and edit a profile rather than fork the codebase.

**Scope Boundaries**:
- Includes: deletion of `SPAWN_CONFIG` constant from `src/spawn-config.ts`, deletion of `SNAPSHOT_EXCLUSION_PATTERNS` constant from `src/snapshot.ts` (the snapshot-build pipeline now reads the exclusion list from the resolved Hatchery profile's `snapshot.exclude` field — single source of truth), profile resolution at dispatch time via F2, `--profile` flag plumbing on `march spawn dispatch`, A7 runtime enforcement (Docker layer translation of `network.allowlist` to firewall/iptables/proxy), `SpawnRecord` field recording which profile was used (traceability), regression-safety guarantee that the seeded `spawn` profile produces byte-identical Docker invocations to M1
- Excludes: schema definition (F1), filesystem layout (F2), `march init` seeding of the default profile (F3 — F5 consumes what F3 ships), Hatchery CLI verbs (F4), Brood-managed cleanup of containers/worktrees (M3), changes to M1's security guarantees beyond the location of the values (a future M1-side hardening of the `bridge` network default is unblocked by F5 but is not done here), profile mutations from the spawn side (operator edits files, not the CLI)

### Feature 6: Hatchery Skills

**Description**: Add Hatchery-flavored skills to the March CLI's deployed skill catalog, following the SmithyCLI pattern established by M1 Feature 1. Skills cover the operator workflows that depend on the new Hatchery surface: authoring a new profile, validating one before dispatch, choosing a profile for a spawn, and understanding how the schema's structural constraints map to the Appendix A threat model.

**User-Facing Value**: The pseudo-legate (skills deployed by `march init`) gains coverage of Hatchery interactions, so the operator can be coached through profile workflows without out-of-band documentation. This satisfies the M2 success criterion "Skills updated to cover Hatchery interactions."

**Scope Boundaries**:
- Includes: new skill markdown files for Hatchery workflows (profile authoring, validation, selection, threat-model mapping), deployment via the existing `march init` skill-deployment path established in M1 Feature 1
- Excludes: runtime CLI surface (F4), schema definition (F1), default profile content (F3), Legate-class orchestration (M5)

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Identity of the second seeded profile in F3: a speculative `pr-management` schema-only stub (matches RFC narrative, not exercised by any M2 runtime consumer) vs. a runnable example like `skill-author` or `doc-edit` (M2 could actually invoke it via spawn dispatch). The choice shapes F3's payload and the M2 demo surface. Recommended lean: `pr-management` stub for narrative consistency, with the runnable example deferred until M3+ has a consumer that can exercise it. | clarify:Feature Boundaries / Scope Within the Milestone | Critical | Medium | open | — |

## Dependency Order

Recommended specification sequence:

| ID | Title                                          | Depends On | Artifact |
|----|------------------------------------------------|------------|----------|
| F1 | Profile Schema and Validation Library          | —          | —        |
| F2 | Profile Storage and Resolution                 | F1         | —        |
| F3 | Default Profile Materialization via `march init` | F1, F2   | —        |
| F4 | Hatchery CLI Surface                           | F1, F2     | —        |
| F5 | Spawn Consumes Hatchery Profile                | F1, F2, F3 | —        |
| F6 | Hatchery Skills                                | F1, F2, F3, F4, F5 | — |

F3 and F4 can begin in parallel once F1 and F2 are stable. F5 depends on F3 because the seeded `spawn` profile is the consumer's input. F6 sits last because skill content references the final operator-visible behavior of F1–F5.

## Cross-Milestone Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| Milestone 1: Spawn | depends on | F5 refactors M1's `SPAWN_CONFIG` consumer (`src/spawn-config.ts` and the Stage 4 Launch / Stage 6 Wait pipeline) to read a Hatchery profile instead. F3 seeds the `spawn` profile from M1's exact values. F1's schema must accommodate every existing M1 `SpawnConfig` field 1:1. |
| Milestone 1: Spawn | depended upon by | F3 extends M1's `march init` (M1 Feature 1) to materialize default profiles. F6 deploys via M1's skill-deployment mechanism. |
| Milestone 3: Brood | depended upon by | When M3 introduces non-spawn containerized components (PR-management agent, future session types), those components consume Hatchery profiles via F1's schema and F2's loader. M2 ships the schema's capacity to express their postures but does not ship the components themselves. |
| Milestone 4: Herald | depended upon by | Future Herald-deployable components, if containerized, consume Hatchery profiles via the same F1/F2 surface. M2 imposes no constraint on Herald's eventing model. |
| Milestone 5: Legate | depended upon by | If Legate eventually runs in a Docker container (per RFC Proposal: "Legate, Brood, and Herald may also deploy in Docker containers with their own profiles"), it consumes a Hatchery profile defined later. M2 does not ship a `legate` profile. |
