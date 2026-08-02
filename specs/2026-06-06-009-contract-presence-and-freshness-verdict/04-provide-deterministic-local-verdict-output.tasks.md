# Tasks: Provide Deterministic Local Verdict Output

**Source**: `specs/2026-06-06-009-contract-presence-and-freshness-verdict/contract-presence-and-freshness-verdict.spec.md` - User Story 4
**Data Model**: `specs/2026-06-06-009-contract-presence-and-freshness-verdict/contract-presence-and-freshness-verdict.data-model.md`
**Contracts**: `specs/2026-06-06-009-contract-presence-and-freshness-verdict/contract-presence-and-freshness-verdict.contracts.md`
**Story Number**: 04

---

## Slice 1: Stabilize Verdict Output Contract
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Make `npm run docs:contracts:check` produce a stable, bounded, scriptable output contract for passing and failing presence, config, and freshness verdicts without adding live-service dependencies.

**Justification**: Presence, config, and freshness checks already supply the verdict categories this story needs. The remaining standalone increment is to harden their shared output and command behavior so local development, CI, and later Smithy-agent enforcement can consume one deterministic interface, consistent with `docs/vision.md` and the clean-exit rule in `docs/operating-philosophy.md`.

**Addresses**: FR-001, FR-012, FR-013, FR-014; Acceptance Scenarios 4.1, 4.2, 4.3

### Tasks

- [x] **Stabilize passing verdict summaries**

  Extend the docs-contract checker and tests around `scripts/docs-contracts/check.mjs` so passing runs emit a stable summary for every evaluated verdict category. This task satisfies AS 4.1 by documenting and verifying the chosen local text output shape rather than adding a second transport or new enforcement surface.

  _Acceptance criteria:_
  - Passing output includes deterministic overall status and per-category summary fields.
  - Summary ordering is stable across repeated runs with the same filesystem and git inputs.
  - Counts cover checked contracts, config entries, changed files, and diagnostics.
  - The npm script remains the supported entrypoint from `package.json`.
  - No CI workflow, Smithy-agent enforcement, AUTOGEN extraction, or runtime subsystem behavior is added.

- [x] **Bound failing verdict diagnostics**

  Harden failure formatting in `scripts/docs-contracts/check.mjs` so presence, section-schema, config, freshness, and input-source failures expose bounded diagnostics with stable field names. This task satisfies AS 4.2 and resolves the inherited output-shape debt by keeping stable text as the committed interface for this feature.

  _Acceptance criteria:_
  - Failing output includes the failing category for every emitted diagnostic.
  - Diagnostics include owning name, source path, and contract path when available.
  - Diagnostic volume remains bounded and deterministic when many failures exist.
  - Input-source failures exit non-zero with bounded output rather than prompting.
  - Tests cover representative failures from presence, config, freshness, and changed-file input.

- [x] **Preserve service-independent command execution**

  Harden the npm-run verdict path so command execution remains limited to filesystem and git inputs. This task satisfies AS 4.3 by protecting the local verdict boundary from accidental Docker, network, Castra, Hatchery, Brood, Herald, Legate, agent-deck, or runtime service dependencies.

  _Acceptance criteria:_
  - The npm script exits zero for a complete passing fixture.
  - The npm script exits non-zero for a failing fixture without hanging.
  - Tests or local validation prove the command does not require live March services.
  - Git-derived changed-file failures remain clean exits when the requested base cannot be evaluated.
  - Documentation or inline help, if updated, describes only local filesystem and git inputs.

**PR Outcome**: Operators, CI, and later Smithy-agent enforcement can consume `npm run docs:contracts:check` as a deterministic local verdict command with stable pass summaries, bounded failure diagnostics, and no dependency on live March services. This completes the Feature 5 verdict surface without introducing enforcement, AUTOGEN extraction, runtime subsystem behavior, or workflow changes.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-002 | inherited from spec: The implementation must choose whether the verdict output is JSON, stable text, or both. The spec requires stable bounded diagnostics but leaves transport shape to slicing. | Interface Shape | Low | Medium | resolved | Resolved in this cut by committing stable bounded text output as the Feature 5 interface; no JSON transport is required for this story. |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Stabilize Verdict Output Contract | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Validate Required Contract Presence | depends on | US4 stabilizes the output produced by the presence and section-schema checks from US1. |
| User Story 2: Populate and Validate Contract Freshness Mapping | depends on | US4 stabilizes the output produced by the config checks from US2. |
| User Story 3: Report Source and Contract Freshness Drift | depends on | US4 stabilizes the output produced by the changed-file and freshness checks from US3. |
