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

`src/hatchery/spawn-handoff.ts` consumes the Castra client in `src/castra/client.ts` for Steward handoff through these methods:

| Consumer verb | Client method | Steward use |
|---------------|---------------|-------------|
| `launch` | `launchSession` | Starts the Castra-hosted manager session for the target worktree, branch, profile/session metadata, and slice/spawn correlation. |
| `send` | `sendPrompt` | Sends the Steward role prompt context to the launched session. |
| `output` | `sessionOutput` | Reads bounded session output for diagnostics or handoff observation. |
| `remove` | `removeSession` | Removes the hosted interactive session when the handoff boundary needs teardown. |

This contract does not duplicate Castra's server routes or response bodies. Castra owns those `/v1/sessions*` wire shapes; Steward only depends on the client methods above being the consumer surface used by Hatchery's handoff path.

## Invariants

- Steward launches only for successful, non-empty, validated Spawn output. Spawn owns raw backend output parsing and validation internals; Steward consumes the validated-output result.
- Failed, malformed, missing, ambiguous, unsafe, or no-op Spawn output is not eligible for Steward launch.
- Launch refusal stops before a Castra-hosted Steward session starts.
- Refusals and missing launch facts surface as clean failed outcomes, bounded diagnostics, or events rather than interactive prompts inside the autonomous role.
- The launch envelope keeps worktree, branch, spawn id, and slice id correlated across the Hatchery-to-Castra handoff.
- Hatchery owns invoking the handoff path and passing session/profile metadata plus role prompt context; Steward owns the manager role semantics once launch eligibility has been satisfied.
- Later patch application, PR-ready branch state, lifecycle tracking, cleanup ordering, and contract freshness mapping are downstream contract concerns and are not specified by this launch slice.

## Error Modes

| Mode | Outcome |
|------|---------|
| Invalid Spawn output | Failed, malformed, missing, ambiguous, unsafe, or no-op output is refused before Steward launch. |
| Empty validated output | No Steward session launches because there is no patch payload to hand off. |
| Missing launch context | Missing worktree, branch, spawn id, slice id, session/profile metadata, or role prompt context produces a failed handoff diagnostic or event. |
| Mismatched launch context | A worktree, branch, spawn id, or slice id that does not match the validated handoff correlation produces a failed handoff diagnostic or event before launch. |
| Castra launch boundary failure | The failure is reported through the Hatchery/Castra handoff boundary as bounded diagnostics or evented state; this contract does not redefine Castra's route errors. |

Patch application failures, PR-ready success/failure reporting, lifecycle registration, cleanup ordering, and freshness drift are intentionally left to later Steward contract slices and their owning subsystem contracts.
