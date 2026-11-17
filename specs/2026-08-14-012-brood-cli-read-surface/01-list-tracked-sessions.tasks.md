# Tasks: List Tracked Sessions

**Source**: `specs/2026-08-14-012-brood-cli-read-surface/brood-cli-read-surface.spec.md` — User Story 1
**Data Model**: `specs/2026-08-14-012-brood-cli-read-surface/brood-cli-read-surface.data-model.md`
**Contracts**: `specs/2026-08-14-012-brood-cli-read-surface/brood-cli-read-surface.contracts.md`
**Story Number**: 01

---

## Slice 1: Return Service-Owned List Read Views
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Make the Brood service list endpoint return validated, service-owned `BroodReadView` rows over `SessionRecord` without changing registry state.

**Justification**: This is a standalone service/API increment: HTTP consumers can request the list read surface, receive derived fields for every tracked kind, and rely on invalid filters failing before query execution. It does not add CLI presentation, inspect, logs, teardown, or archive behavior.

**Addresses**: FR-003, FR-004, FR-005, FR-006, FR-012, FR-016, FR-017, FR-019, FR-020; Acceptance Scenarios 1.2-1.5

### Tasks

- [x] **Derive list read views from sessions**

  Add the `BroodReadView` list derivation in the Brood-owned service modules around `src/brood/service/types.ts`, `src/brood/service/routes.ts`, and focused tests. The derivation must operate on `SessionRecord` for all tracked kinds and satisfy AS 1.4-1.5 without persisting derived fields.

  _Acceptance criteria:_
  - `GET /sessions` returns stable view data alongside matching session records
  - Derived fields include age, `needsAttention`, `disposed`, `containerLive`, and `reconciled`
  - `spawn`, `steward`, and `legate` records can all produce a read view
  - Missing branch or container fields keep a stable nullable/empty shape
  - Service reads do not mutate registry, Docker, worktree, branch, or archive state

- [x] **Validate list filters and reconciliation mode**

  Tighten `GET /sessions` query handling so invalid `kind` and `status` values fail explicitly, and add the list reconciliation query contract. Keep reconciliation observational and service-owned so AS 1.2-1.5 and FR-020 hold for scripts as well as the CLI.

  _Acceptance criteria:_
  - Invalid `kind` values return a usage/client error rather than an unfiltered list
  - Invalid `status` values return a usage/client error rather than an unfiltered list
  - The list route accepts explicit reconcile-on and reconcile-off requests
  - Default list reads are marked unreconciled when no query override is supplied
  - No CLI code opens Docker, Castra, archive, registry, worktree, or branch state directly

- [x] **Update service contracts for list reads**

  Update the Brood subsystem contract documentation that maps the service's public HTTP surface, if present, and keep the F2 contract artifact aligned with the implemented list response shape. Scope the documentation update to Story 1 behavior and cite the existing spec, data model, and contracts rather than adding inspect or logs commitments.

  _Acceptance criteria:_
  - Documented `GET /sessions` response matches the implemented read-view shape
  - Documented filter and reconciliation behavior matches AS 1.2-1.5
  - Documentation states the route is read-only and service-owned
  - Inspect, logs, teardown, and archive behavior are not expanded by this slice

**PR Outcome**: `GET /sessions` exposes the Story 1 Brood read-view contract over service-owned `SessionRecord` rows, rejects invalid filters, honors list reconciliation mode, and proves the route remains read-only. The CLI can then render the same service response without direct registry or Docker access.

---

## Slice 2: Render `march brood list`
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Complete the operator-facing `march brood list` command in table and JSON modes by consuming the service-owned list read response.

**Justification**: This is a complete CLI increment over the service read surface from Slice 1: operators can list tracked sessions with filters, stable JSON, empty-result output, and explicit reconciliation flags. It does not implement inspect, logs, teardown, launch, or local fallback behavior.

**Addresses**: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-016, FR-017, FR-020; Acceptance Scenarios 1.1-1.5

### Tasks

- [ ] **Render list output from read views**

  Update the `brood list` command in `src/cli/program.ts` and related CLI tests to render the service's `BroodReadView` list response. Table output should expose the Story 1 operator fields, while JSON mode should emit the stable scriptable view described by AS 1.1 and AS 1.4.

  _Acceptance criteria:_
  - Default table output includes id, status, age, branch, container, and attention marker
  - `--json` outputs the service-provided read views for matching rows
  - Missing optional branch or container values do not shift table or JSON shape
  - Empty matches exit successfully with the agreed empty-result presentation
  - CLI rendering does not mutate service, Docker, worktree, branch, or archive state

- [ ] **Wire list filters and reconciliation flags**

  Add CLI parsing and client plumbing for `--kind`, `--status`, `--reconcile`, and `--no-reconcile` on `march brood list`. Keep validation and liveness observation behind the Brood service so the CLI remains a thin read client for AS 1.2-1.5.

  _Acceptance criteria:_
  - `--status` returns only matching status rows when the service accepts the filter
  - `--kind` returns only matching kind rows when the service accepts the filter
  - Default list invocations request or receive unreconciled read views
  - Explicit reconciliation flags override the default list mode
  - Invalid filter and unreachable-service failures surface as non-zero CLI errors without local fallback

- [ ] **Preserve the CLI contract documentation**

  Update the CLI-owned contract documentation that maps `march brood list`, if present, and keep help text aligned with the accepted flags. Scope the documentation to Story 1 so later Story 2 and Story 3 work remains clearly out of this slice.

  _Acceptance criteria:_
  - `march brood list --help` exposes the Story 1 flags
  - Documented table and JSON output match the implementation
  - Documentation states the command is read-only and service-backed
  - No inspect, logs, teardown, launch, or local registry fallback behavior is introduced

**PR Outcome**: Operators can run `march brood list` in table or JSON mode, filter by status or kind, choose reconciliation mode, and receive stable read-only output backed exclusively by the Brood service.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Archive availability sequencing: F2 specifies fallback to F3's archived `container.log`, but F3 is a separate feature. The F2 implementation must either land after the archive path exists or ship the fallback path with fixture coverage and a clear unavailable-log error until F3 writes real archives. | clarify:Integration | Medium | Medium | inherited | — |
| SD-002 | inherited from spec: Exact `needsAttention` predicate is inherited from F1's open debt. This feature requires the marker to exist in list/inspect output, but the final predicate set is owned by the derived-view contract F1 exposes. | clarify:Domain & Data Model | Medium | Medium | inherited | — |
| SD-003 | inherited from spec: F1's shipped derivation (`src/brood/spawn-index.ts`) is typed against the legacy `SpawnRecord` and reads `~/.march/spawns/*.json`, while this feature reads the service's `SessionRecord` over `GET /sessions`. FR-019 makes the lift prerequisite work, but the shape of that lift is undecided: generalize `derivedStatus` over both record types, adapt `SessionRecord` -> `SpawnView` at the boundary, or retire the legacy reader once F2 lands. Settle at slice time. | plan-review:Assumption-output drift | High | High | inherited | — |
| SD-004 | inherited from spec: The Brood service exposes no reconciliation query parameter and no logs endpoint today. FR-020 places both server-side, so this feature adds routes to a shipped service. Whether reconciliation becomes a query parameter on the existing session routes (as contracted here) or a separate observation endpoint is a service-design decision for the slice. | clarify:Integration Points | High | Medium | inherited | — |
| SD-005 | inherited from spec: Steward log retrieval depends on a Castra session-output read path (FR-015a). Whether Castra already exposes a suitable read endpoint, and whether Brood proxies it or the CLI is told to ask Castra directly, is unverified at spec time and must be confirmed before slicing US3. | clarify:Integration Points | Medium | Low | inherited | — |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Return Service-Owned List Read Views | — | — |
| S2 | Render `march brood list` | S1 | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Inspect One Session | depended upon by | US2 can reuse the `SessionRecord`-based read-view derivation established for list, while adding its own single-session defaults and not-found behavior. |
| User Story 3: Read Live Or Archived Logs | depended upon by | US3 depends on the same service-owned registry lookup discipline but owns log-source selection separately. |
