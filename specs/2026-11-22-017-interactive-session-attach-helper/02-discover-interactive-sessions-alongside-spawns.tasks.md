# Tasks: Discover Interactive Sessions Alongside Spawns

**Source**: `specs/2026-11-22-017-interactive-session-attach-helper/interactive-session-attach-helper.spec.md` — User Story 2
**Data Model**: `specs/2026-11-22-017-interactive-session-attach-helper/interactive-session-attach-helper.data-model.md`
**Contracts**: `specs/2026-11-22-017-interactive-session-attach-helper/interactive-session-attach-helper.contracts.md`
**Story Number**: 02

---

## Slice 1: List Interactive Sessions and Tracked Spawns

<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Give operators one read-only view of interactive names and tracked spawn IDs.

**Justification**: Deliver Castra's live inventory with its Brood CLI consumer so operators can discover names as soon as the inventory is available. [March vision](../../docs/vision.md) · [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-001, FR-004, FR-005, AS 2.1–2.3, SC-003.

### Tasks

- [x] **Expose live interactive inventory from Castra**

  Add an authenticated service and client surface that reads live names from Castra's tmux server for AS 2.1–2.3.

  _Acceptance criteria:_
  - Return the unprefixed names of eligible live `march/` sessions. Omit unrelated sessions and stale records.
  - Return a successful empty inventory when a healthy tmux installation has no running session server or no eligible sessions.
  - Bound tmux and HTTP calls. Surface authentication, missing tmux, socket permission, timeout, and service failures as errors distinguishable from an empty inventory.
  - Cover filtering, empty results, and failures in Castra tests and update the Castra subsystem contract.

- [x] **Show both sources in the Brood CLI**

  Wire `march brood sessions` with no positional inputs through the Brood subsystem. Read Castra inventory and the existing Brood spawn views for AS 2.1–2.3.

  _Acceptance criteria:_
  - Display distinguishable interactive and spawn results. Include tracked spawns across all statuses and label each colliding interactive name unavailable with the spawn-ID collision as the reason.
  - Show an explicit empty interactive result when Castra reports a healthy empty inventory and preserve the spawn results.
  - If either bounded read fails, exit nonzero and identify each unavailable source on stderr. Label any returned results partial and advertise a name as attachable only after its collision check succeeds.
  - Cover mixed inventory, collisions, empty inventory, and failure of either source through the command path. Update the Brood subsystem contract and operator docs. Explain the `march/<name>` convention, the unprefixed argument to `march brood attach`, and the host-terminal requirement for attachment.

**PR Outcome**: Operators can identify candidate attach names and tracked spawn IDs in a single listing and can tell when either source is unavailable.

---

## Specification Debt

_None — no specification debt was recorded._

## Open Implementation Questions

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | Which tmux outcomes distinguish a stopped server from a socket permission failure in Castra's deployment? | S1 | testing | local |

## Dependency Order

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | List Interactive Sessions and Tracked Spawns | — | — |

### Cross-Story Dependencies

None. The listing uses live inventory and Brood read views independently of the attach command.

### Cross-Repo Notes

None.
