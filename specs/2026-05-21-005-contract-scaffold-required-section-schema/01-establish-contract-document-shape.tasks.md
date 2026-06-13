# Tasks: Establish Contract Document Shape

**Source**: `specs/2026-05-21-005-contract-scaffold-required-section-schema/contract-scaffold-required-section-schema.spec.md` - User Story 1
**Data Model**: `specs/2026-05-21-005-contract-scaffold-required-section-schema/contract-scaffold-required-section-schema.data-model.md`
**Contracts**: `specs/2026-05-21-005-contract-scaffold-required-section-schema/contract-scaffold-required-section-schema.contracts.md`
**Story Number**: 01

---

## Slice 1: Canonical Contract Scaffold Shape

**Goal**: Add the shared subsystem-contract scaffold artifact that records `docs/subsystems/<name>/contract.md` as the canonical path convention and provides the three required H2 sections every later subsystem contract must carry.

**Justification**: User Story 1 is documentation-only and its acceptance scenarios all depend on one canonical reusable shape. A single slice is the smallest coherent increment: splitting path convention from required headings would leave later contract authors without a complete scaffold, while adding authoring rules, AUTOGEN markers, freshness config, or checkers would cross into later stories.

**Addresses**: FR-001, FR-002, FR-003, FR-010; Acceptance Scenarios 1.1, 1.2, 1.3.

### Tasks

- [ ] **Create the shared contract scaffold artifact**

  Add a reusable scaffold document under `docs/subsystems/` for future subsystem authors. The document should identify `docs/subsystems/<name>/contract.md` as the canonical contract location pattern and show the minimum Markdown structure for a new subsystem contract.

  _Acceptance criteria:_
  - The scaffold names `docs/subsystems/<name>/contract.md` as the canonical contract path convention.
  - The scaffold template contains `## Public Interface`, `## Invariants`, and `## Error Modes` as H2 sections.
  - `## Public Interface` is described as the section for externally consumed routes, commands, types, roles, or protocol surfaces, depending on subsystem shape.
  - The scaffold makes clear that additional sections are allowed, but these three H2 sections are required for every subsystem contract.
  - The scaffold does not author contract bodies for Hatchery, Brood, Herald, Castra, Spawn, Legate, or Steward.

- [ ] **Keep the scaffold presence-check ready without adding tooling**

  Ensure the scaffold is structured so a later presence checker can key on the same three required headings for every subsystem contract. Keep the change limited to documentation artifacts and any repository navigation needed to make the scaffold discoverable.

  _Acceptance criteria:_
  - A reader can identify the required heading names without inferring them from prose.
  - The scaffold's example shape contains exactly one instance of each required H2 heading in the template block.
  - No contract presence checker, freshness checker, AUTOGEN extraction tool, CI enforcement, or subsystem-specific freshness glob is introduced.
  - Existing runtime behavior and CLI contracts remain unchanged.

**PR Outcome**: The repository has one shared documentation scaffold that later subsystem-contract features can copy or follow. It records the canonical `docs/subsystems/<name>/contract.md` location pattern and the required `## Public Interface`, `## Invariants`, and `## Error Modes` H2 headings without implementing tooling or authoring any subsystem-specific contract body.

---

## Specification Debt

None — all ambiguities resolved.

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Canonical Contract Scaffold Shape | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Define Assertable Authoring Rules | depended upon by | US2 extends this scaffold with testable invariant and error-mode authoring guidance. |
| User Story 3: Standardize Autogen Marker Placement | depended upon by | US3 adds the AUTOGEN delimiter convention inside the `## Public Interface` section established here. |
| User Story 4: Record Contract Freshness Schema Shape | depended upon by | US4 records the freshness config shape after the contract path convention and required section vocabulary are stable. |
