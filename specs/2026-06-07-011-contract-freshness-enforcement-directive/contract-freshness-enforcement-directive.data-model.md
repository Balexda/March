# Data Model: Contract-Freshness Maintenance Convention

## Overview

This model supports the reframed Feature 6: a **maintenance convention** that keeps
subsystem contract docs current at edit time, rather than an enforcement directive
that fails PRs. It defines the convention artifact, the edit-time contract update it
expects, the deterministic auto-gen it references (owned by Feature 7), the opt-in
advisory verdict it leaves available (owned by Feature 5), and the recorded SD-002
decision to enforce nothing automatically. No entity here gates a PR, slice, or
merge, and none introduces an AI/LLM step that runs on every check-in.

## Entities

### 1) Contract Maintenance Convention (`contract_maintenance_convention`)

Purpose: Represents the repository convention that a subsystem's `contract.md` is
kept current as part of the change that alters that subsystem's public surface.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `appliesWhen` | trigger rule | Yes | A change alters a subsystem source path mapped in `contract-freshness.config.json`. |
| `mechanism` | enum set | Yes | `{ smithy-edit-time, deterministic-autogen }` — how the doc stays current. |
| `nonInteractive` | boolean | Yes | Always true; the convention requires no prompts. |
| `gating` | enum | Yes | Always `none`; the convention never fails or blocks a PR/slice/merge. |
| `referencedIn` | doc path list | Yes | `CONTRIBUTING.md`, `CLAUDE.md`, `AGENTS.md`. |

Validation rules:

- `gating` must be `none`; the convention must not define a blocking verdict.
- `mechanism` must not include an AI/LLM step that runs on every check-in.
- The convention must not require prompts, live service readiness, or network access.

### 2) Edit-Time Contract Update (`edit_time_contract_update`)

Purpose: Represents the same-change update of a subsystem's `contract.md` performed
by the author or Smithy agent that altered its public surface.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `subsystem` | identifier | Yes | The subsystem whose surface changed. |
| `contractPath` | repo-relative path | Yes | The owning `contract.md` updated in the same change. |
| `sourcePathsChanged` | repo-relative path list | Yes | Mapped public-source paths the change touched. |
| `updatedInSameChange` | boolean | Yes | True when the contract was updated alongside the source. |

Validation rules:

- When `sourcePathsChanged` includes a mapped public-source path, the convention expects `updatedInSameChange` to be true.
- A false value is a convention reminder for the author/reviewer, not an automated failure.

### 3) Deterministic Contract Autogen Reference (`contract_autogen_reference`)

Purpose: Represents the deterministic generator the convention points to for the
mechanically-derivable regions of a contract. The mechanism is owned by Feature 7;
this entity is only the reference.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `generator` | literal command | Yes | `npm run docs:contracts:extract` (Feature 7). |
| `sourceKind` | enum | Yes | `fastify-endpoints` or `exported-ts-signatures`. |
| `deterministic` | boolean | Yes | Always true; ordered output that does not churn on cosmetic moves. |
| `aiInLoop` | boolean | Yes | Always false; no LLM/AI step participates. |

Validation rules:

- `aiInLoop` must be false; the generator must be deterministic.
- The convention references this generator; it must not reimplement Feature 7's extraction.

### 4) Opt-In Freshness Check (`optin_freshness_check`)

Purpose: Represents Feature 5's verdict command as an advisory local check the
contributor MAY run — never a gate.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `command` | literal command | Yes | `npm run docs:contracts:check` (Feature 5). |
| `advisory` | boolean | Yes | Always true. |
| `blocksCompletion` | boolean | Yes | Always false; the verdict never blocks a PR/slice/merge. |
| `runBy` | enum | Conditional | `contributor` when run; no autonomous agent is required to run it. |

Validation rules:

- `blocksCompletion` must be false; the check is informational only.
- No autonomous agent or CI job may be required to run this command as a gate.

### 5) SD-002 Decision Record (`sd002_decision_record`)

Purpose: Represents the recorded operator decision that this milestone enforces
contract freshness with **no automatic gate**, relying on edit-time maintenance plus
deterministic auto-gen.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `chosenVehicle` | enum | Yes | `maintenance-convention` (no enforcement gate). |
| `rejectedAlternatives` | enum list | Yes | `smithy-agent-enforcement-directive`, `github-actions-workflow` (`.github/workflows/contract-freshness.yml`). |
| `reversibility` | bounded text | Yes | Re-adding either rejected alternative is cheap and deliberate if drift slips through. |
| `deferredEscalation` | bounded text | Yes | Structural AST-diff escalation deferred (RFC SD-002) until drift is observed. |
| `closedSubQuestion` | reference | Yes | SD-011 closed as moot: with no gate, enforcement strength is not a question. |

Validation rules:

- The record must name both rejected alternatives and state their reversibility.
- The record must not implement the deferred escalation; it only documents the deferral.

## Relationships

- One Contract Maintenance Convention expects zero or more Edit-Time Contract Updates across changes.
- One Contract Maintenance Convention references one Deterministic Contract Autogen Reference (Feature 7) for mechanical regions and one Opt-In Freshness Check (Feature 5) as advisory tooling.
- One SD-002 Decision Record provides the milestone-scoped decision context for the convention: it records that the chosen vehicle is a maintenance convention, not an enforcement gate. It introduces no runtime gating — the convention's `gating` is `none` and the Opt-In Freshness Check's `blocksCompletion` is always false.

## State Transitions

### Subsystem contract doc freshness lifecycle

The lifecycle describes a contract doc's currency relative to its mapped surface. It
is maintained by convention; no transition is enforced by an automated gate.

1. `current` → `needs-update`
   - Trigger: A change alters the subsystem's mapped public surface.
   - Effects: The convention expects the same change to update the `contract.md`.

2. `needs-update` → `current`
   - Trigger: The author/Smithy agent updates the `contract.md` in the same change, and the deterministic extractor refreshes any mechanical regions.
   - Effects: The contract doc is current again. No verdict is required to record this.

3. `needs-update` → `needs-update` (advisory)
   - Trigger: A contributor optionally runs `npm run docs:contracts:check`.
   - Effects: The check reports drift as advice; it does not block the change.

## Identity & Uniqueness

- A Contract Maintenance Convention is a single, repository-scoped artifact keyed by `(repo, milestone)`.
- An Edit-Time Contract Update is identified within a change by `(subsystem, contractPath)`.
- The SD-002 Decision Record is a single, milestone-scoped record keyed by `(milestone, chosenVehicle)`.
