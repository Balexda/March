# Feature Specification: Interactive Session Attach Helper

**Spec Folder**: `2026-11-22-017-interactive-session-attach-helper`\
**Branch**: `feature/smithy/mark/march-orchestration-platform-m3-f5`\
**Created**: 2026-11-22\
**Status**: Draft\
**Input**: [March Orchestration Platform RFC, Milestone 3](../../docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md)\
**Source Feature Map**: `docs/rfcs/2026-001-march-orchestration-platform/03-brood.features.md` — Feature 5: Interactive Session Attach Helper

## Clarifications
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

### Session 2026-11-22

| Topic | Interpretation |
|-------|----------------|
| Interactive session authority | The feature map's architecture note assigns discovery and target resolution to Castra. Existing Castra session list and show calls use profile and agent-deck ID. The attach name is a separate operator-facing selector. |
| Namespace | `march/<name>` is the documented selection convention. Castra resolves the name to a live target on its tmux server. This feature does not rename or create sessions to populate the namespace. |
| Terminal access | The attach invocation runs on the host with access to Castra's tmux server, including from an SSH terminal. This follows the RFC's host-attach criterion and the operator CLI model in [March Vision](../../docs/vision.md) and [Operating Philosophy](../../docs/operating-philosophy.md). |

## Artifact Hierarchy
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

RFC → Milestone 3 → Feature 5 → User Story → Slice → Tasks

## User Scenarios & Testing
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: optional -->

### User Story 1: Attach to an Interactive Session (Priority: P1)

As an operator on the interactive-session host, I want to attach by name so I can inspect and interact with a running conductor from my terminal.

**Why this priority**: Terminal attachment is the RFC's operator acceptance criterion for interactive sessions.

**Independent Test**: Provide a tracked spawn ID and a live Castra-managed attach target. Invoke the command for each from a host terminal and observe the rejection and attachment respectively.

**Acceptance Scenarios**:

1. **Given** a live Castra-managed session advertised as `march/conductor` and a terminal with access to that tmux server, **When** I run `march brood attach conductor`, **Then** the terminal attaches to that exact session and detaching leaves it running.
2. **Given** a tracked spawn ID, including one that collides with an interactive name, **When** I pass the ID to `march brood attach`, **Then** the command exits nonzero before attempting attachment and reports “spawns are headless; use `march brood logs <id>`” with the supplied ID.
3. **Given** an unknown, ambiguous, or vanished target, **When** I try to attach, **Then** the command exits nonzero with a diagnostic identifying the failure and opens no other session.
4. **Given** tmux is unavailable, the host socket or terminal is inaccessible, or a required service lookup fails, **When** I try to attach, **Then** the command exits nonzero with a diagnostic identifying the failed prerequisite.

### User Story 2: Discover Interactive Sessions Alongside Spawns (Priority: P2)

As an operator, I want one list of attachable names and tracked spawns so I can choose an interactive target or identify the spawn whose logs I need.

**Why this priority**: Discovery helps operators find the name to attach to. Operators who already know the name can attach directly.

**Independent Test**: Supply one tracked spawn and Castra inventory containing an eligible live session, an unrelated session, and a stale entry. Run the listing with each source healthy and with the interactive inventory empty or unavailable.

**Acceptance Scenarios**:

1. **Given** the sources in the independent test are healthy, **When** I run `march brood sessions`, **Then** I see the live `march/` session's attach name alongside the tracked spawn ID with their kinds distinguishable. Unrelated and stale interactive entries are omitted. A live name equal to a tracked spawn ID is shown as unavailable, with the spawn-ID collision as the reason, and is not advertised as attachable.
2. **Given** there are no live `march/` sessions, **When** I list sessions, **Then** the command succeeds, displays an empty interactive section or message, and preserves the spawn results.
3. **Given** Castra or the Brood read source fails or times out, **When** I list sessions, **Then** the command exits nonzero, identifies the unavailable source, and labels any available results as partial.

### Edge Cases

- A tracked spawn ID takes precedence over an equal attach name, regardless of spawn status. `march brood sessions` lists such a name as unavailable. This feature defines no alternative selector, so the session cannot be attached by that name until it is renamed.
- Target disappearance between resolution and attachment produces the same failure as an unavailable target. Attachment uses the stable session ID resolved by Castra, not the name, so a replacement session with the same name is never attached.
- A healthy tmux installation with no running session server or no eligible sessions yields an empty interactive inventory. Missing tmux or a permission failure is an inventory error.

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| US1 | Attach to an Interactive Session | — | — |
| US2 | Discover Interactive Sessions Alongside Spawns | — | — |

## Requirements
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: recommended -->

### Functional Requirements

- **FR-001 (US1, US2)**: The operator documentation MUST define `march/<name>`, the host-terminal requirement, and the `<name>` argument accepted by `march brood attach`.
- **FR-002 (US1)**: The CLI MUST reject tracked spawn IDs before interactive attachment. If it cannot check whether the input is a spawn ID, it MUST fail before handoff.
- **FR-003 (US1)**: The CLI MUST delegate lookup of an exact live interactive target to Castra and hand the operator's terminal to that target by its stable session ID. Detach MUST leave the target running.
- **FR-004 (US1, US2)**: Lookup and inventory calls MUST have bounded failure paths and actionable diagnostics. Successful attachment lasts until normal detach or termination of the terminal session.
- **FR-005 (US2)**: The CLI MUST present Castra's live `march/` inventory and Brood's tracked spawn results in a single read-only view. The view MUST distinguish a successful empty result from an unavailable source. It MUST mark interactive names that collide with tracked spawn IDs as unavailable.

## Assumptions
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- Castra can expose live names from the tmux server it owns. Its current session-list envelope does not supply the required live attach target.
- The headless-spawn diagnostic references the `march brood logs <id>` contract owned by Feature 2. Feature 5 has no dependency on that command at execution time.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Out of Scope
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- Session creation, renaming, teardown, and runtime onboarding.
- New Brood session kinds, registry schema changes, and persisted interactive inventory.
- An embedded TUI, remote terminal proxy, or changes to the top-level `march sessions` command.

## Success Criteria
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- **SC-001**: From a host terminal, a listed name that is not marked unavailable attaches to exactly one live session and leaves it running on detach.
- **SC-002**: Every tracked spawn ID in the acceptance cases exits nonzero with its logs command, including when an interactive name collides.
- **SC-003**: Listing combines both sources, omits ineligible targets, succeeds for a healthy empty interactive inventory, and exits nonzero for source failures.
