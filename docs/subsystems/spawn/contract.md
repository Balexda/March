# Spawn Contract

This contract defines the Spawn-owned dispatch, execution, terminal output,
validated handoff, cleanup, and externally visible failure boundary. It is
documentation-only: Hatchery, Brood, Castra, and Steward are named here only as
integration boundaries, and their HTTP routes, lifecycle authority,
session-hosting details, and role interfaces remain owned by their own
contracts.

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

Spawn accepts work from the operator-facing `march spawn` command and from the
Hatchery-managed spawn path. Both callers provide a prompt and repository
context. The prompt is the work instruction written into the spawn container.
Repository context includes the repository path and the worktree, base branch,
or dispatch branch needed to snapshot and execute the task in an isolated
workspace.

Caller-supplied dispatch metadata includes:

- `backend`: the selected `SpawnBackend` name and its launch contract.
- `profile`: the deployment profile used solely for telemetry tagging — the
  Legate deployment's profile, not the agent-deck session profile. The distinct
  `agentDeckProfile` field carries the Castra/agent-deck session context and is
  not the same value.
- `branch`: the dispatch or manager branch that correlates worktree, session,
  and downstream handoff state.
- `taskType`, `taskName`, and `title`: task identity fields suitable for
  operator diagnostics and trace attributes.
- `toolchain`: the optional per-profile worker toolchain override. `auto` or
  undefined infers the toolchain from the repository, while an explicit value
  (e.g. `node`, `jvm`) forces the toolchain layer image. Spawn resolves the
  spawn's base image as a function of the backend agent and this value, so
  non-node repositories can build in-container.
- `sliceId`: the Smithy slice correlation key; when present, Spawn uses it as
  the deterministic trace key so service-side observations for that slice can
  nest under the same trace.

Spawn allocates its own execution identity rather than accepting it from the
caller:

- `spawnId`: generated internally by `runHatcherySpawn` and used as Spawn's
  execution identity for container, image, worktree, branch, output artifact,
  lifecycle, and trace correlation. It is not a caller-supplied input.

The exported TypeScript surface is split between Spawn's execution primitives
and the Hatchery dispatch entrypoint that composes them:

- `SpawnBackend`, backend registry helpers, and credential-mount helpers define
  the backend launch surface. They select the agent image, required
  environment, credential mounts, network egress allowlist, and backend
  entrypoint command.
- Snapshot and image helpers create a Docker build context from the managed
  worktree, resolve the toolchain layer image for the selected backend and
  `toolchain` override, write the spawn Dockerfile, build the tagged spawn image,
  and remove the image during cleanup.
- Container launch helpers create, start, wait for, log, and remove the spawn
  container. They expose typed launch input and wait-result shapes plus bounded
  launch diagnostics.
- `runHatcherySpawn(input: HatcherySpawnOptions)` is the exported dispatch
  composition used by Hatchery. It accepts the required prompt, repository path,
  and backend plus optional deployment profile, agent-deck session profile,
  branch, task identity, toolchain override, and slice correlation fields, then
  returns a `HatcherySpawnResult` only after a terminal successful spawn output
  has been extracted, validated as a patch, and handed to the manager session.

Spawn's output handoff boundary is the validated patch artifact produced from
terminal successful backend output. Raw backend logs are not a public handoff
payload. Hatchery may submit or manage spawn work; Brood records lifecycle and
cleanup state; Castra hosts the manager session reached through Hatchery; and
Steward consumes only the validated handoff eligibility. This contract does not
define those provider surfaces.

## Invariants

- Accepted work has a prompt, repository context, a resolved backend, and a
  spawn identity before execution-specific artifacts are created.
- Spawn records enough metadata to correlate accepted work with backend,
  profile, branch, task identity, spawn identity, and slice identity when those
  fields are supplied.
- Execution either launches and waits for the backend container or fails before
  launch with a clean diagnostic.
- Terminal success means the backend container exited successfully and its
  terminal logs were captured before extraction.
- Terminal failure means launch, runtime, timeout, output, validation, handoff,
  or cleanup behavior produced an externally visible diagnostic or lifecycle
  failure record instead of blocking for operator input.
- Brood is the lifecycle record authority for managed session and cleanup state.
  Spawn behavior is observed through Brood-managed session records, spawn
  records, steward links, terminal states, and cleanup attempts rather than by
  reverse-engineering transient CLI control flow.
- Output extraction consumes only terminal successful spawn output. Nonterminal
  output and output from a failed backend run are diagnostics, not handoff
  material.
- Raw backend output is untrusted until validated. The accepted handoff payload
  is the decoded patch emitted by the deterministic sentinel path and checked
  for non-empty git-diff shape and safe repository-relative paths.
- Missing, malformed, ambiguous, unsafe, failed, or no-op output prevents
  Steward handoff.
- Validated handoff eligibility only states that Spawn produced an eligible
  patch for the downstream manager or Steward boundary. Steward-specific role
  inputs, review behavior, and PR workflow remain outside this contract.
- Cleanup is best-effort and observable. Container, image, branch, worktree, and
  manager-session cleanup attempts do not mask the original terminal outcome.
- Trace correlation follows the slice identity when available and otherwise the
  spawn identity. This contract records the expected correlation relationship
  without introducing new metrics, spans, labels, or runtime instrumentation.

## Error Modes

| Error mode | Externally visible outcome |
|------------|----------------------------|
| Missing required input | Dispatch is rejected with a clean diagnostic identifying the absent prompt, repository context, or backend selection. |
| Invalid backend metadata | Dispatch fails before launch with a diagnostic naming the unsupported backend or missing backend requirements. |
| Invalid profile metadata | Dispatch fails or is tagged as unknown/default according to the caller boundary; tests can assert a bounded diagnostic rather than an interactive prompt. |
| Missing repository context | Dispatch fails before snapshot or manager launch with a diagnostic that the repository path or worktree context is unavailable. |
| Dependency readiness failure | Missing git, Docker, backend credential, profile, Brood, Castra, or other required readiness is reported as a dependency diagnostic before unbounded work starts when that dependency is required for the path. Best-effort registrations remain nonblocking when their owning boundary defines them that way. |
| Image or build failure | The spawn reaches a failed dispatch outcome, build diagnostics are surfaced, and cleanup of image, worktree, branch, or related artifacts is attempted. |
| Container launch failure | Launch fails with a bounded diagnostic, any partially created container is removed best-effort, lifecycle evidence is retained, and no output extraction or handoff occurs. |
| Backend runtime failure | A nonzero backend exit is recorded as terminal failure; captured logs are diagnostic material only and manager or Steward handoff is not attempted. |
| Timeout | The wait is bounded, the container is force-removed best-effort, the spawn is marked failed or surfaced as a launch/runtime diagnostic, and execution does not hang. |
| Output capture failure | Failure to read terminal logs is reported as an output diagnostic; extraction and handoff do not proceed. |
| Validation failure | Missing sentinel output, malformed base64, decoded content without a git-diff header, unsafe paths, failed extraction, unsafe output, or no-op output all produce diagnostics and a no-handoff outcome. |
| Handoff failure | A validated patch that cannot be applied or sent to the manager boundary records the failure stage, preserves artifacts for diagnosis, attempts rollback cleanup, and does not claim successful handoff. |
| Cleanup failure | Cleanup diagnostics remain observable through lifecycle evidence, logs, records, or rollback warnings and do not mask the original terminal success or failure. |

All Spawn failures exit cleanly or surface events, records, logs, or bounded
diagnostics. Spawn does not ask an autonomous component for interactive recovery
input that it cannot receive.
