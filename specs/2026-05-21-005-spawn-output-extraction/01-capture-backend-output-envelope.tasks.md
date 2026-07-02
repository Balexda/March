# Tasks: Capture Backend Output Envelope

**Source**: `specs/2026-05-21-005-spawn-output-extraction/spawn-output-extraction.spec.md` - User Story 1
**Data Model**: `specs/2026-05-21-005-spawn-output-extraction/spawn-output-extraction.data-model.md`
**Contracts**: `specs/2026-05-21-005-spawn-output-extraction/spawn-output-extraction.contracts.md`
**Story Number**: 01

---

## Slice 1: Bounded Envelope Capture From Terminal Spawn Output

**Goal**: Introduce the spawn output extraction module's first backend-neutral boundary: given a stopped successful spawn and an injected output source, capture a bounded raw output envelope tied to the spawn id, recorded backend, output source, and truncation state.

**Justification**: Capture is the first independently useful increment for F5. It gives later validation and persistence slices a deterministic, size-bounded input without introducing patch validation, Brood result storage, or Steward handoff in the same PR. The slice follows March's intervention-avoidance rules by failing cleanly on unavailable output and by bounding diagnostics instead of blocking or reading untrusted output without limit.

**Addresses**: FR-001, FR-002, FR-006, FR-013, FR-014; Acceptance Scenarios 1.1, 1.4, 1.5.

### Tasks

- [x] **Add a spawn-owned output capture module**

  Add the initial extraction module under the spawn subsystem. It should accept terminal spawn context and an output-source adapter, refuse nonterminal or nonzero-exit spawns, read output through the adapter, apply a configured capture limit, and return a backend-neutral envelope or a clean failed capture result.

  _Acceptance criteria:_
  - Capture accepts the recorded spawn id, backend name, terminal status, exit code, worktree path, output-source label, and an injected output reader.
  - Capture refuses any spawn that is not in a terminal stopped state with exit code 0, satisfying US1 AS 1.1 without relying on live Docker or Castra state.
  - Empty, whitespace-only, missing, or unreadable output produces a failed result with a bounded diagnostic and no patch artifact, satisfying US1 AS 1.4.
  - Output larger than the configured limit is bounded deterministically, reports `truncated: true`, and retains a diagnostic tail instead of unbounded raw output, satisfying US1 AS 1.5.
  - Successful capture returns a `SpawnOutputEnvelope`-shaped value containing spawn id, backend, source, bounded raw JSON text, truncation status, and capture timestamp.

- [x] **Cover envelope capture with source-adapter tests**

  Add focused tests for the capture module using injected output-source fixtures. The tests should prove lifecycle gating, empty-output failure, capture limiting, and deterministic truncation behavior without requiring Docker, Castra, or Hatchery services.

  _Acceptance criteria:_
  - Tests cover stopped exit-code-0 capture and assert the envelope is associated with the source spawn id and backend from the spawn context.
  - Tests cover running or failed spawn state rejection with a failed result rather than an uncaught exception.
  - Tests cover empty and unavailable output sources and assert no patch-like artifact is returned.
  - Tests cover over-limit output and assert both the bounded length behavior and `truncated: true`.
  - Existing spawn, Hatchery, and Brood tests continue to pass.

**PR Outcome**: The spawn subsystem can capture bounded backend output for a completed successful spawn through an injected source adapter — bounding over-limit output deterministically and reporting `truncated: true` rather than failing (US1 AS 1.5) — and can fail cleanly when output cannot be read. Later slices can parse and validate this envelope without touching container logs directly.

---

## Slice 2: Backend-Specific Envelope Parsers for Claude Code and Codex

**Goal**: Add the first backend-specific parsing adapters for the captured raw JSON envelope so Claude Code and Codex output can be normalized into a single candidate-patch shape for later validation.

**Justification**: Parser selection depends on the recorded backend and is separable from output capture. Keeping parser adapters in the same user-story artifact, but in a second slice, lets capture land first while still completing US1's backend-specific envelope requirements before patch validation begins.

**Addresses**: FR-002, FR-003, FR-004, FR-006, FR-014; Acceptance Scenarios 1.2, 1.3, 1.4.

### Tasks

- [x] **Introduce backend parser adapters selected by recorded backend**

  Extend the extraction module with parser adapters for the live supported backends. The parser layer should select behavior from the spawn record's backend name, parse only bounded captured JSON, and normalize successful backend output into an unvalidated candidate patch payload plus optional bounded summary metadata.

  _Acceptance criteria:_
  - Backend selection is driven by the recorded backend string, not by probing output contents, satisfying US1 AS 1.2 and AS 1.3.
  - Claude Code JSON output is parsed through a Claude-specific adapter and Codex JSON output is parsed through a Codex-specific adapter.
  - Unknown backend names and malformed backend JSON produce failed parser results with bounded diagnostics, not uncaught exceptions.
  - Parser output remains explicitly unvalidated; it does not validate patch paths, write `ExtractionResult`, apply patches, or launch Steward integration.
  - Parser diagnostics never include unbounded raw backend output.

- [x] **Add parser fixtures for Claude Code, Codex, and malformed output**

  Add tests that exercise representative Claude Code and Codex JSON envelopes and parser failure cases. Use fixtures small enough to make expected behavior obvious and keep validation concerns out of this slice.

  _Acceptance criteria:_
  - Tests prove Claude Code output is routed to the Claude adapter and yields one candidate patch payload.
  - Tests prove Codex JSON/JSONL-style output is routed to the Codex adapter and yields one candidate patch payload.
  - Tests prove malformed JSON, unsupported backend names, absent patch fields, and ambiguous candidate patches fail cleanly.
  - Tests assert the selected backend is preserved in diagnostics or result metadata so downstream failures can be attributed correctly.
  - No patch path validation or persistence assertions are added in this slice; those remain owned by later user stories.

**PR Outcome**: Captured envelopes from the two supported backends are parsed through backend-specific adapters into a normalized, still-untrusted candidate patch value, while malformed or unsupported output fails cleanly.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-002 | inherited from spec: The exact storage location for `ExtractionResult` must be reconciled with the live Brood registry and any legacy SpawnRecord JSON compatibility expectations before cutting implementation tasks. | Domain & Data Model | Medium | Medium | inherited | — |

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Bounded Envelope Capture From Terminal Spawn Output | — | — |
| S2 | Backend-Specific Envelope Parsers for Claude Code and Codex | S1 | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Validate Patch Payload | depended upon by | US2 consumes the unvalidated candidate patch produced by S2 and owns path safety, no-op rejection, and exactly-one-patch validation. |
| User Story 3: Persist Extraction Result | depended upon by | US3 consumes capture and parser failures to persist backend-neutral success or failure results; this story intentionally does not decide the storage location tracked by SD-002. |
| User Story 4: Hand Off Valid Patch to Steward Boundary | depended upon by | US4 must consume only a successful persisted extraction result after US2 and US3; raw captured output and unvalidated candidates from this story are not handoff inputs. |
