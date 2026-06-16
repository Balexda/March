# Contracts: Contract-Freshness Maintenance Convention

## Overview

This feature defines the **convention** by which subsystem contract docs stay current,
not an enforcement boundary that fails PRs. The convention keeps a subsystem's
`contract.md` current at edit time — the Smithy agents used for most edits already
maintain affected docs, and the mechanically-derivable regions are refreshed by
Feature 7's deterministic extractor. It introduces no live service API, runtime route,
CI workflow, blocking verdict, or AI-on-check-in step. Feature 5's verdict remains
available as an opt-in, advisory local check.

## Interfaces

### Contract Maintenance Convention

**Purpose**: Defines how a subsystem's `contract.md` is kept current as part of the
change that alters its public surface.
**Consumers**: Contributors, Smithy mark/cut/forge/fix-style agents, reviewers.
**Providers**: Repository convention plus its references in `CONTRIBUTING.md`,
`CLAUDE.md`, and `AGENTS.md`.

#### Signature

```text
When a change alters a subsystem's mapped public surface, update that subsystem's
contract.md in the same change. Mechanical regions are refreshed by Feature 7's
deterministic extractor. No PR, slice, or merge is gated on a freshness verdict.
```

The convention does not introduce a blocking gate, a CI workflow, or an AI step that
runs on every check-in.

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `changedSources` | repo-relative path list | Yes | Mapped public-source paths the change touches. |
| `subsystem` | identifier | Conditional | The subsystem whose surface changed, when one is touched. |
| `agentContext` | task context | Conditional | The Smithy task making the edit, when an agent authors the change. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `contractUpdateExpected` | boolean | True when a mapped public surface changed and its `contract.md` should be updated in the same change. |
| `gated` | boolean | Always false; the convention never blocks completion. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Mapped surface changed, contract not updated | Convention reminder | Surface as author/review guidance; do not fail the PR. |
| Feature 5 / Feature 7 tooling absent | Degrade to manual upkeep | The convention still applies via manual edit-time maintenance. |
| Live service unavailable | No special handling | The convention depends on no live services. |

### Deterministic Autogen Handoff (Feature 7)

**Purpose**: Points the convention at Feature 7's deterministic extractor for the
mechanically-derivable regions of a contract.
**Consumers**: Contributors and Smithy agents refreshing a contract's generated
regions.
**Providers**: Feature 7's `docs:contracts:extract` tool (referenced, not implemented
here).

#### Signature

```text
Refresh mechanical contract regions (Fastify endpoints, exported TS signatures) with:
npm run docs:contracts:extract
Deterministic and ordered; no AI/LLM step participates.
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sourceKind` | enum | Yes | `fastify-endpoints` or `exported-ts-signatures`. |
| `targetContract` | repo-relative path | Yes | The `contract.md` whose generated regions are refreshed. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `deterministic` | boolean | Always true; output is ordered and does not churn on cosmetic moves. |
| `aiInLoop` | boolean | Always false; no LLM step participates. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Extractor not yet present | Degrade to manual upkeep | The convention does not depend on the extractor existing. |
| Non-deterministic output requested | Reject | The mechanism must remain deterministic; ownership stays with Feature 7. |

### Opt-In Freshness Check (Feature 5)

**Purpose**: Leaves Feature 5's verdict available as an advisory local check a
contributor may run.
**Consumers**: Contributors who want a local sanity check.
**Providers**: Feature 5's `docs:contracts:check` command (referenced, not changed
here).

#### Signature

```text
Optional local sanity check (advisory, non-blocking):
npm run docs:contracts:check
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoRoot` | filesystem path | Yes | Repository checkout being changed. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `advisory` | boolean | Always true. |
| `blocksCompletion` | boolean | Always false; the verdict never gates a PR/slice/merge. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Verdict reports drift | Inform only | Report as advice; do not block the change. |
| No autonomous agent runs it | Expected | No agent or CI job is required to run the check. |

## Events / Hooks

No runtime events or hooks are introduced by this feature. Maintenance happens inside
ordinary editing and local command execution. It adds no Herald events, Hatchery
routes, Brood records, Castra sessions, Legate loop actions, CI workflows, or service
callbacks.

## Integration Boundaries

- **Feature 5 contract verdict**: Remains the local verdict authority; this feature leaves it available as an opt-in, advisory check and never wires it as a gate.
- **Feature 7 deterministic extractor**: Owns mechanical region population (`docs:contracts:extract`); this feature only references it for the auto-gen mechanism.
- **Smithy agent instructions**: Own the edit-time documentation maintenance the convention rides on; updating a subsystem's `contract.md` is part of the same change that alters its surface.
- **Contributor guides**: `CONTRIBUTING.md`, `CLAUDE.md`, and `AGENTS.md` reference the convention and state there is no per-PR freshness gate.
- **SD-002 vehicle decision**: This milestone enforces nothing automatically. Both the Smithy-agent enforcement directive and the `.github/workflows/contract-freshness.yml` workflow are rejected-but-cheaply-reversible alternatives, and the structural AST-diff escalation is deferred (RFC SD-002) until drift is observed. SD-011 (enforcement strength) is closed as moot.
- **Git and filesystem**: The convention relies only on local repository state; it needs no live services.
- **March operating philosophy**: The convention follows the non-interactive, minimum-access, clean-exit rules in `docs/vision.md` and `docs/operating-philosophy.md`.
