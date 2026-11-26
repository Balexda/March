# PRD: Pluggable Work Modules

**Created**: 2026-11-26  |  **Status**: Draft

## Problem Statement
<!-- audience: stakeholder; mode: explanation; length: 2-3 paragraphs; diagram: optional; examples: discouraged -->

The maintainer runs March across several profiles, and cannot add a new kind of work without editing the legate's control loop. March handles three kinds of work today, and each one is wired into the loop by hand. Smithy planning slices are the main one: the loop itself knows which planning nodes are ready, how to name a forge, cut, mark, or render dispatch, what to tell each steward, and which merge rules apply to each Smithy verb. The steward watchdog alone is about 1,170 lines (`handlers/babysit.ts`). Dependabot PRs arrive already open and have no implementation step, so they get their own handler of about 500 lines, with its own merge gate, label, and pacing (`handlers/dependency-merge.ts`). CodeRabbit re-review is a babysitting behavior with its own handler (`handlers/coderabbit-rereview.ts`). These flows share no common shape. Every change to one of them, and every new one, is a change to the core loop.

Issue triage makes this urgent. Triage (RFC 2026-003, in flight) produces a verdict, not a PR: labels plus one sticky note. It hands accepted issues to Smithy, and when the first artifact from an issue merges, the issue has to be closed. No current flow has that step, which reports back to where the work came from. Merge rules have the same problem. Today they are keyed to Smithy verbs inside a repository's profile. But the rules that decide whether an artifact can land belong to the place it lands: a GitHub repo, a GitHub issue, and later a Jira or Linear board, each with its own required approvals, checks, and tags. A Dependabot PR and a Smithy cut landing in the same repo should face that repo's rules, not rules owned by whichever flow produced them. It also blocks the open-core plan in `docs/open-core-boundary.md`, which keeps enterprise connectors such as Jira private. A private module can't ship if every kind of work has to be edited into the open core loop.

We want a new kind of work to be added as a module, without editing the core loop. Each module says what work it picks up, what instructions go with it, and how it responds when something goes wrong. Landing rules belong to the destination and match on the kind of item that is landing. The core keeps the safety rules that must hold whatever a module does: only non-destructive actions run automatically, teardown stays with the core, and stuck work still recovers. Existing flows move over one at a time, not in a single rewrite.

## Proposed Solution
<!-- audience: stakeholder; mode: explanation; length: 1-2 paragraphs; diagram: optional; examples: discouraged -->

March models all work as one pipeline: **discover → implement → steward → land → close out**. A work item can enter at any stage and skip the ones it doesn't need. A Dependabot PR enters at *land*. A triage verdict never opens a PR. Two kinds of module, each enabled and configured per profile, plug into that pipeline. **Producers** (Smithy, issue triage, Dependabot) discover work items and give each one its special instructions. They say what kind of item it is, and they register **responders** for when something needs fixing: Smithy registers `/smithy.fix`. **Destinations** (a GitHub repository and GitHub issues first; Jira and Linear later) are where artifacts land. A destination owns the rules for landing there, applied per repository or board and matched on item kind (for example "a `cut` needs no approval in this repo"). It also raises the **signals** that something needs attention. For a GitHub repo these come in the groups GitHub itself puts first on a PR (checks, comments and approvals), never as individual kinds of check or comment. Finally it performs the landing and reports when the artifact has landed. Close-out then runs at the item's origin, not at the artifact's destination.

The core runs the lifecycle in between. It pairs each destination signal with the producer's responder. It reports a landed artifact back to the item's origin, so an accepted issue closes when its first artifact merges. And it keeps the safety, recovery, teardown and tracing guarantees March has today, which no module can bypass. What the operator sees: turning on a new kind of work, or a new place for work to land, is a profile configuration change, not a change to the legate. Each repository's merge rules live in one place, whichever module produced the PR.

## Target Users
<!-- audience: stakeholder; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- **The maintainer/operator.** The one person running March across march, smithycli, and other profiles. Today they change the core loop to add or adjust any kind of work, and they configure merge rules per Smithy verb rather than per repository.
- **Module authors.** The maintainer writing the next producer (triage now), and the private March layer that will ship enterprise destinations such as Jira under the open-core boundary.
- **March's legate.** The machine consumer that has to run every kind of work through one lifecycle, without special-case handlers.

## Success Signals
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: optional -->

- Smithy runs as a module with no behavior change: existing tests stay green, and dispatch, merge, and dashboard outcomes match before and after the move.
- Issue triage moves to a producer module with no edits to the Smithy-specific or core lifecycle code. Its issues close automatically when their first artifact lands.
- Dependabot auto-merge becomes a source plus rows in the GitHub-repo destination's policy, and the dedicated `dependency-merge` handler is gone.
- The steward watchdog contains no producer-specific branches. Landing rules are configured per repository and item kind, not per Smithy verb.

## Alternatives / Build-vs-Buy
<!-- audience: reviewer; mode: explanation; length: 3-6 paragraphs; diagram: optional; examples: recommended -->

### Alternatives Considered

| Name | URL | Category | Fit | Why not |
|------|-----|----------|-----|---------|
| Optio | <https://github.com/jonwiggins/optio> | OSS platform (MIT, TypeScript/Fastify) | Partial | Closest in shape. It takes triggers from GitHub, GitLab, Linear and Jira, runs agents in a worktree, opens a PR, and follows CI and review. But it requires Kubernetes, Postgres, Redis and BullMQ, and it extends only through MCP, skills and prompt templates. It has no producer/destination module contract and no per-repo landing-policy plugins. Adopting it would replace March's core rather than extend it. |
| OpenHands (Agent Canvas) | <https://github.com/OpenHands/openhands> | OSS platform (MIT, self-hosted) | Partial | A self-hosted control center for coding agents. It has trigger automations and GitHub/Linear integrations; Jira is Enterprise-only. It has no plugin API for work sources or landing policy, and no discover → steward → land → close-out lifecycle with per-repo gates. |
| GitHub Copilot coding agent | <https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent> | SaaS | Poor | GitHub-hosted only. It handles one branch and one PR per task, and its sessions are capped at 59 minutes. It has no Jira or Linear destination. It breaks the self-hosted, open-core constraint. |
| Mergify | <https://docs.mergify.com/configuration/> | SaaS (self-hosting is Enterprise-only) | Partial (landing policy only) | A strong model for per-repo `conditions`/`actions` merge rules and queues. But it covers only GitHub PR merge gating. It has no concept of producers, stewards, issue or board destinations, or close-out, and its policy lives in a repo file rather than in March's profile registry. |
| Temporal | <https://docs.temporal.io/self-hosted-guide> | OSS workflow engine | Poor | Durable, pluggable workflow execution, but it is infrastructure, not the product. It would add a second state and sequencing authority competing with Herald's event log, which is the sole source of state, and it supplies none of the GitHub, Dependabot, CodeRabbit or agent-deck domain logic. |

### Build-vs-Buy Rationale

The closest candidates, Optio and OpenHands, are whole platforms aimed at the same "task in, merged PR out" outcome. Neither has a seam at the level this PRD needs. That means a producer contract (discover work with instructions, respond to problems) and a destination contract (per-repo or per-board landing rules, signals, close-out) that open, third-party, and private modules can all implement. Adopting either one would replace March's event-sourced state, its non-destructive teardown authority, and its agent-deck steward sessions, not extend them. That conflicts with the self-hosted, open-core, non-destructive constraints. Mergify and GitHub rulesets cover only one part of the destination role: GitHub PR merge gating.

The coupling is concrete in the repo. The legate runs a fixed, order-dependent handler chain where each kind of work is its own hand-written handler. `dependency-merge.ts` is a whole producer plus destination hidden in one handler, with its own detection, file allowlist, throttle, conflict ladder and labels. `merge-policy.ts` hard-codes Smithy verbs and a CodeRabbit special case into the profile policy shape. Building the module seam inside March is warranted. Two things are worth borrowing: Mergify-style declarative rules as the destination-policy format, and Optio's trigger catalogue (GitHub, GitLab, Linear, Jira, Sentry, webhooks) as a reference list of future producers.

## Assumptions
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- [Critical Assumption] The problem is structural coupling. Each kind of work has its discovery, prompts, merge rules and babysitting spread across legate internals, so adding or changing a flow means editing the core. Triage makes it urgent, because it ends in a verdict rather than a PR and needs a report back to its origin.
- [Critical Assumption] Producers own no landing policy. The per-Smithy-verb merge rules and Dependabot's own gate, labels and pacing move to the GitHub-repo destination's per-repository configuration, matched on the item kind the producer declares.
- [Critical Assumption] Behaviors split in two. The destination raises the signal as one of a few generic groups (checks, comments, approvals) and the producer supplies the responder (`/smithy.fix`). The core pairs them and arbitrates, so each steward gets at most one action per tick. The core never knows which reviewer wrote a comment or which check failed. Asking for a review or a fresh review is part of the destination's land stage, not a responder, and each is a setting of the destination module.
- [Critical Assumption] The safety invariants stay in the core. Modules use only a closed vocabulary of steps and can never make a destructive step automatic. Recovery, teardown, spawn caps, dispatch idempotency and tracing stay core-owned, and module work nests under the existing per-item trace.
- [Critical Assumption] No workflow engine or agent platform replaces March's core. This restructures an engine that already exists. Renovate is a possible future producer, and merge-queue tools cover only the land stage.
- A work item carries an origin (what caused it, such as an issue) and a destination (where its artifact lands). The two can be different modules. For an issue-originated PR, the GitHub-repo destination lands the PR and reports it landed, and the module serving the origin (the GitHub-issues destination) performs the close-out by closing the issue. Each item has exactly one owner for close-out: the module serving its origin.
- Destinations are the open-core boundary's "connector framework" made concrete. Baseline GitHub destinations ship in the open engine; enterprise destinations such as Jira can ship privately. Every module, March's own included, uses the published, versioned module interface.
- A profile binds one repository but can bind several destinations, such as its repo plus GitHub issues or a ticket board.
- Migration is incremental: Smithy first with no behavior change, then Dependabot, then CodeRabbit re-review as part of the GitHub land gate. Triage keeps going while the framework is built and moves over as part of the migration. Jira and Linear destinations are out of scope for the first cut.
- The primary user is the single maintainer/operator. End users of the target repositories are not users of this change.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

### Resolved

#### SD-007 — re-review-without-approval-gate

**Question:** Does the land stage still ask for a fresh review when the destination, or the item kind, does not require approval?

**Answer:** Asking for a review and asking for a re-review are settings of the destination module, not behavior built into March's core. Each is configured on its own, per destination instance, whether or not approval is required. For example, a repository whose reviewer re-reviews automatically, such as CodeRabbit with automatic re-review on, turns the module's re-review request off. The RFC sets the defaults and keeps today's Smithy behavior during migration. Decided by the operator in PR review, 2026-11-26.

#### SD-001 — private-module-loading-in-first-cut

**Question:** Should the first cut load modules through a published, versioned module interface, or through an in-tree, compile-time registry with the external plugin seam deferred?

**Answer:** Use the published, versioned module interface from the first cut, including for Smithy. Building in-tree first would let broken abstractions through. Using the published interface for March's own modules dogfoods the seam that private modules depend on. Decided by the operator in PR review, 2026-11-26.

#### SD-002 — cross-cutting-behavior-placement

**Question:** Where do behaviors like CodeRabbit re-review live? They are neither producer- nor destination-specific.

**Answer:** There is no reviewer-specific behavior. Review feedback is handled by one generic comment responder; which reviewer wrote the comment (CodeRabbit, Codex, Copilot or any other) doesn't matter. Asking for a fresh review belongs to the destination's land stage, because the gate is approval. It reacts to "the PR is waiting for new feedback", not to "there is feedback", and is needed where automatic review isn't enabled. Decided by the operator in PR review, 2026-11-26.

#### SD-003 — profile-to-destination-binding

**Question:** Does a profile bind to exactly one repository, or can it bind several destinations?

**Answer:** A profile still binds to one repository, but that is not the same as one destination. A profile can bind several destinations, such as its GitHub repo plus GitHub issues, a Jira board or a Linear list. Decided by the operator in PR review, 2026-11-26.

#### SD-004 — triage-sequencing-vs-modules

**Question:** Does triage wait for the module framework, or keep going while it is designed?

**Answer:** Triage keeps going at its current pace while the module design is built out, and moves to the framework as part of the migration. Decided by the operator in PR review, 2026-11-26.

#### SD-005 — destination-policy-native-vs-march

**Question:** How much of the GitHub-repo destination's landing policy does March evaluate itself?

**Answer:** The GitHub destination module owns what GitHub already shows as the main status groups of a PR: checks, comments and approvals. It passes them to March as signals. March is never aware of individual kinds of check or comment. A destination that lacks a group, such as a ticket board with no approvals, reports it as empty or passing. A further group can be added later even if GitHub leaves it empty. Decided by the operator in PR review, 2026-11-26.

#### SD-006 — coupling-cost-evidence

**Question:** Should a measured cost of the current coupling be gathered?

**Answer:** No. The size of the codebase is evidence enough, together with the operator's estimate that adding issue triage the current way grows the code by about 40%. Decided by the operator in PR review, 2026-11-26.

## Open Questions
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

None at this time — ready for `smithy.ignite` to expand into an RFC.
