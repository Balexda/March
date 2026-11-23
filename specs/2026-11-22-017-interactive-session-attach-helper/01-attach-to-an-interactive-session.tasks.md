# Tasks: Attach to an Interactive Session

**Source**: `specs/2026-11-22-017-interactive-session-attach-helper/interactive-session-attach-helper.spec.md` — User Story 1
**Data Model**: `specs/2026-11-22-017-interactive-session-attach-helper/interactive-session-attach-helper.data-model.md`
**Contracts**: `specs/2026-11-22-017-interactive-session-attach-helper/interactive-session-attach-helper.contracts.md`
**Story Number**: 01

---

## Slice 1: Attach to an Exact Live Session

<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Let an operator attach from a host terminal using `march brood attach <name>`.

**Justification**: Ship Castra's resolver with its CLI consumer so the same change delivers a usable operator command. Keep prerequisite checks bounded and the interactive handoff in the operator CLI. [March vision](../../docs/vision.md) · [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-001–FR-004, AS 1.1–1.4, SC-001–SC-002.

### Tasks

- [ ] **Resolve live attach targets in Castra**

  Add authenticated exact-name resolution to the Castra server and client for AS 1.1, AS 1.3, and AS 1.4. Resolve against the live tmux server Castra uses, since the existing list and show surfaces return agent-deck records.

  _Acceptance criteria:_
  - A single exact eligible `march/<name>` match returns its stable tmux session ID and display name. Missing, stale, unrelated, and ambiguous matches yield no usable target.
  - Bound the tmux lookup and HTTP request. Distinguish unknown and ambiguous targets from authentication, runtime, and service failures, with diagnostics that identify the failed prerequisite.
  - Cover exact resolution and these failure paths in Castra tests. Document the new surface in the Castra subsystem contract.

- [ ] **Guard attachment with Brood's tracked spawn views**

  Wire the attach verb in `src/cli/program.ts` and keep guard logic in Brood. Use the existing Brood read client for AS 1.2 and AS 1.4.

  _Acceptance criteria:_
  - Accept one valid unprefixed exact name. Invalid input exits nonzero with a diagnostic.
  - Read tracked spawn views across all statuses before Castra lookup. A matching spawn ID takes precedence over a live name and exits nonzero with the logs command containing the supplied ID.
  - A failed, invalid, or timed-out Brood read exits nonzero with a Brood diagnostic and prevents handoff. Cover collision, terminal spawn status, and read failure through the command path.

- [ ] **Hand the host terminal to the resolved session**

  Keep terminal handoff in Brood and use the Castra resolution result for AS 1.1, AS 1.3, and AS 1.4. Document the command in the operator-facing Brood docs and update the Brood subsystem contract.

  _Acceptance criteria:_
  - Attach with the caller's terminal I/O to the stable ID on the same tmux server Castra queried. Normal detach exits zero and leaves the session running.
  - A vanished ID, inaccessible socket or terminal, unavailable tmux, failed lookup, or failed attach exits nonzero with an actionable stderr diagnostic. A replacement that reuses the display name stays untouched.
  - Verify detach from a host terminal and cover vanished or replaced targets and failed prerequisites in regression tests.
  - Explain the `march/<name>` namespace, the unprefixed CLI argument, and the requirement for a host terminal with access to Castra's tmux server.

**PR Outcome**: An operator who knows a live attach name can enter and detach from the exact session. Failures return a diagnostic and a nonzero exit.

---

## Specification Debt

<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Open Implementation Questions

<!-- audience: builder; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | How does host attachment select the same tmux socket Castra queried, including from SSH or inside another tmux server? | S1 | testing | local |

## Dependency Order

<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Attach to an Exact Live Session | — | — |

### Cross-Story Dependencies

None — this story is self-contained.

### Cross-Repo Notes

None — single repo.
