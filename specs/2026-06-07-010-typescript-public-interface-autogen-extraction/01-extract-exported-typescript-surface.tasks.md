# Tasks: Extract Exported TypeScript Surface

**Source**: `specs/2026-06-07-010-typescript-public-interface-autogen-extraction/typescript-public-interface-autogen-extraction.spec.md` - User Story 1
**Data Model**: `specs/2026-06-07-010-typescript-public-interface-autogen-extraction/typescript-public-interface-autogen-extraction.data-model.md`
**Contracts**: `specs/2026-06-07-010-typescript-public-interface-autogen-extraction/typescript-public-interface-autogen-extraction.contracts.md`
**Story Number**: 01

---

## Slice 1: Extract Public TypeScript Declarations
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Provide the syntax-aware, deterministic extractor that turns configured TypeScript source files into public export summaries for functions, classes, interfaces, type aliases, constants, enums, re-exports, default exports, and type-only exports.

**Justification**: User Story 1 is the smallest useful AUTOGEN increment because later ownership mapping, marker replacement, and check/write command behavior all depend on a trustworthy extracted public surface. This slice delivers observable extraction behavior through a pure local module and tests without crossing into contract ownership configuration, AUTOGEN marker writes, command mode semantics, CI wiring, or runtime subsystem behavior.

**Addresses**: FR-003, FR-004, FR-005, FR-006, FR-007, FR-017; Acceptance Scenarios 1.1, 1.2, 1.3

### Tasks

- [ ] **Add the public export summary extractor**

  Add the extraction implementation in the documentation-contract tooling source area as a local filesystem module. The extractor should parse TypeScript with a syntax-aware parser, accept repo-relative TypeScript source paths, and return the `PublicExportSummary` shape from the data model without adding the npm command, ownership mapping, contract marker replacement, or CI enforcement.

  _Acceptance criteria:_
  - The extractor uses the TypeScript compiler API or an equivalent syntax-aware parser rather than regular-expression matching.
  - Returned summaries include repo-relative source path, export kind, export name, signature-level shape, and type-only status.
  - Exported functions, classes, interfaces, type aliases, constants, enums, default exports, named re-exports, renamed re-exports, namespace re-exports, and type-only exports are represented when present in the input files.
  - Non-exported local declarations and implementation bodies are omitted from every summary.
  - Parse failures return bounded diagnostics with the source path instead of partial successful output.
  - The module runs from repository filesystem inputs only and does not require Docker, network access, live March services, or agent sessions.

- [ ] **Make extraction output byte-stable**

  Normalize declaration signatures and ordering so repeated extraction over unchanged source files produces identical summaries. Keep this behavior inside the extractor and its formatting helpers so later generated Markdown and check/write command modes can depend on the same deterministic surface.

  _Acceptance criteria:_
  - Summaries are sorted deterministically by source path, export kind, and export name.
  - Signature strings exclude function and method bodies while retaining externally relevant parameters, return types, type parameters, class shape, interface members, type alias targets, constant type or initializer shape, enum members, and re-export targets.
  - Equivalent input order from the filesystem cannot change output ordering.
  - Empty source lists produce a valid empty result rather than an unbounded failure.
  - Unsupported export syntax is reported as a bounded extraction diagnostic with category, severity, source path, and message.
  - Running the same fixture extraction twice yields byte-identical serialized output.

- [ ] **Cover extraction with focused fixtures**

  Add fixture-driven tests for the extractor that exercise the public and private declaration cases in AS 1.1-1.3. The tests should validate the public export summary behavior directly and should not depend on contract ownership mapping, AUTOGEN markers, write mode, check mode, or live subsystem services.

  _Acceptance criteria:_
  - Fixtures include exported functions, classes, interfaces, type aliases, constants, enums, re-exports, default exports, type-only exports, and non-exported helper declarations.
  - Tests assert that only public exported declarations appear in summaries.
  - Tests assert deterministic ordering and byte-stable serialized output across repeated extraction.
  - Tests assert implementation bodies and private helpers are absent from summary signatures.
  - Tests cover parse failure diagnostics without writing contract files.
  - Verification uses the repo's `npm run` scripts rather than ad hoc test commands.

**PR Outcome**: The repository has a tested, deterministic TypeScript public-surface extractor that produces `PublicExportSummary` records from local source files and omits private implementation details. Later slices can consume the extractor for ownership mapping, AUTOGEN region replacement, and command check/write behavior without re-parsing TypeScript exports.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

None — all ambiguities resolved.

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Extract Public TypeScript Declarations | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Replace Contract AUTOGEN Regions Safely | depended upon by | US2 consumes the extracted public export summaries when constructing generated contract blocks and validating marker-bounded replacements. |
| User Story 3: Map Extraction Inputs to Contract Owners | depended upon by | US3 maps configured owner selectors to the extractor's source-file inputs and associates extracted summaries with exactly one contract owner. |
| User Story 4: Provide Deterministic Local Command Output | depended upon by | US4 wraps the extractor, ownership mapping, and marker replacement behavior in the local check/write npm command. |
