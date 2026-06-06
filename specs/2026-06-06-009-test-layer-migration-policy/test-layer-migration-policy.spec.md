# Feature Specification: Test Layer Migration Policy

**Spec Folder**: `2026-06-06-009-test-layer-migration-policy`
**Branch**: `feature/smithy/mark/layered-testing-framework-m1-f4`
**Created**: 2026-06-06
**Status**: Draft
**Input**: `docs/rfcs/2026-002-layered-testing-framework/01-test-legibility-staged-ci.features.md` Feature 4, with RFC context from `docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md`.
**Source Feature Map**: `docs/rfcs/2026-002-layered-testing-framework/01-test-legibility-staged-ci.features.md` — Feature 4: Test Layer Migration Policy

## Clarifications

### Session 2026-06-06

- This feature is a **written policy only**: a "Test Layer Migration" heading in `CONTRIBUTING.md` that enumerates verbatim the conditions under which a governed pre-existing vitest L2 test must be ported to Cucumber.js, plus the recorded starting state of those tests. It does **not** perform any port and does **not** introduce runtime code, a deferral-record system, or an audit command. [Critical Assumption]
- The policy is a **"Cucumber-on-first-material-change" trigger, not a preemptive port** (RFC §Design Considerations and §M1 criteria, line 145): the governed tests stay in vitest until the next material change touches them, at which point the change PR ports the affected scenario to Cucumber.js. The actual port is M3-and-later work and is out of scope here.
- The governed files are the two surviving L2-shaped vitest files Feature 1 tagged `@l2 @deterministic @ci` in place: `src/spawn/container-launch.test.ts` and `src/spawn/snapshot-build.test.ts`. The RFC gap-analysis baseline (2026-05-20) and feature map additionally named `src/hatchery/legate-container.test.ts`, but that file (and its source `src/hatchery/legate-container.ts`) was deleted in commit `6983f5f` when the per-profile legate docker-run path was retired (#256). It no longer exists, so the policy cannot govern it; the upstream mismatch is logged as SD-002 for reconciliation. [Critical Assumption]
- The corrected premise inherited from Feature 1 is that the governed tests **mock `node:child_process` and exercise no real Docker** — earlier documentation mischaracterized them as exercising real Docker. The policy records this corrected starting state.
- "Material change" is scoped to a **semantic edit of a governed test file** — its assertions, the mocked process behavior it sets up, its fixtures, or the subsystem boundary it drives. The trigger keys on an edit to the governed test file itself (RFC line 86 — a material change must "touch" the test): a change to production code or shared helpers that does **not** edit a governed test file does not by itself trigger a port. Non-semantic edits (formatting, comments, import sorting, tag-block edits, mechanical renames that preserve the test contract) do **not** trigger a port. The conditions must be precise enough that PR authors and reviewers do not relitigate "material change" on every diff.
- This feature does **not** redefine Feature 1's tag taxonomy, Feature 2's staged scripts, or Feature 3's quarantine routing. It references them as context where needed but owns none of them.

## Artifact Hierarchy

RFC -> Milestone -> Feature -> User Story -> Slice -> Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: Author the Test Layer Migration Policy (Priority: P1)

As the Maintainer of the testing framework, I want a written "Test Layer Migration" policy in `CONTRIBUTING.md` that enumerates verbatim the conditions under which a pre-existing vitest L2 test must be ported to Cucumber.js, so that the migration trigger is a stable, citable rule rather than a per-PR judgment call.

**Why this priority**: This is the feature's central deliverable. The RFC's M1 acceptance criteria require the material-change policy to be recorded in `CONTRIBUTING.md` under a "Test Layer Migration" heading; without it, the three L2-shaped vitest tests have no defined migration trigger and the staged framework's "Cucumber for L2" promise has no on-ramp.

**Independent Test**: Open `CONTRIBUTING.md`, locate the "Test Layer Migration" heading, and confirm it enumerates a verbatim, finite list of conditions that classify a change to a governed test as material (port-triggering) versus non-material (no port).

**Acceptance Scenarios**:

1. **Given** `CONTRIBUTING.md`, **When** a contributor looks for the migration rule, **Then** a "Test Layer Migration" heading exists and is discoverable from the `## Testing` section.
2. **Given** the policy text, **When** it is read, **Then** it enumerates verbatim the conditions that make an edit to a governed test file material — at minimum changes to its assertions, mocked process behavior, fixtures, or the subsystem boundary it drives.
3. **Given** the policy text, **When** non-semantic edits (formatting, comments, import sorting, tag-block edits, mechanical renames) are checked against it, **Then** the policy states explicitly that those do not trigger a port.
4. **Given** the policy text, **When** no triggering condition is met, **Then** the policy states the governed tests stay in vitest with no preemptive port.

---

### User Story 2: Record the Starting State of the Governed Tests (Priority: P1)

As a Test Author, I want the policy to record which tests it governs and their corrected starting state, so that I can tell at a glance whether a file I am touching is subject to the migration trigger and what its current shape actually is.

**Why this priority**: The trigger conditions (US1) are only actionable if the governed set is named unambiguously. Feature 1 corrected the long-standing mischaracterization that these tests exercise real Docker; recording the corrected premise here prevents a future author from "fixing" a test against a false assumption.

**Independent Test**: Read the policy and confirm it names the governed files exactly and states that each is tagged `@l2 @deterministic @ci`, mocks `node:child_process`, exercises no real Docker, and remains in vitest until a material change.

**Acceptance Scenarios**:

1. **Given** the policy, **When** the governed set is read, **Then** it names exactly `src/spawn/container-launch.test.ts` and `src/spawn/snapshot-build.test.ts`.
2. **Given** the policy, **When** the starting state is read, **Then** it records that the governed tests are tagged `@l2 @deterministic @ci` in place, mock `node:child_process`, and exercise no real Docker.
3. **Given** the policy, **When** a file outside the governed set is touched, **Then** the policy makes clear the migration trigger does not apply to it.

---

### User Story 3: Apply the Policy on a Touching PR Without Relitigation (Priority: P2)

As a CI Failure Triager and reviewer, I want a Test Author touching a governed file to self-determine port-or-not from the written rule, so that "what counts as a material change" is settled by citation rather than re-argued on each diff.

**Why this priority**: The user-facing value of the policy is decision-without-debate. This story validates that the enumerated conditions are precise enough to be applied by an author and a reviewer to a concrete diff and reach the same answer — the outcome RFC line 86 demands.

**Independent Test**: Take a sample diff that changes a governed test's assertions and a second sample diff that only reformats it; apply the policy to each and confirm the first is classified material (port required) and the second non-material (no port), with the policy text as the sole basis.

**Acceptance Scenarios**:

1. **Given** a PR that edits a governed test file's assertions, mocked command behavior, fixtures, or the subsystem boundary it drives, **When** the author applies the policy, **Then** the change is classified as material and a Cucumber.js port of the affected scenario is required by the policy.
2. **Given** a PR that only reformats, re-comments, re-sorts imports, or edits the tag block of a governed test, **When** the author applies the policy, **Then** the change is classified as non-material and no port is required.
3. **Given** the same diff, **When** an author and a reviewer each apply the policy independently, **Then** they reach the same material/non-material classification from the written conditions without external clarification.

### Edge Cases

- A change touches helper, fixture, or production code exercised by a governed test but does not edit the governed test file itself; per the resolved trigger scope (SD-001), this does not by itself trigger a port — the trigger fires only when a governed test file receives a material edit. (Such a change may still warrant a test update on its own merits; that is outside this migration policy.)
- A governed test file is renamed without semantic change; the policy classifies a pure rename as non-material so it does not force a port.
- A single PR materially changes more than one governed file; the policy applies independently to each affected file.
- The actual Cucumber.js port mechanics (step-definition library, cassette substrate) do not exist yet at M1; the policy states the trigger and the required outcome, and defers the porting infrastructure to M3+.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| US1 | Author the Test Layer Migration Policy | — | — |
| US2 | Record the Starting State of the Governed Tests | — | — |
| US3 | Apply the Policy on a Touching PR Without Relitigation | US1, US2 | — |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The policy MUST be recorded in `CONTRIBUTING.md` under a "Test Layer Migration" heading.
- **FR-002**: The policy MUST name the governed tests exactly: `src/spawn/container-launch.test.ts` and `src/spawn/snapshot-build.test.ts`. (The RFC/feature-map baseline also named `src/hatchery/legate-container.test.ts`, removed in #256 — see SD-002; it MUST NOT be named as a governed test.)
- **FR-003**: The policy MUST enumerate verbatim the conditions that make a **semantic edit of a governed test file** material — at minimum changes to its assertions, mocked process behavior, fixtures, or the subsystem boundary it drives. The trigger MUST key on an edit to a governed test file itself; a change to production code or shared helpers that does not edit a governed test file MUST NOT by itself trigger a port.
- **FR-004**: The policy MUST enumerate the non-material change classes — formatting, comment-only edits, import sorting, tag-block edits, and mechanical renames that preserve the test contract.
- **FR-005**: The policy MUST state that a material change to a governed test triggers a Cucumber.js port of the affected scenario in the same change PR.
- **FR-006**: The policy MUST state that, absent a material change, the governed tests remain in vitest with no preemptive port.
- **FR-007**: The policy MUST record the corrected starting state: the governed tests are tagged `@l2 @deterministic @ci` in place, mock `node:child_process`, and exercise no real Docker.
- **FR-008**: The enumerated conditions MUST be precise enough that a PR author and a reviewer applying them to the same diff reach the same classification without relitigating "material change."
- **FR-009**: The policy MUST NOT require an immediate or preemptive Cucumber.js port of any governed test.
- **FR-010**: The policy MUST NOT redefine Feature 1's tag taxonomy, Feature 2's staged scripts, or Feature 3's quarantine routing; it may reference them as context only.

### Key Entities

- **Test Layer Migration Policy**: The written `CONTRIBUTING.md` section that defines the migration trigger and records the governed tests' starting state.
- **Governed Legacy L2 Test**: One of the surviving child-process-mocked vitest files (`src/spawn/container-launch.test.ts`, `src/spawn/snapshot-build.test.ts`) tagged `@l2 @deterministic @ci` by Feature 1 and subject to the migration trigger.
- **Triggering Condition**: An enumerated, verbatim condition that classifies a change to a governed test as material and therefore port-triggering.
- **Starting-State Record**: The recorded fact that the governed tests are `@l2`-tagged in place, mock `node:child_process`, exercise no real Docker, and stay in vitest until a material change.

## Assumptions

- Feature 1 has already tagged the governed tests `@l2 @deterministic @ci` in place and corrected the "real Docker" mischaracterization in `CONTRIBUTING.md` and `docs/testing-strategy.md`; this feature builds on that corrected premise rather than re-establishing it. (Feature 1's spec also tagged `src/hatchery/legate-container.test.ts`, since deleted in #256 — see SD-002.)
- The framework target for a triggered port is Cucumber.js, per the RFC's locked per-scope framework choice (vitest for L0/L1, Cucumber.js for L2/L3); this feature names that target but does not build the porting infrastructure.
- The Cucumber.js step-definition library and cassette substrate that a real port would consume are delivered by M3 and later; this policy only defines the trigger and required outcome.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Does the migration trigger key on edits to the governed test file itself, or on any change that alters the governed test's exercised behavior (including edits to helpers, fixtures, or production code it covers)? The verbatim conditions must pick one to stay unambiguous on a PR. | clarify:Edge Cases | Medium | Low | resolved | Resolved 2026-06-06 (PR #282 review) — the trigger keys on a material **edit to a governed test file itself**, matching RFC line 86 ("a material change touches the test"). A production-code or shared-helper change that does not edit a governed test file does not by itself trigger a port. FR-003, US3, and the Edge Cases reflect this. |
| SD-002 | The RFC gap-analysis baseline (2026-05-20), the feature map, and the merged Feature 1 spec (`specs/2026-05-23-006-tag-taxonomy-and-coverage-lint`, FR-011) all name `src/hatchery/legate-container.test.ts` as a governed L2 test, but that file and its source were deleted in commit `6983f5f` (#256, retiring the per-profile legate docker-run path). This spec narrows the governed set to the two surviving files; the upstream artifacts still reference the removed file and should be reconciled. | review:Staleness | Medium | High | open | — |

## Out of Scope

- The actual Cucumber.js port of any of the governed tests (triggered on first material change; the porting infrastructure is M3 and later).
- The Feature 1 day-one tag disposition of the governed tests and the broader `CONTRIBUTING.md` tag/script/quarantine references owned by Features 1–3.
- Any runtime code, deferral-record store, or audit/overdue-reporting command — this feature is a written policy, not an enforcement mechanism.
- Defining or modifying the staged npm scripts and CI fan-out (Feature 2) or quarantine routing (Feature 3).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A contributor can locate the "Test Layer Migration" policy in `CONTRIBUTING.md` and identify the governed tests from it.
- **SC-002**: A PR author can classify a change to a governed test as material or non-material using only the enumerated verbatim conditions.
- **SC-003**: An author and a reviewer applying the policy to the same diff reach the same classification without external clarification.
- **SC-004**: The policy records the corrected starting state (tests mock `node:child_process`, exercise no real Docker, stay in vitest until a material change) with no claim that they exercise real Docker.
- **SC-005**: No governed test is ported preemptively as part of this feature.
