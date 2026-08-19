# Tasks: Inspect One Session

**Source**: `specs/2026-08-14-012-brood-cli-read-surface/brood-cli-read-surface.spec.md` — User Story 2
**Data Model**: `specs/2026-08-14-012-brood-cli-read-surface/brood-cli-read-surface.data-model.md`
**Contracts**: `specs/2026-08-14-012-brood-cli-read-surface/brood-cli-read-surface.contracts.md`
**Story Number**: 02

---

## Slice 1: Expose Session Inspect Read View
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: The Brood service can return a complete `BroodReadView` for one tracked `SessionRecord`, with inspect reconciliation enabled by default and no registry mutation.

**Justification**: This is a standalone service increment: API consumers can inspect one session over HTTP and receive both the full record and derived read fields before the operator CLI renders them.

**Addresses**: FR-007, FR-008, FR-009, FR-011, FR-012, FR-017, FR-019, FR-020, FR-021; Acceptance Scenarios 2.1–2.5

### Tasks

- [x] **Derive read views from session records**

  Add the `BroodReadView` derivation owned by `src/brood/service/` and type it against `SessionRecord`, not the legacy spawn-record reader. Preserve the existing registry as the source of truth and keep derived fields non-persisted for AS 2.1, AS 2.3, and AS 2.4.

  _Acceptance criteria:_
  - Derived view includes the fields required by the data model.
  - `failureReason` remains part of the nested record when present.
  - `disposed` and `needsAttention` are computed for all tracked session kinds.
  - `needsAttention` is bound to F1's shipped predicate — true when and only when
    `status === "failed"` (`src/brood/spawn-index.ts:119`) — so lifting the derivation
    to `SessionRecord` preserves behavior rather than inventing a new predicate.
    Widening it (exit codes, `tearing-down` dwell, other lifecycle states) is out of
    scope for this slice and stays with SD-002.
  - Missing optional branch or container facts keep stable null or empty output fields.
  - Tests prove deriving a view does not update stored session records.

- [x] **Add inspect reconciliation to the service route**

  Extend the single-session read route in `src/brood/service/routes.ts` so `GET /sessions/:id` returns the contracted inspect view and honors the reconciliation mode for AS 2.1, AS 2.2, AS 2.4, and AS 2.5. Keep reconciliation observational and server-owned, consistent with the feature contracts and Brood's lifecycle boundary.

  _Acceptance criteria:_
  - Existing tracked ids return a read view with the complete record nested.
  - Missing ids return the existing deterministic not-found failure.
  - Inspect defaults to reconciled output unless explicitly disabled.
  - Missing tracked containers affect `containerLive` only when reconciliation is enabled.
  - A failing liveness source degrades to a successful record with `reconciled: false`
    **and** emits an *errored* span via `startBroodSpan`
    (`src/observability/brood-trace.ts`), nesting on the slice id as a child rather than
    starting its own root, per AGENTS.md's failure-modes-surface-as-errored-spans rule.
    Tests assert the degraded response and the errored span together, so the new failure
    mode cannot be silent in traces just because the HTTP status stays 200.
  - Service route tests cover read-only behavior and all tracked session kinds.

- [x] **Teach the Brood client to inspect views**

  Add client support in `src/brood/service/client.ts` for the inspect read-view response while preserving existing callers that still need the bare session lookup. The client should send the intended reconciliation mode over HTTP and surface service errors without local fallback for AS 2.2, AS 2.4, and AS 2.5.

  _Acceptance criteria:_
  - Client callers can request one inspect read view by id.
  - Default inspect client behavior matches the service default.
  - Explicit reconcile and no-reconcile modes are represented on the request.
  - Unknown ids surface through the not-found path.
  - Client tests cover unavailable-service and non-200 failures.

- [x] **Update Brood subsystem contract documentation**

  Add or update the Brood subsystem contract artifact under `docs/subsystems/` for the new single-session read-view surface. Document only the public HTTP and client-facing inspect contract changed by this slice, following the repository's contract-documentation guidance.

  _Acceptance criteria:_
  - Brood's public inspect route shape is documented with reconciliation behavior.
  - The read-only invariant is recorded for inspect.
  - Error modes include not-found, service failure, and reconciliation degradation.
  - Documentation points to the Brood ownership boundary rather than restating CLI behavior.

**PR Outcome**: `GET /sessions/:id` and the Brood client expose a typed, read-only inspect view over `SessionRecord`, including failure context, reconciliation state, and stable not-found handling.

---

## Slice 2: Render `march brood inspect`
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Operators can run `march brood inspect <id>` in human or JSON mode and see the complete tracked record plus derived read fields from the Brood service.

**Justification**: This slice delivers the operator-facing value of US2 on top of the service read-view API, without adding unrelated list or logs behavior.

**Addresses**: FR-007, FR-008, FR-009, FR-010, FR-011, FR-012, FR-016, FR-017, FR-020, FR-021; Acceptance Scenarios 2.1–2.5

### Tasks

- [ ] **Add inspect command wiring**

  Add `march brood inspect <id>` in `src/cli/program.ts` as a thin client over the Brood service inspect API. Support human output, JSON output, and the reconciliation flags required for AS 2.1, AS 2.2, AS 2.4, and AS 2.5.

  _Acceptance criteria:_
  - Command help shows `inspect <id>` under the Brood command group.
  - Default inspect calls request reconciled output from Brood.
  - Explicit `--reconcile` and `--no-reconcile` override the default mode.
  - The command never opens Docker, archive, worktree, branch, or registry state directly.
  - CLI tests cover success, JSON mode, flag handling, and service-unreachable failure.

- [ ] **Render complete inspect output**

  Implement the human and JSON presentations for the inspect read view in the CLI-owned layer. Human output should make the derived read fields and the complete session record visible for AS 2.1–2.3 while JSON mode should pass through a stable object for scripts.

  _Acceptance criteria:_
  - Human output includes every persisted record field returned by the service.
  - Human output includes `needsAttention`, `disposed`, `containerLive`, and reconciliation state.
  - `failureReason` is visible when present.
  - JSON output contains the complete service read view without dropping unknown record fields.
  - Missing optional fields do not shift or omit the output shape.

- [ ] **Handle inspect failures deterministically**

  Map Brood client failures in the CLI action to the expected operator-facing exit behavior for AS 2.5 and the service-unreachable edge case. Keep usage and service errors distinct enough that scripts can rely on a non-zero exit without the CLI falling back to raw local state.

  _Acceptance criteria:_
  - Unknown ids exit non-zero with the deterministic not-found service message.
  - Brood-unreachable errors exit non-zero with the client error.
  - Reconciliation-source degradation does not hide an otherwise available record.
  - No failure path mutates registry, archive, Docker, worktree, or branch state.

- [ ] **Update CLI contract documentation**

  Update the affected CLI-facing contract documentation for the new `march brood inspect` read surface in the same patch as the command. Keep the documented surface aligned with the spec and avoid documenting future `list` or `logs` behavior in this slice.

  _Acceptance criteria:_
  - The inspect command signature and output modes are documented.
  - The default reconciliation behavior is documented.
  - Error modes match the implemented CLI behavior.
  - The documentation cites the Brood service as the owner of reconciliation and record data.

**PR Outcome**: `march brood inspect <id>` gives operators a read-only human or JSON detail view for one tracked Brood session, including failure context, derived read fields, reconciliation control, and deterministic not-found handling.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Archive availability sequencing: F2 specifies fallback to F3's archived `container.log`, but F3 is a separate feature. The F2 implementation must either land after the archive path exists or ship the fallback path with fixture coverage and a clear unavailable-log error until F3 writes real archives. | clarify:Integration | Medium | Medium | inherited | — |
| SD-002 | inherited from spec: Exact `needsAttention` predicate is inherited from F1's open debt. This feature requires the marker to exist in list/inspect output, but the final predicate set is owned by the derived-view contract F1 exposes. | clarify:Domain & Data Model | Medium | Medium | inherited | Bound for this slice to F1's shipped failed-only predicate (`src/brood/spawn-index.ts:119`) so the shared derivation is dispatchable; the feature-level question of whether the predicate should widen stays open. |
| SD-003 | inherited from spec: F1's shipped derivation (`src/brood/spawn-index.ts`) is typed against the legacy `SpawnRecord` and reads `~/.march/spawns/*.json`, while this feature reads the service's `SessionRecord` over `GET /sessions`. FR-019 makes the lift prerequisite work, but the shape of that lift is undecided: generalize `derivedStatus` over both record types, adapt `SessionRecord` -> `SpawnView` at the boundary, or retire the legacy reader once F2 lands. Settle at slice time. | plan-review:Assumption-output drift | High | High | inherited | — |
| SD-004 | inherited from spec: The Brood service exposes no reconciliation query parameter and no logs endpoint today. FR-020 places both server-side, so this feature adds routes to a shipped service. Whether reconciliation becomes a query parameter on the existing session routes (as contracted here) or a separate observation endpoint is a service-design decision for the slice. | clarify:Integration Points | High | Medium | inherited | — |
| SD-005 | inherited from spec: Steward log retrieval depends on a Castra session-output read path (FR-015a). Whether Castra already exposes a suitable read endpoint, and whether Brood proxies it or the CLI is told to ask Castra directly, is unverified at spec time and must be confirmed before slicing US3. | clarify:Integration Points | Medium | Low | inherited | — |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Expose Session Inspect Read View | — | — |
| S2 | Render `march brood inspect` | S1 | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: List Tracked Sessions | depended upon by | The shared `BroodReadView` derivation introduced for inspect can be reused by list, but US2 is independently useful through the single-session route and CLI command. |
| User Story 3: Read Live Or Archived Logs | depended upon by | Logs can reuse the tracked-session lookup and not-found behavior, but US2 does not require log-source selection or archive fallback. |
