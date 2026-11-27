# Steward Contract

The Steward is the Castra-hosted manager role that consumes validated Spawn output after Hatchery has a successful spawn result. It is a documented role boundary for deciding whether that validated output may become an interactive manager session, not a standalone TypeScript subsystem, HTTP service, CLI command, or agent-deck adapter.

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

### GitHub credential shim

Castra puts the provisioned `gh` and Git shims first on the host steward's
`PATH` for new and relaunched sessions. Install `march` on the host
`PATH` and place the steward's Tessera client key in
`~/.march/steward/tessera-client-key` (mode `0600`, owned by the host steward
user). The launcher uses the Tessera listener on host loopback.

On each invocation the `gh` shim
resolves the worktree's GitHub `origin`, requests an app/write token, and runs
the real executable with the original arguments, inherited standard streams
and a private temporary configuration directory. It supplies the issued
token as `GH_TOKEN`, clears inherited GitHub token variables, and fails
closed with a sanitized diagnostic if setup or issuance fails. The real
executable runs under a deadline (default 10 minutes, overridable with a
positive integer `MARCH_TESSERA_GH_TIMEOUT_MS`); on expiry the shim kills it
and exits nonzero with `Tessera gh: real executable timed out.`

GitHub SSH remotes and HTTPS remotes resolve to credential-free HTTPS URLs
for the same repository. Git requests app/write credentials with repository
context through the [Tessera Git helper](../tessera/contract.md#cli-and-configuration).
The Git shim requires Git 2.31 or later and refuses to run on older Git. It
isolates host Git authentication and disables prompts: `HOME` mirrors the
operator's home without `.netrc`, `.gitconfig`, `.git-credentials` or Git's
XDG `config`/`credentials`. It keeps the operator's non-credential global
settings, such as identity, signing and `core.hooksPath`, and drops global
`credential.*`, `http.*`, `url.*` and `remote.*` settings. It reads repository
settings for the repository selected by leading `-C`, `-c`, `--git-dir` and
`--work-tree` options. Only the repository operand (and `push --repo`) of
`clone`, `fetch`, `pull`, `push` and `ls-remote` is rewritten; refspecs and
other operands are left unchanged. Git's SSH command is replaced by a guard
that refuses any SSH connection to GitHub, whether reached through an alias,
an unusual URL spelling or an `ssh_config` host alias resolved with `ssh -G`.
It passes other hosts to the operator's `GIT_SSH_COMMAND`, `GIT_SSH` or
`ssh`; a repository `core.sshCommand` is not used. The `ext::` transport is
disabled.
Hatchery uses the same repository-scoped Steward entitlement for the verified
push and deterministic GitHub PR publication.

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

`src/hatchery/spawn-handoff.ts` drives the Steward handoff through the Castra
client in `src/castra/client.ts`. To create a PR, Hatchery sends the Steward the
verified commit, pushed branch and a fresh review receipt ID. The Steward
reviews the commit and reports `REVIEW <receipt ID> <passed|unavailable|failed>`
on a separate line. The receipt carries verification status. For a planning
verb (`cut`, `render`, `mark`, `strike`, `ignite`) the Steward also checks
whether the change gates a slice on an unresolved decision. Ordinary spec debt
does not count. If it does, the Steward prints one `STEERING:` line per
question (the question, its options and trade-offs, and the slices it blocks),
reports `REVIEW <receipt ID> steering` and ends with a `NEED:` line. Hatchery
opens the PR as a draft with the `march:needs-steering` label. Once the human
answers, the Steward applies the decision to the spec or task file, pushes,
removes the label and marks the PR ready (`gh pr ready`), which re-arms the
merge. Hatchery
publishes from validated handoff facts after an approving receipt and returns
the typed GitHub outcome to the caller.

| Consumer verb | Client method | Consumer | Steward use |
|---------------|---------------|----------|-------------|
| `launch` | `launchSession` | `spawn-handoff.ts` | Starts the Castra-hosted manager session for the target worktree, branch, profile/session metadata, and slice/spawn correlation. |
| `send` | `sendPrompt` | `spawn-handoff.ts` | Sends the Steward role prompt context to the launched session. |
| `output` | `sessionOutput` | `spawn-handoff.ts`, `observe/sense-io.ts` | Reads bounded session output for the current review receipt or observation. |
| `remove` | `removeSession` | `spawn-handoff.ts` | Removes the hosted interactive session when the handoff boundary needs teardown. |

This contract does not duplicate Castra's server routes or response bodies. Castra owns those `/v1/sessions*` wire shapes; Steward only depends on the client methods above being the consumer surface for the launch handoff and bounded output observation.

### Cross-Contract Ownership Boundaries

| Provider boundary | Provider contract | Steward relationship | Ownership rule |
|-------------------|-------------------|----------------------|----------------|
| Spawn | `docs/subsystems/spawn/contract.md` | Steward consumes successful, non-empty, validated Spawn output as the patch handoff artifact. | Spawn owns backend-output parsing, validation, unsafe-output rejection, and no-op detection; Steward owns applying validated output to the correlated worktree and reporting a bounded role outcome. |
| Hatchery | `docs/subsystems/hatchery/contract.md` | Hatchery invokes the handoff path and supplies session/profile metadata, role prompt context, branch, worktree, spawn id, and slice id. | Hatchery owns dispatch service and handoff invocation behavior; Steward owns hosted manager role semantics after launch eligibility has been satisfied. |
| Brood | `docs/subsystems/brood/contract.md` (future) | Brood records parent spawn and Steward session lifecycle evidence used for cleanup and recovery. | Brood owns lifecycle registry rows, parent/child tracking, and teardown authority; Steward owns the role outcome facts tied to that correlation. |
| Herald | `docs/subsystems/herald/contract.md` (future) | Herald carries Steward attachment and correlation facts for observers. | Herald owns event append, projection, and cursor behavior; Steward owns only the semantics of the Steward role state being reported. |
| Castra | `docs/subsystems/castra/contract.md` (future) | Castra hosts, prompts, observes, and removes the interactive session through its client/server boundary. | Castra owns HTTP/session routes, authentication, response envelopes, agent-deck hosting, and removal; Steward owns the hosted role semantics and permitted outcomes. |
| Legate | `docs/subsystems/legate/contract.md` | Legate observes Steward attachment, loss, timeout, or terminal outcome as part of the autonomous loop. | Legate owns loop observation, babysit, relaunch, terminal, and merge/archive decisions; Steward owns the session outcome facts that Legate consumes. |

These boundaries are owner pointers for L2 tests and future freshness mapping. They do not define provider route tables, request or response schemas, event append rules, projection or cursor behavior, Legate loop rules, Hatchery dispatch service behavior, Brood teardown ordering, Castra server internals, or Spawn validation internals. Readers should follow the provider contracts for those public interfaces; this contract documents only Steward-owned launch eligibility, role semantics, patch application, PR-ready outcome semantics, and bounded failure reporting.

### Freshness Binding

Future Steward freshness belongs to the role-consumer partition made from `src/castra/client.ts` plus `src/hatchery/spawn-handoff.ts`. No standalone `src/steward/` source module owns Steward freshness because Steward is a Castra-hosted role boundary, not a separate runtime subsystem.

The Castra server route surface, including `src/castra/server.ts`, remains outside the Steward freshness partition and stays owned by Castra's contract. Brood, Herald, and Legate service, registry, event, projection, cursor, and loop surfaces remain owned by their respective contracts and by the Feature 2 and Feature 3 contract tracks that define those providers. This section records the future binding hint only; it does not implement a freshness checker, update freshness config, populate AUTOGEN content, add CI enforcement, or change runtime behavior.

### Generated Session Settings

Every Steward session loads one generated settings file, `<steward root>/settings.json` (default `~/.march/steward/settings.json`), through `claude --settings`. `buildStewardSettings(root, env)` in `src/castra/steward-skills.ts` produces its content and Castra rewrites it at serve start, so a change applies to Stewards launched after the next Castra start.

The file carries the `Notification` and `Stop` self-report hooks, plus an `env` block that tunes Claude Code's compaction and prompt-cache lifetime so an idle Steward compacts before its cache expires:

| Claude Code variable | Default | Operator override |
|------|---------|-------------------|
| `CLAUDE_CODE_PROMPT_CACHE_TTL` | `1h` | `MARCH_SESSION_CACHE_TTL` (`5m` or `1h`) |
| `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` | `100000` | `MARCH_SESSION_IDLE_COMPACT_MIN_TOKENS` (raised to `100000` if lower) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `200000` | `MARCH_SESSION_AUTO_COMPACT_WINDOW` (clamped to `100000`–`1000000`) |

An unparseable override falls back to the default. `MARCH_SESSION_COMPACTION` set to `0`, `false`, or `off` omits the `env` block entirely, leaving Claude Code's stock behavior. The defaults and parsing live in `src/shared/claude-session-env.ts`.

The overrides are read from the environment of the process that writes the file, which for Stewards is Castra.

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

Herald `slice.steward.attached` is the correlation event boundary. The event carries the slice, session, spawn, branch, and worktree correlation needed by observers; the profile fact is not on this event and stays scoped to the Brood row and Castra session, so consumers must not assert profile against the Herald envelope. Herald owns event append, projection, and cursor behavior in its own contract.

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
- Steward lifecycle correlation is observable through the Steward session id, parent spawn id, slice id, profile, branch, and worktree facts. These facts are split across boundaries: Herald's `slice.steward.attached` event carries the slice, session, spawn, branch, and worktree correlation, while the Castra/agent-deck profile is a Brood- and Castra-scoped fact and is not part of the Herald event envelope.
- Brood registration is the lifecycle registry boundary for parent spawn and Steward session records; Steward does not take ownership of Brood's row model or teardown registry.
- Herald `slice.steward.attached` is the correlation event boundary; Steward does not take ownership of Herald's event append or projection semantics.
- Castra session identity remains the hosted interactive-session identity and not Steward-owned route state.
- Steward disappearance, stall, timeout, and unreachable-session cases are observable failure states for Legate or Brood consumers without transferring ownership of their loop, registry, or teardown behavior.
- Following the intervention-avoidance framing in `docs/vision.md` and the clean-exit rules in `docs/operating-philosophy.md`, the autonomous Steward role must not wait indefinitely on unavailable input. Failure outcomes are terminal diagnostics or evented states with bounded detail.
- L2 tests may assert Steward-owned launch eligibility, role semantics, patch-application promises, PR-ready branch-state semantics, and bounded failure outcomes from this contract. They must follow the Spawn, Hatchery, Brood, Herald, Castra, and Legate contracts for provider-specific public interfaces rather than scraping provider route tables, event append rules, loop rules, or validation internals from Steward prose.
- Steward freshness is pinned for future tooling to `src/castra/client.ts` and `src/hatchery/spawn-handoff.ts`; no standalone `src/steward/` module owns Steward freshness, and provider service or loop surfaces stay outside this contract's freshness partition.

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
| Cross-contract ownership drift | Steward prose that starts duplicating provider routes, event append behavior, loop rules, service internals, or Spawn validation internals is a contract-maintenance error; tests should assert the boundary and follow the provider contract for those details. |
| Freshness ownership drift | Freshness mapping to a nonexistent `src/steward/` module, Castra server routes, or Brood/Herald/Legate service and loop surfaces is a contract-maintenance error; the Steward binding is `src/castra/client.ts` plus `src/hatchery/spawn-handoff.ts`. |

Patch application, PR-ready success/failure reporting, lifecycle registration, correlation, cleanup ownership, cross-contract boundaries, freshness binding, and loss/timeout boundaries are documented here without implementing Hatchery, Brood, Herald, Castra, Spawn, Legate, PR, freshness, CI, or runtime behavior.
