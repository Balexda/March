# Contracts: Contract-Freshness Enforcement Directive

## Overview

This feature defines the Smithy-agent enforcement boundary for subsystem contract
freshness. The directive consumes Feature 5's local `npm run docs:contracts:check`
verdict and turns a non-zero result into a blocking, bounded agent failure on the
PR. It introduces no live service API, runtime route, CI workflow, AUTOGEN
extraction behavior, or replacement logic — it is an instruction-level boundary
between Feature 5's verdict and the agent's PR-handling decision.

## Interfaces

### Contract-Freshness Enforcement Directive

**Purpose**: Defines how a Smithy agent must invoke the contract verdict before
completing a PR that can stale a subsystem contract.
**Consumers**: Smithy mark/cut/forge/fix-style agents, Hatchery-managed worker
sessions, Steward/reviewer handoff context.
**Providers**: Repository-local Smithy agent instruction artifacts.

#### Signature

```text
When a PR diff changes a watched public subsystem source, run:
npm run docs:contracts:check
A non-zero verdict blocks the PR until the owning contract.md is updated.
```

The enforcement command is Feature 5's npm-run verdict, invoked unchanged. The
directive must not replace it with a direct parser, a live service call, a CI
workflow, or a prompt-driven review step.

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoRoot` | filesystem path | Yes | Repository checkout where the agent is producing the PR. |
| `changedFiles` | repo-relative path list or git-derived diff | Conditional | Freshness input, supplied directly or derived by Feature 5's verdict command. |
| `verdictCommand` | literal command | Yes | `npm run docs:contracts:check`. |
| `agentContext` | task context | Yes | Current Smithy task and changed working tree / PR diff. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `status` | enum | `pass` when the verdict exits zero; `fail` otherwise. |
| `blocksCompletion` | boolean | True for any failed status. |
| `diagnostics` | diagnostic list | Bounded verdict or invocation findings. |
| `summary` | bounded text | Deterministic agent-facing enforcement result. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Verdict exits non-zero | Blocking failure | Preserve verdict diagnostics and stop completion. |
| Verdict command missing | Blocking failure | Report the unavailable command without trying an ad hoc checker. |
| Verdict times out | Blocking failure | Report the timeout as a clean failed result. |
| Verdict output malformed | Blocking failure | Report an invocation diagnostic with bounded context. |
| Live service unavailable | No special handling | Enforcement does not depend on live services. |

### Enforcement Diagnostic Envelope

**Purpose**: Defines the diagnostic facts the directive preserves when enforcement
blocks completion.
**Consumers**: Repair agents, reviewers, CI failure triagers, Hatchery manager
sessions.
**Providers**: Smithy-agent enforcement wrapper around Feature 5 verdict output.

#### Signature

```text
category: <presence|section-schema|config|freshness|invocation>
ownerName: <optional owner>
sourcePath: <optional repo-relative source path>
contractPath: <optional repo-relative contract path>
message: <bounded diagnostic>
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `verdictDiagnostics` | diagnostic list | Conditional | Diagnostics emitted by the Feature 5 verdict. |
| `invocationFailure` | failure fact | Conditional | Command missing, timeout, or malformed-output condition. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `category` | string | Stable failure category. |
| `ownerName` | string | Contract owner when known. |
| `sourcePath` | repo-relative path | Source path when relevant. |
| `contractPath` | repo-relative path | Contract path when relevant. |
| `message` | bounded text | Concise failure explanation. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Missing path in verdict | Preserve available fields | Do not invent ownership facts absent from the verdict. |
| Multiple diagnostics | Deterministic list | Keep bounded ordering from the verdict or sort by category and path. |
| Sensitive or unbounded output | Truncated diagnostic | Do not dump full logs, files, or contract bodies. |

### Repair Guidance Handoff

**Purpose**: Gives a later repair step enough path context to update the stale
contract after enforcement fails.
**Consumers**: Smithy fix/forge agents, reviewers, Hatchery manager sessions.
**Providers**: Enforcement result renderer.

#### Signature

```text
Contract enforcement failed. Update the named contract artifact(s), then rerun:
npm run docs:contracts:check
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `diagnostics` | diagnostic list | Yes | Blocking diagnostics from enforcement. |
| `contractPaths` | repo-relative path list | No | Unique contract paths named by diagnostics. |
| `sourcePaths` | repo-relative path list | No | Unique source paths named by diagnostics. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `nextCommand` | literal command | `npm run docs:contracts:check` after repair. |
| `affectedContracts` | path list | Deduplicated contract paths. |
| `affectedSources` | path list | Deduplicated source paths. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| No contract path available | Report generic repair guidance | The failed verdict still blocks completion. |
| Diagnostics disagree | Preserve all diagnostics | Do not collapse conflicting findings into one invented owner. |

## Events / Hooks

No runtime events or hooks are introduced by this feature. Enforcement happens
inside Smithy-agent instruction flow and local command execution. It does not add
Herald events, Hatchery routes, Brood records, Castra sessions, Legate loop actions,
CI workflows, or service callbacks.

## Integration Boundaries

- **Feature 5 contract verdict**: Owns presence, section-schema, freshness-config, and source/contract drift computation. Feature 6 invokes and interprets only pass/fail plus diagnostics — unchanged, so local and enforced verdicts cannot diverge.
- **Smithy agent instructions**: Own when an autonomous agent must run the verdict on a PR and how a failure blocks completion.
- **Hatchery and Steward**: May carry the enforcement result through manager/PR handoff, but receive no new service APIs from this feature.
- **Feature 7 AUTOGEN extraction**: Remains separate; Feature 6 does not run `docs:contracts:extract` or update generated regions.
- **SD-002 vehicle decision**: This milestone enforces via a Smithy-agent directive, not a `.github/workflows/contract-freshness.yml` GitHub Actions workflow; reverting to the workflow is a cheap, deliberate alternative, and the structural AST-diff escalation is deferred (RFC SD-002) until drift is observed.
- **Git and filesystem**: Enforcement relies on local repository state and the verdict command's deterministic changed-file inputs.
- **March operating philosophy**: Enforcement follows the non-interactive, minimum-access, clean-exit rules in `docs/vision.md` and `docs/operating-philosophy.md`.
