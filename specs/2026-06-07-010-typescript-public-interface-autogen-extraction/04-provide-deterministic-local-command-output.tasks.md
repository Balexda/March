# Tasks: Provide Deterministic Local Command Output

**Source**: `specs/2026-06-07-010-typescript-public-interface-autogen-extraction/typescript-public-interface-autogen-extraction.spec.md` - User Story 4
**Data Model**: `specs/2026-06-07-010-typescript-public-interface-autogen-extraction/typescript-public-interface-autogen-extraction.data-model.md`
**Contracts**: `specs/2026-06-07-010-typescript-public-interface-autogen-extraction/typescript-public-interface-autogen-extraction.contracts.md`
**Story Number**: 04

---

## Slice 1: Wire the Local Check and Write Command
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Add the scriptable `npm run docs:contracts:extract` command that composes extraction, ownership resolution, marker validation, generated-block comparison, and marker-bounded writes into deterministic check and write modes.

**Justification**: User Story 4 is one coherent PR because the public command contract is the integration boundary across the earlier extraction, ownership, and replacement slices. Splitting mode parsing, stale detection, write behavior, and diagnostics would leave a command that cannot satisfy the clean pass/fail local workflow expected by developers, CI, and later Smithy-agent enforcement.

**Addresses**: FR-001, FR-002, FR-011, FR-012, FR-016, FR-017; Acceptance Scenarios 4.1, 4.2, 4.3, 4.4

### Tasks

- [ ] **Expose the npm-run command surface**

  Add the repository-local command entrypoint and package script for `npm run docs:contracts:extract` with explicit check and write modes. The command should delegate subsystem behavior to the existing documentation-contract tooling modules and avoid adding live-service, Docker, network, CI, or Smithy-agent enforcement behavior.

  _Acceptance criteria:_
  - `npm run docs:contracts:extract -- --check` invokes check mode.
  - `npm run docs:contracts:extract -- --write` invokes write mode.
  - Missing, conflicting, or unsupported mode flags fail with bounded command diagnostics.
  - The command resolves repository filesystem inputs deterministically from the current checkout.
  - No Docker, network access, live March services, agent sessions, CI workflow, or runtime subsystem behavior is required.

- [ ] **Compose check mode without editing files**

  Implement the check-mode pipeline that loads extraction ownership, resolves source surfaces, extracts public export summaries, renders expected generated blocks, validates target AUTOGEN regions, and compares expected content with existing marker-bounded content.

  _Acceptance criteria:_
  - Matching generated regions exit zero with stable summary output for AS 4.1.
  - Stale generated regions exit non-zero for AS 4.2.
  - Stale-output diagnostics include the owning contract path and remain bounded.
  - Check mode does not modify contract files or any generated region.
  - Config, ownership, parse, marker, stale-output, and write-safety failures produce the `Autogen Command Result` shape from the data model.

- [ ] **Compose write mode with marker-bounded updates**

  Implement the write-mode pipeline using the same expected generated blocks and marker validation as check mode, then refresh only stale valid AUTOGEN regions. The write path should preserve the all-or-nothing safety boundary from the replacement slice and report updated owners deterministically.

  _Acceptance criteria:_
  - Stale generated regions are refreshed for AS 4.3.
  - Updated-contract diagnostics or summaries include each owning contract path.
  - Write mode changes only content between validated AUTOGEN markers.
  - Invalid config, ownership, parse, marker, or write-safety failures leave contracts unchanged.
  - Already-current contracts remain byte-for-byte unchanged and are reported consistently.

- [ ] **Stabilize command output and exit behavior**

  Normalize command summaries, diagnostics, and exit codes so humans, CI, and future Smithy-agent enforcement receive the same local result from unchanged repository inputs. Keep output bounded and deterministic without requiring service readiness or interactive prompts.

  _Acceptance criteria:_
  - Passing check mode exits `0` with stable counts for checked owners, extracted exports, stale contracts, updated contracts, and diagnostics.
  - Failing check mode and unsafe write mode exit non-zero.
  - Diagnostics include failure category, owner name when known, contract path when available, source path when available, and bounded message text.
  - Output ordering is deterministic by owner and repo-relative path.
  - The command never prompts for input and failures are clean exits rather than hangs.

- [ ] **Cover the command with integration fixtures**

  Add focused command-level tests that exercise current, stale, write, and infrastructure-unavailable (Docker + March subsystems/sessions absent) scenarios through the public npm-run command or its command entrypoint. The tests should prove US4 behavior without adding CI enforcement or depending on live March processes.

  _Acceptance criteria:_
  - Tests cover AS 4.1 with current AUTOGEN content in check mode.
  - Tests cover AS 4.2 with stale AUTOGEN content in check mode and assert files are unchanged.
  - Tests cover AS 4.3 with stale AUTOGEN content in write mode and assert only marker-bounded content changes.
  - Tests cover AS 4.4 without Docker, Hatchery, Brood, Herald, Castra, Spawn, Legate, Steward sessions, network access, or agent-deck.
  - Verification uses the repo's `npm run` scripts rather than ad hoc test commands.

**PR Outcome**: The repository exposes a deterministic local `npm run docs:contracts:extract` command with check and write modes that runs from filesystem inputs, reports stale generated regions cleanly, refreshes only validated AUTOGEN blocks in write mode, and exits without live service dependencies or prompts.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

None - all ambiguities resolved.

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Wire the Local Check and Write Command | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Extract Exported TypeScript Surface | depends on | US4 wraps deterministic public export summaries in the local command pipeline. |
| User Story 2: Replace Contract AUTOGEN Regions Safely | depends on | US4 uses marker validation, generated-block rendering, and safe replacement behavior for check and write modes. |
| User Story 3: Map Extraction Inputs to Contract Owners | depends on | US4 consumes validated owner-to-source mapping before extracting and associating generated blocks with contracts. |
