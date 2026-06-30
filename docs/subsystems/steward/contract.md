# Steward Contract

The Steward is the Castra-hosted manager role that consumes validated Spawn output after Hatchery has a successful spawn result. It is a documented role boundary for deciding whether that validated output may become an interactive manager session, not a standalone TypeScript subsystem, HTTP service, CLI command, or agent-deck adapter.

This slice does not introduce a contract checker, freshness checker, AUTOGEN generation, CI enforcement, runtime behavior, PR creation, push, or merge behavior.

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

### Role Boundary

Steward owns the launch eligibility and role semantics for a manager session that receives a validated patch result. Hatchery is the launch and handoff consumer boundary: it gathers the validated spawn result and launches the Steward role through Castra, but it does not own Steward's role semantics after the handoff.

Castra is the interactive session host. Its server-side `/v1/sessions*` wire shapes, authentication, error envelopes, and route behavior remain owned by Castra's contract; this contract names only the Castra client surface consumed for the Steward handoff.

### Launch Envelope

A Steward session may launch only when the launch envelope contains all of these facts:

| Fact | Requirement |
|------|-------------|
| Validated patch output | Non-empty Spawn output that has already passed Spawn-owned validation and is eligible to hand off. |
| Target worktree | The checkout where the manager session will operate. |
| Target branch | The branch correlated with the spawn result and later handoff. |
| Spawn id | The parent spawn identity used to correlate the handoff. |
| Slice id | The dispatch slice identity used for trace and event correlation. |
| Session/profile metadata | The Castra profile, group/session metadata, and other launch metadata needed to host the manager role. |
| Role prompt context | The prompt and constraints that tell the manager role what validated output it received and how to report a bounded outcome. |

The target worktree, target branch, spawn id, and slice id remain correlated for the Steward handoff. A consumer must not substitute one of those facts independently after validation because downstream observers need the same tuple to identify the launched role.

### Castra Client Surface

`src/hatchery/spawn-handoff.ts` drives the Steward handoff through the Castra client in `src/castra/client.ts`, consuming the `launch`, `send`, and `remove` methods. The `output` method is the bounded read used by the observation path (`src/observe/sense-io.ts`) rather than by the handoff itself; it is named here because reading a launched Steward session's output is part of the same Castra client surface:

| Consumer verb | Client method | Consumer | Steward use |
|---------------|---------------|----------|-------------|
| `launch` | `launchSession` | `spawn-handoff.ts` | Starts the Castra-hosted manager session for the target worktree, branch, profile/session metadata, and slice/spawn correlation. |
| `send` | `sendPrompt` | `spawn-handoff.ts` | Sends the Steward role prompt context to the launched session. |
| `output` | `sessionOutput` | `observe/sense-io.ts` | Reads bounded session output for diagnostics or handoff observation. |
| `remove` | `removeSession` | `spawn-handoff.ts` | Removes the hosted interactive session when the handoff boundary needs teardown. |

This contract does not duplicate Castra's server routes or response bodies. Castra owns those `/v1/sessions*` wire shapes; Steward only depends on the client methods above being the consumer surface for the launch handoff and bounded output observation.

### Patch Application

After launch, Steward consumes Spawn's validated patch result as an already accepted handoff artifact. Spawn continues to own raw backend-output parsing, validation, unsafe-output rejection, and no-op detection; Steward owns only the role semantics for applying that validated patch to the correlated repository state.

Steward's index-aware application mode is `git apply --index` from the target worktree. Success requires the target worktree and index, on the correlated target branch, to reflect the accepted patch. Steward must not report success from a worktree-only apply, an index-only apply, a different checkout, a different branch, or a partially accepted state.

Steward may report fallback, rejected-hunk, conflict, or unsupported-apply diagnostics only as bounded outcomes. A fallback is acceptable only when it preserves the same success contract: the expected worktree and index on the target branch contain the accepted patch. Rejected hunks, merge conflicts, unsupported patch forms, and apply attempts that cannot preserve index/worktree coherence are failed Steward outcomes, not prompts for interactive repair inside the autonomous role.

### Repository State Constraints

The launch envelope's target worktree and target branch remain the only repository state where Steward may apply the validated patch. Before reporting success, Steward must be able to correlate the active checkout to that worktree and branch. Missing worktrees, mismatched branches, dirty state unrelated to the accepted patch, incoherent index state, or evidence that the patch applies outside the allowed worktree are failed handoffs or terminal diagnostics.

These failures follow the low-touch execution model in `docs/vision.md` and the autonomous-component rules in `docs/operating-philosophy.md`: failures are clean exits, bounded diagnostics, or events, not hidden waits or approval prompts that the role cannot receive.

### Outcome Reporting

A PR-ready Steward outcome means the target branch, target worktree, and index contain the accepted patch and downstream integration may proceed. It is a branch-state report, not proof that a pull request has been created or merged.

PR creation, pushing, merging, and PR-tool invocation are owned by the manager session's delivery instructions or by a later integration boundary. This documentation slice introduces no PR command, runtime behavior, freshness checker, AUTOGEN extraction, CI enforcement, push, merge, or pull-request creation requirement.

Failed outcomes include patch-apply failure, dirty or missing worktree state, target branch mismatch, out-of-worktree application attempts, and incoherent index/worktree state. Each failure is terminal or evented with a bounded diagnostic that callers and tests can assert without reading an unbounded session transcript.

### Lifecycle Correlation

When a Steward session launches, its lifecycle tracking includes the Steward session id, parent spawn id, slice id, profile, branch, and worktree facts. Those facts are publishable for later observation and diagnostics; they do not make Steward the owner of Brood rows, Herald events, Castra session state, Spawn records, Hatchery jobs, or Legate loop decisions.

Brood is the lifecycle registry boundary for parent spawn records and Steward session records. Brood owns the durable parent/child tracking needed to connect the spawned work, the Steward session, the branch, and the worktree for later teardown or recovery.

Herald `slice.steward.attached` is the correlation event boundary. The event carries the slice/spawn/session correlation needed by observers, while Herald owns event append, projection, and cursor behavior in its own contract.

The Castra session id remains the hosted interactive-session identity. Steward consumes that identity as the manager role's session handle; it does not own Castra route state, agent-deck hosting behavior, or provider-specific session storage.

### Cleanup Boundary

Requested Steward removal crosses two owner boundaries. Castra owns removing the interactive Steward session. Brood owns exact cleanup ordering for the tracked worktree and branch tied to the spawn/steward correlation.

Cleanup must preserve enough correlation evidence to explain what was removed, deferred, failed, or already missing: parent spawn id, Steward session id, slice id, branch, worktree, and the relevant profile/session facts. Provider contracts remain the authority for route, registry, event, and loop details; this contract only states the Steward role boundary that callers and tests may assert.

Steward cleanup semantics do not require PR creation, push, merge, contract checking, freshness checking, CI changes, or new runtime behavior.

## Invariants

- Steward launches only for successful, non-empty, validated Spawn output. Spawn owns raw backend output parsing and validation internals; Steward consumes the validated-output result.
- Failed, malformed, missing, ambiguous, unsafe, or no-op Spawn output is not eligible for Steward launch.
- Launch refusal stops before a Castra-hosted Steward session starts.
- Refusals and missing launch facts surface as clean failed outcomes, bounded diagnostics, or events rather than interactive prompts inside the autonomous role.
- The launch envelope keeps worktree, branch, spawn id, and slice id correlated across the Hatchery-to-Castra handoff.
- Hatchery owns invoking the handoff path and passing session/profile metadata plus role prompt context; Steward owns the manager role semantics once launch eligibility has been satisfied.
- Steward applies validated patch output with index-aware repository semantics, with `git apply --index` as the named application mode.
- Steward success requires the expected target branch, worktree, and index to reflect the accepted patch.
- Steward must fail closed before success is reported when the target worktree is missing, the active branch does not match the handoff correlation, unrelated dirty state is present, the patch reaches outside the expected worktree, or the index and worktree cannot remain coherent.
- Fallback application paths are allowed only when they preserve the same target-branch, worktree, and index success state; otherwise conflicts, rejected hunks, unsupported patch forms, or partial applies are failed outcomes.
- PR-ready means downstream integration may proceed from the target branch state; Steward's contract does not require this feature to create, push, merge, or open a pull request.
- Steward lifecycle correlation is observable through the Steward session id, parent spawn id, slice id, profile, branch, and worktree facts published to the Brood and Herald boundaries.
- Brood registration is the lifecycle registry boundary for parent spawn and Steward session records; Steward does not take ownership of Brood's row model or teardown registry.
- Herald `slice.steward.attached` is the correlation event boundary; Steward does not take ownership of Herald's event append or projection semantics.
- Castra session identity remains the hosted interactive-session identity and not Steward-owned route state.
- Steward disappearance, stall, timeout, and unreachable-session cases are observable failure states for Legate or Brood consumers without transferring ownership of their loop, registry, or teardown behavior.
- Following the intervention-avoidance framing in `docs/vision.md` and the clean-exit rules in `docs/operating-philosophy.md`, the autonomous Steward role must not wait indefinitely on unavailable input. Failure outcomes are terminal diagnostics or evented states with bounded detail.
- Contract freshness mapping remains a downstream contract concern and is not specified by these slices.

## Error Modes

| Mode | Outcome |
|------|---------|
| Invalid Spawn output | Failed, malformed, missing, ambiguous, unsafe, or no-op output is refused before Steward launch. |
| Empty validated output | No Steward session launches because there is no patch payload to hand off. |
| Missing launch context | Missing worktree, branch, spawn id, slice id, session/profile metadata, or role prompt context produces a failed handoff diagnostic or event. |
| Mismatched launch context | A worktree, branch, spawn id, or slice id that does not match the validated handoff correlation produces a failed handoff diagnostic or event before launch. |
| Castra launch boundary failure | The failure is reported through the Hatchery/Castra handoff boundary as bounded diagnostics or evented state; this contract does not redefine Castra's route errors. |
| Dirty or missing target worktree | Steward reports a failed handoff or terminal diagnostic before success because the accepted patch cannot be proven against the expected checkout. |
| Target branch mismatch | Steward reports a failed handoff or terminal diagnostic because PR-ready state is defined only for the correlated target branch. |
| Patch apply conflict or rejected hunk | Steward reports a bounded failed-application diagnostic; it does not block on interactive conflict repair. |
| Unsupported apply form | Steward reports a bounded failed-application diagnostic unless a fallback can preserve the same target worktree and index success contract. |
| Out-of-worktree patch attempt | Steward reports a failed outcome and does not partially accept files outside the allowed target worktree. |
| Incoherent index/worktree state | Steward reports a failed handoff or terminal diagnostic because success requires both the worktree and index to reflect the accepted patch. |
| Brood registration failure | Parent spawn or Steward session registration failure is observable at the lifecycle registry boundary and does not silently erase the spawn/steward correlation evidence. |
| Herald correlation publish failure | Failure to publish `slice.steward.attached` is an event-boundary diagnostic; this contract does not redefine Herald append, cursor, or projection behavior. |
| Steward disappearance | A launched Steward session that disappears becomes an observable loss state for Legate or Brood rather than an indefinite wait. |
| Steward stall or timeout | A stalled or timed-out Steward session becomes a terminal diagnostic or evented state with bounded detail, aligned with `docs/vision.md` and `docs/operating-philosophy.md`. |
| Unreachable Steward session | A Castra session that cannot be reached remains Castra-owned session state, while Legate or Brood may consume the failure as observation or teardown evidence. |
| Cleanup failure | Castra removal or Brood cleanup failure preserves parent spawn, Steward session, slice, branch, worktree, and profile/session evidence for later observation or diagnostics. |

Contract freshness drift is intentionally left to a later Steward contract slice and its owning subsystem contracts. Patch application, PR-ready success/failure reporting, lifecycle registration, correlation, cleanup ownership, and loss/timeout boundaries are documented here without implementing Hatchery, Brood, Herald, Castra, Spawn, Legate, PR, or runtime behavior.
