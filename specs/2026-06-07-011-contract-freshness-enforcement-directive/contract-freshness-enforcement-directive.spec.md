# Feature Specification: Contract-Freshness Enforcement Directive

**Spec Folder**: `2026-06-07-011-contract-freshness-enforcement-directive`
**Branch**: `feature/smithy/mark/layered-testing-framework-m2-f6`
**Created**: 2026-06-07
**Status**: Draft
**Input**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` Feature 6: Contract-Freshness Enforcement Directive, reconciled against the source feature map present in this checkout.
**Source Feature Map**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` - Feature 6: Contract-Freshness Enforcement Directive

## Clarifications

### Session 2026-06-07

- This spec is reconciled against the source feature map (`docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md`), whose Feature 6 entry defines the CI-side enforcement vehicle for the freshness verdict as a **Smithy-agent directive** — the operator's SD-002 resolution toward a directive rather than a GitHub Actions workflow for this milestone.
- Feature 5 owns the single local verdict authority (`npm run docs:contracts:check`), running both the presence and freshness halves and the populated `contract-freshness.config.json` source-glob → contract mapping. Feature 6 invokes that shared verdict unchanged so local and enforced verdicts cannot diverge; it does not reimplement presence, section-schema, freshness-config, or drift logic.
- This feature defines a Smithy-agent directive and its PR-handling behavior. It does not stand up CI infrastructure, implement AUTOGEN extraction (Feature 7), author contract prose (Features 2/3/4), or change runtime subsystem behavior.
- The directive follows March's autonomous-component posture in `docs/vision.md` and `docs/operating-philosophy.md`: it runs non-interactively, uses minimum local access, and exits cleanly (fail-closed) rather than prompting or hanging — consistent with "Smithy decomposes; March executes".
- Per the feature map, the directive is **cheaply reversible** to a `.github/workflows/contract-freshness.yml` workflow if drift slips through, and the structural AST-diff escalation path is deferred (RFC SD-002) until drift is actually observed.

## Artifact Hierarchy

RFC → Milestone → Feature → User Story → Slice → Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: Block PRs that stale a subsystem contract (Priority: P1)

As the Operator-as-Test-Author, I want a Smithy-agent directive to fail any PR that
touches a subsystem's public source without updating the corresponding
`contract.md`, so that contract drift is caught at the moment the PR introduces it
rather than after merge.

**Why this priority**: Feature 5 creates the deterministic verdict authority. The
enforcement directive is the vehicle that makes that authority actually gate work;
without it, the verdict is advisory tooling nobody is required to run.

**Independent Test**: Run the directive against a fixture PR diff that changes a
mapped public source path but leaves its `contract.md` untouched, and verify the
directive invokes `npm run docs:contracts:check`, observes the non-zero verdict,
and reports a blocking failure that names the drifted source/contract pair.

**Acceptance Scenarios**:

1. **Given** a PR diff that changes a source path mapped in `contract-freshness.config.json` without touching its `contract.md`, **When** the directive runs, **Then** it invokes F5's verdict and reports a blocking failure.
2. **Given** a PR diff that updates both the mapped source and its `contract.md`, **When** the directive runs, **Then** the verdict passes and the directive does not block.
3. **Given** a PR diff that touches no mapped public source, **When** the directive runs, **Then** the verdict passes and the directive does not block.

---

### User Story 2: Delegate the verdict to Feature 5 (Priority: P1)

As a contract maintainer, I want the directive to invoke Feature 5's shared verdict
authority unchanged rather than re-deriving its own freshness logic, so that the
locally-runnable verdict and the enforced verdict can never diverge.

**Why this priority**: A second, independent checker is the classic source of
"green locally, red in enforcement" drift. Pinning enforcement to F5's single
command is what makes the verdict trustworthy.

**Independent Test**: Inspect the directive artifact and verify it names
`npm run docs:contracts:check` as the verdict command, contains no second parser or
freshness comparison, and does not invoke `docs:contracts:extract`.

**Acceptance Scenarios**:

1. **Given** a contract verdict must be computed, **When** the directive runs, **Then** it calls `npm run docs:contracts:check` rather than implementing its own presence or freshness check.
2. **Given** Feature 5's verdict command is unavailable or renamed, **When** the directive runs, **Then** it reports a clean blocking failure naming the missing command instead of falling back to an ad hoc checker.
3. **Given** AUTOGEN content is stale, **When** the directive is evaluated, **Then** it does not refresh generated regions or require Feature 7 behavior.

---

### User Story 3: Enforce non-interactively and fail-closed (Priority: P1)

As the Operator, I want the directive to run inside a Smithy agent without prompts,
network calls, or live March service dependencies, so that an autonomous slice fails
cleanly instead of hanging or asking for input.

**Why this priority**: `docs/operating-philosophy.md` requires autonomous components
to avoid interactive surfaces and exit cleanly on failure. An enforcement step that
blocks on input would stall the deterministic dispatch loop.

**Independent Test**: Run the directive in a repository fixture with no network,
Docker daemon, or live Hatchery/Brood/Herald/Castra/Legate/agent-deck endpoints and
verify it completes using only local filesystem, git, and the F5 npm script.

**Acceptance Scenarios**:

1. **Given** the directive runs in an agent sandbox, **When** enforcement starts, **Then** it uses only local filesystem and git state plus the F5 verdict command.
2. **Given** required local inputs are missing or the verdict errors, **When** enforcement fails, **Then** it exits non-zero with bounded diagnostics rather than prompting the operator.
3. **Given** live March services are unavailable, **When** the directive runs, **Then** their unavailability neither blocks nor changes the verdict.

---

### User Story 4: Record the SD-002 vehicle decision and scope boundary (Priority: P2)

As a future maintainer, I want the directive to carry the operator-decision record
that SD-002 resolved toward a directive (not a CI workflow) for this milestone, and
to explicitly exclude the workflow alternative and the AST-diff escalation, so that
the chosen enforcement surface and its reversibility are legible later.

**Why this priority**: SD-002 is resolved toward "directive not CI workflow" but the
reasoning and the deferred alternatives must be captured where the next maintainer
will look, so a later pivot to a workflow is a deliberate, cheap reversal rather than
a rediscovery.

**Independent Test**: Review the directive artifact and verify it records the SD-002
resolution, names the `.github/workflows/contract-freshness.yml` alternative as
out of scope, and notes the deferred structural AST-diff escalation.

**Acceptance Scenarios**:

1. **Given** the SD-002 decision, **When** the directive is authored, **Then** it records that the milestone chose a Smithy-agent directive over a CI workflow.
2. **Given** drift could later slip through, **When** the decision record is read, **Then** it states that reverting to a `.github/workflows/contract-freshness.yml` workflow is a cheap, deliberate alternative.
3. **Given** RFC SD-002 defers the structural AST-diff escalation until drift is observed, **When** the directive is authored, **Then** it does not implement that escalation.

### Edge Cases

- A PR edits only documentation or files outside the freshness mapping.
- A PR edits a `contract.md` without touching any mapped source.
- The changed-file set cannot be derived because the local git base is missing.
- The F5 npm script is absent, renamed, or exits before producing a verdict.
- Multiple subsystems drift in a single PR.
- The agent sandbox has no network, Docker daemon, or live service endpoints.
- Whether the directive is review-advisory or merge-blocking is unsettled (see SD-011).

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| US1 | Block PRs that stale a subsystem contract | — | — |
| US2 | Delegate the verdict to Feature 5 | US1 | — |
| US3 | Enforce non-interactively and fail-closed | US1 | — |
| US4 | Record the SD-002 vehicle decision and scope boundary | US1 | — |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The directive MUST instruct the Smithy agent to fail any PR that changes a subsystem's mapped public source without updating the corresponding `contract.md`.
- **FR-002**: The directive MUST compute its verdict by invoking Feature 5's shared authority via `npm run docs:contracts:check`, unchanged.
- **FR-003**: The directive MUST NOT reimplement contract presence checking, required-section checking, freshness-config validation, changed-file comparison, or source-to-contract ownership resolution.
- **FR-004**: The directive MUST treat any non-zero verdict as a blocking failure before the slice is reported complete.
- **FR-005**: The directive MUST allow PRs that touch no mapped public source, or that update both the mapped source and its contract, to pass when the F5 verdict passes.
- **FR-006**: The directive MUST run non-interactively and MUST NOT prompt the operator for approval, missing inputs, or repair choices.
- **FR-007**: The directive MUST fail cleanly (non-zero, bounded diagnostics) when the verdict command is unavailable, exits non-zero, times out, or emits malformed output.
- **FR-008**: The directive MUST use deterministic local filesystem and git inputs and MUST NOT depend on live Docker, Hatchery, Brood, Herald, Castra, Legate, agent-deck, or network services.
- **FR-009**: The directive MUST preserve enough diagnostic context (affected source path, owning contract path, owner when known) for a later repair step to update the right artifact.
- **FR-010**: The directive MUST NOT implement AUTOGEN extraction, generated signature replacement, runtime service behavior, or merge automation.
- **FR-011**: The feature MUST record the operator decision that SD-002 resolved toward a Smithy-agent directive (not a `.github/workflows/contract-freshness.yml` CI workflow) for this milestone, and note that reverting to a workflow is a cheap alternative.
- **FR-012**: The feature MUST NOT implement the structural AST-diff escalation path, which RFC SD-002 defers until drift is observed.
- **FR-013**: The directive's rationale MUST cite `docs/vision.md` and `docs/operating-philosophy.md` for why enforcement is non-interactive and fail-closed.

### Key Entities

- **Enforcement Directive**: The Smithy-agent instruction that decides when a PR must run the contract verdict and how a failed verdict blocks completion.
- **Contract Verdict Invocation**: One execution of `npm run docs:contracts:check` from the agent's PR-handling context.
- **Enforcement Result**: The pass/fail outcome and bounded diagnostics the agent reports for the PR.
- **SD-002 Decision Record**: The recorded operator resolution choosing the directive over a CI workflow, with the workflow as a cheap reversal.

## Assumptions

- Feature 5 supplies the authoritative `npm run docs:contracts:check` command, the populated freshness mapping, and the diagnostic vocabulary for presence and drift.
- Smithy agents can run npm scripts and git commands in the repository checkout they are already modifying.
- The enforcement surface is directive-level and repository-local; no remote service is needed to decide pass or fail.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-011 | Carried forward from the feature map: whether the Smithy-agent directive enforces at PR-review time (advisory, lives in agent instructions) or as a blocking pre-merge gate (non-zero exit wired into the merge path). SD-002 is resolved toward "directive not CI workflow" but does not settle review-advisory vs merge-blocking. | feedback:Risks (SD-002 sub-question) | Medium | Medium | open | — |

## Out of Scope

- Implementing or changing the Feature 5 contract verdict command or its freshness mapping.
- Authoring subsystem contract prose or changing the contract freshness configuration.
- Adding a `.github/workflows/contract-freshness.yml` GitHub Actions workflow (the alternative SD-002 vehicle, not chosen for this milestone).
- Implementing the structural AST-diff escalation path (RFC SD-002 defers it until drift is observed).
- Implementing AUTOGEN extraction or generated public-interface replacement (Feature 7).
- Standing up CI infrastructure or merge automation, or changing Steward handoff behavior.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A PR that changes a mapped public source without updating its `contract.md` is blocked by the directive via the F5 verdict.
- **SC-002**: A PR that updates both the mapped source and its contract, or touches no mapped source, passes the directive.
- **SC-003**: The directive runs in a local fixture without network, Docker, or live March services and fails cleanly on bad input.
- **SC-004**: The directive delegates verdict computation to Feature 5 and contains no duplicate checker logic.
- **SC-005**: The feature records the SD-002 directive-vs-workflow decision and the deferred AST-diff escalation so the enforcement surface remains legible and reversible.
