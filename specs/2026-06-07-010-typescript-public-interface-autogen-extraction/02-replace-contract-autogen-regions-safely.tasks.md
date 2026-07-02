# Tasks: Replace Contract AUTOGEN Regions Safely

**Source**: `specs/2026-06-07-010-typescript-public-interface-autogen-extraction/typescript-public-interface-autogen-extraction.spec.md` - User Story 2
**Data Model**: `specs/2026-06-07-010-typescript-public-interface-autogen-extraction/typescript-public-interface-autogen-extraction.data-model.md`
**Contracts**: `specs/2026-06-07-010-typescript-public-interface-autogen-extraction/typescript-public-interface-autogen-extraction.contracts.md`
**Story Number**: 02

---

## Slice 1: Replace Marker-Bounded Generated Blocks
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Add the filesystem-only Markdown region updater that renders deterministic public-surface blocks and replaces only the content between the single valid AUTOGEN marker pair inside each target contract's `## Public Interface` section.

**Justification**: User Story 2 is one coherent PR because marker discovery, generated-block rendering, write-safety validation, and no-partial-write behavior are one replacement boundary. Splitting them would leave a tool that can either locate unsafe regions without updating them or update regions without proving human-authored prose is preserved. This slice consumes the User Story 1 extractor output and User Story 3 owner-to-source mapping, but stops before adding the public npm command, check/write CLI mode semantics, CI wiring, or Smithy-agent enforcement.

**Addresses**: FR-008, FR-009, FR-010, FR-012, FR-016, FR-017; Acceptance Scenarios 2.1, 2.2, 2.3

### Tasks

- [x] **Render generated public-interface blocks**

  Add the deterministic Markdown renderer for one owner's `PublicExportSummary` records in the documentation-contract tooling area. The renderer should produce the `Generated Contract Block` content from the data model for a specific owner and contract path, without reading or writing contract files and without adding command-mode behavior.

  _Acceptance criteria:_
  - Rendered content includes the owner name, repo-relative contract path, source path, export kind, export name, signature-level shape, and type-only status needed by the public summary contract.
  - Rendered output is byte-stable for unchanged summaries and owner metadata.
  - Empty export sets render deterministically when the owner surface is explicitly allowed to be empty.
  - The renderer does not rewrite human-authored contract prose, inspect AUTOGEN markers, invoke live services, or require Docker, network access, agent sessions, or runtime March processes.

- [x] **Validate contract AUTOGEN marker regions**

  Add marker-region discovery for Markdown contract artifacts. The validator should require exactly one standalone `<!-- BEGIN AUTOGEN -->` and one standalone `<!-- END AUTOGEN -->` marker pair inside the contract's `## Public Interface` section, returning bounded marker diagnostics for invalid contracts rather than replacement ranges.

  _Acceptance criteria:_
  - A contract with exactly one balanced marker pair inside `## Public Interface` returns one replacement region with one-based begin and end marker lines.
  - Missing markers, duplicate marker pairs, unbalanced markers, reversed markers, and markers outside `## Public Interface` fail with marker diagnostics.
  - Marker text inside fenced code blocks or non-standalone lines is not treated as a replacement marker.
  - Diagnostics include category, severity, contract path when available, and bounded message text.
  - Validation does not edit contract files or implement check/write command modes.

- [x] **Replace only validated marker contents**

  Add the safe replacement operation that combines a validated marker region with rendered generated content and returns updated contract bytes only when every write-safety check passes. The operation should preserve marker lines and all bytes outside the marker pair so AS 2.1 and AS 2.2 can be tested without invoking the final npm command.

  _Acceptance criteria:_
  - Valid contracts replace only the content between the AUTOGEN markers and preserve the marker lines.
  - Human-authored prose before and after the marker pair remains byte-for-byte unchanged.
  - Invalid marker placement, missing markers, duplicate markers, unbalanced markers, parse failures, or write-safety failures return non-zero-style diagnostics and leave the original contract content unchanged.
  - Batch updates are all-or-nothing for the contracts included in one replacement request; no partial contract write is possible after any contract in the batch fails validation.
  - The replacement layer does not add the public `npm run docs:contracts:extract` command, check mode, write mode, CI enforcement, runtime subsystem behavior, or Smithy-agent directives.

- [x] **Cover marker replacement with focused fixtures**

  Add fixture-driven tests for valid, missing, duplicate, misplaced, unbalanced, and prose-preserving contract cases. The tests should exercise the renderer, marker validator, and safe replacement layer directly while remaining independent of command-line mode parsing and live subsystem services.

  _Acceptance criteria:_
  - Tests verify that a valid marker pair inside `## Public Interface` is updated between markers only.
  - Tests verify that prose before and after the marker pair is byte-for-byte unchanged.
  - Tests verify missing, duplicated, misplaced, and unbalanced markers fail with bounded diagnostics and unchanged contract content.
  - Tests verify marker text in code fences or non-standalone lines is ignored as a replacement target.
  - Tests verify batch replacement fails without partial writes when one contract is invalid.
  - Verification uses the repo's `npm run` scripts rather than ad hoc test commands.

**PR Outcome**: The repository can render deterministic generated public-interface Markdown, validate the single allowed AUTOGEN marker region inside a contract's `## Public Interface` section, and safely replace only marker-bounded content without partial writes. Later slices can wrap this replacement boundary in the local check/write command without changing the write-safety rules.

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
| S1 | Replace Marker-Bounded Generated Blocks | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Extract Exported TypeScript Surface | depends on | US2 consumes deterministic `PublicExportSummary` records when rendering generated public-interface blocks. |
| User Story 3: Map Extraction Inputs to Contract Owners | depends on | US2 uses validated owner-to-source mapping so each generated block targets exactly one owning contract. |
| User Story 4: Provide Deterministic Local Command Output | depended upon by | US4 wraps this marker rendering, validation, and safe replacement behavior in the local check/write npm command. |
