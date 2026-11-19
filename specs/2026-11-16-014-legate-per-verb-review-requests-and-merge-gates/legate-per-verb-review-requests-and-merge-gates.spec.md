# Feature Specification: Legate Per-Verb Review Requests and Merge Gates

**Spec Folder**: `2026-11-16-014-legate-per-verb-review-requests-and-merge-gates`
**Branch**: `feature/legate-loop-reviews`
**Created**: 2026-11-16
**Status**: Draft
**Input**: Operator description — Copilot code review fired on every non-draft PR through the operator's personal "automatic review" setting, used a month of Copilot Pro quota in one evening (13 premium requests per review) and then hit a 429. That setting is now off, so nothing requests AI reviews unless the legate does. AI reviews become an explicit, budgeted legate action keyed on the Smithy verb, and the merge gate becomes per-verb data.
**Source Feature Map**: — (specified directly from an operator description; amends Tessera spec `2026-11-15-013` User Story 7.)

## Clarifications
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

### Session 2026-11-16

- _The per-verb policy table is built-in data that any profile can override per verb. A verb March does not know, or a slice with no verb, fails closed: it needs a human approval and ignores every profile-wide relaxation._ `[Critical Assumption]`
- _Every built-in row sets every field, so a profile's profile-wide `defaults` no longer changes a known verb. A profile changes a known verb only through its per-verb entry. `defaults` still applies to verbs the profile adds itself. This is a behaviour change from the #577 layering: today `defaults.botApproval:true` gives `mark` bot approval, and after this change it does not._ `[Critical Assumption]`
- _Known verbs are `cut`, `forge`, `spark`, `ignite`, `render`, `mark`, `fix` and `strike`, plus any verb named in the profile's own per-verb policy. `fix` and `strike` get explicit rows that require a human approval._
- _The built-in forge allowlist of bot approvers is CodeRabbit only. Copilot code review only ever submits COMMENTED reviews, so it is advisory. An operator can still add a login per profile._ `[Critical Assumption]`
- _Requesting CodeRabbit is opt-in per profile. The built-in forge row lists no reviewer to request, so repos without the CodeRabbit app never get an unanswered trigger comment. The forge allowlist still lets a CodeRabbit approval count wherever CodeRabbit reviews._
- _March's own GitHub App bot (the Tessera app identity, default `march-bot[bot]`) never counts as a reviewer, and the policy validator rejects it in an allowlist. The exact login comes from the Tessera app and is settled when Tessera ships._ `[Critical Assumption]`
- _A bot approval counts only when it was submitted on the PR's current head commit. A human approval keeps GitHub's semantics. An allowlisted bot's CHANGES_REQUESTED blocks as that bot's latest verdict, whatever its commit._
- _When an allowlisted bot's latest verdict is CHANGES_REQUESTED on an older commit and its threads are resolved, the legate requests one review on the new head. The stale verdict keeps blocking until the bot replaces it._
- _A request is recorded durably before it is posted. If no review lands on the requested head within a bounded window (post failed, reviewer silent, or "in progress" never cleared), the legate requests again after back-off. The review-on-head and in-progress checks still prevent duplicates._
- _Back-off and caps are kept per reviewer account across all profiles, not per profile, because a CodeRabbit org or Copilot user has one quota._
- _Monthly caps use UTC calendar months, matching Copilot's premium-request reset; daily caps use UTC days. Both are counted from the request timestamps the legate records._
- _No GitHub ruleset requires an approving review, so the legate's gate is the only merge authority, and an allowlisted APPROVE is enough to auto-merge._
- _CodeRabbit approves only with its request-changes workflow, which is a Pro-plan feature. Without it CodeRabbit never approves, and forge PRs wait for a human. No detection is needed and the legate never invents an approval._
- _The repo `.coderabbit.yaml` files are written in a separate session. This spec records only the keys it depends on (see Assumptions)._
- _Dependabot auto-merge stays with PR #577. Dependency-update PRs have no verb and do not pass through the per-verb policy, so fail-closed does not change them._
- _This work builds on PR #580, which drops Codex's status comment by its leading marker. This spec generalises that rule per reviewer._

## Artifact Hierarchy
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

RFC → Milestone → Feature → User Story → Slice → Tasks

This spec has no parent RFC or feature map. `smithy.cut` turns its user stories into implementation PRs. Each PR updates `docs/subsystems/legate/contract.md` and the legate compose header wherever it changes their surface.

## User Scenarios & Testing *(mandatory)*
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: optional -->

### User Story 1: Resolve the Merge Gate From a Per-Verb Policy Table (Priority: P1)

As an operator, I want each Smithy verb's merge requirements and review requests to come from one policy table so that cut auto-merges, forge can merge on a trusted bot approval, and everything else waits for a human.

**Why this priority**: Every other story reads this table. It also closes the hole where a profile-wide relaxation leaks into verbs nobody meant to relax.

**Independent Test**: Resolve the policy for each of cut, forge, spark, ignite, render, mark, fix, strike, an unknown verb and a missing verb. Do it with an empty profile policy, with a profile-wide relaxation, and with a per-verb override, and compare each result to the expected table.

**Acceptance Scenarios**:

1. **Given** a profile with no policy, **When** the gate resolves `cut`, **Then** no approval is required and changes-requested still blocks.
2. **Given** a profile with no policy, **When** the gate resolves `forge`, **Then** approval is required, an approval from an allowlisted bot satisfies it, the allowlist is CodeRabbit only, and no reviewer is requested.
3. **Given** a profile with no policy, **When** the gate resolves `spark`, `ignite`, `render`, `mark`, `fix` or `strike`, **Then** a human approval is required and bot approvals never count.
4. **Given** a profile whose profile-wide defaults relax approval or allow bot approval, **When** the gate resolves an unknown verb or a slice with no verb, **Then** a human approval is required and bot approvals never count.
5. **Given** a profile whose profile-wide defaults relax approval, **When** the gate resolves `mark`, **Then** the built-in row wins and a human approval is still required.
6. **Given** a profile whose per-verb entry for `forge` lists CodeRabbit as a reviewer to request, **When** the policy resolves, **Then** forge PRs on that profile get CodeRabbit requests.
7. **Given** an operator who tries to add March's own bot login to a bot-approver allowlist, **When** the policy is saved, **Then** validation rejects it.
8. **Given** a profile with bot approval turned on and no allowlist, **When** the policy resolves, **Then** the built-in allowlist applies and no bot is trusted implicitly.
9. **Given** an operator, **When** they ask to see a profile's merge policy, **Then** the CLI prints the effective resolved requirements and reviewers for every known verb, including built-in rows.

---

### User Story 2: Gate Forge on Allowlisted Bot Verdicts (Priority: P1)

As an operator, I want an approval or changes-requested from an allowlisted review bot to count on forge PRs, and only on the commit it reviewed, so that forge PRs merge without me and never on unreviewed code.

**Why this priority**: This is what makes a forge PR merge without a human. Without it, requesting reviews has no effect on merging.

**Independent Test**: Feed sensed PR snapshots through the gate:
- a CodeRabbit APPROVE on the head commit;
- a CodeRabbit APPROVE on an older commit;
- a non-allowlisted bot APPROVE;
- a CodeRabbit CHANGES_REQUESTED;
- a March-bot APPROVE.

Assert that only the first one satisfies the forge gate, and that none of them satisfy the mark gate.

**Acceptance Scenarios**:

1. **Given** a forge PR whose CI is green and whose threads are clear, **When** CodeRabbit's latest verdict is APPROVED on the head commit, **Then** the approval gate is satisfied and the PR auto-merges.
2. **Given** a forge PR with a CodeRabbit APPROVE on an older commit, **When** new commits are pushed, **Then** the approval no longer counts.
3. **Given** a forge PR, **When** CodeRabbit's latest verdict is CHANGES_REQUESTED, **Then** the PR does not merge, just as with a human changes-requested.
4. **Given** a forge PR approved only by a bot that is not on the allowlist, **When** the gate runs, **Then** approval is not satisfied.
5. **Given** a mark, render, spark or ignite PR approved by CodeRabbit, **When** the gate runs, **Then** the PR does not merge without a human approval.
6. **Given** a PR approved by March's own bot, **When** the gate runs, **Then** that approval never counts.
7. **Given** a review bot identified by its login with or without the `[bot]` suffix, **When** its review is classified, **Then** it matches the same allowlist entry.
8. **Given** a cut PR with no approval at all, **When** CI, conflicts and threads are clear, **Then** it auto-merges exactly as today.

---

### User Story 3: Keep Bot Review Chatter From Creating Fix Work (Priority: P1)

As an operator, I want review-bot status, progress and rate-limit comments, and the legate's own trigger comment, to be ignored as feedback so that a steward is never sent to "fix" a status notice.

**Why this priority**: Otherwise every review request from User Story 4 produces a fix turn. It must ship no later than User Story 4.

**Independent Test**: Sense a PR carrying:
- a CodeRabbit walkthrough/summary comment;
- a CodeRabbit "review in progress" comment;
- a CodeRabbit "rate limited" comment;
- the legate's `@coderabbitai review` trigger comment;
- a human comment.

Assert that only the human comment needs a response.

**Acceptance Scenarios**:

1. **Given** a review bot's status or summary comment, **When** the PR is sensed, **Then** it is left out of the comments that need a response.
2. **Given** the legate's own trigger comment, **When** the PR is sensed, **Then** it is recognised by March's comment marker and never needs a response.
3. **Given** a comment from an allowlisted reviewer that matches no known pattern, **When** the PR is sensed, **Then** it is treated as status, not feedback.
4. **Given** an inline review thread opened by a review bot, **When** the PR is sensed, **Then** the thread still needs a response and still blocks the merge.
5. **Given** a human comment that quotes a bot marker partway through its body, **When** the PR is sensed, **Then** it still counts as feedback.

---

### User Story 4: Request a CodeRabbit Review Once per Head Commit (Priority: P1)

As an operator, I want the legate to ask CodeRabbit for a review on each forge PR once it is ready, exactly once per head commit, so that forge PRs get reviewed without burning quota on repeats.

**Why this priority**: This restores AI review after the auto-review setting was turned off. It depends on User Stories 1–3.

**Independent Test**: Against a fake GitHub and a fake Herald:
1. Open a ready forge PR in a profile that opts in, and assert one trigger comment.
2. Tick again and assert no second comment.
3. Restart the legate from the fold and assert no second comment.
4. Push a new head and assert no request until a re-request condition holds.

**Acceptance Scenarios**:

1. **Given** a profile that opts forge into CodeRabbit, and a tracked forge PR that is open, non-draft and CI-green with no CodeRabbit review, no in-progress comment and no recorded request on its head commit, **When** the legate ticks, **Then** it records a request and posts one CodeRabbit trigger comment.
2. **Given** a request already recorded for (PR, CodeRabbit, head commit), **When** the legate ticks again or restarts, **Then** no second request is made.
3. **Given** CodeRabbit is configured to review automatically, **When** the profile's reviewer mode is `auto`, **Then** the legate posts no trigger comment and only observes.
4. **Given** a recorded request with no review on that head after the bounded wait, **When** the legate ticks, **Then** it requests again after back-off.
5. **Given** a new push to a PR CodeRabbit already reviewed, **When** the earlier approval is still valid in GitHub's terms but now stale, and approval is the only unmet gate, **Then** the legate requests one review on the new head.
6. **Given** a new push, **When** CodeRabbit's latest verdict is CHANGES_REQUESTED on an older commit and its threads are resolved, **Then** the legate requests one review on the new head.
7. **Given** a new push to a PR that still has failing CI, open threads or conflicts, **When** the legate ticks, **Then** it does not re-request.
8. **Given** a forge PR in a profile that has not opted in, or a PR of any other verb, **When** the legate ticks, **Then** no review is requested.
9. **Given** any request outcome, **When** the legate acts, **Then** it emits a `legate.review.request` span nested in the slice's trace, with reviewer, verb and outcome, and counts it by reviewer and outcome.
10. **Given** any situation, **When** the legate posts on a PR, **Then** it never posts a CodeRabbit command that approves or resolves on the reviewer's behalf.

---

### User Story 5: Back Off When a Reviewer Is Rate-Limited (Priority: P2)

As an operator, I want a rate-limited reviewer to be backed off rather than retried, so that a 429 never turns into a request storm or a silent switch to a reviewer that bills differently.

**Why this priority**: It protects the quota once User Story 4 is live. Without it, the bounded retry in User Story 4 would keep hitting a limited reviewer.

**Independent Test**: Return a 429 from the request, then post a CodeRabbit "rate limited, try again in N minutes" comment. Assert that no request is made before the stated reset, and after that none before the exponential back-off. Assert that no other reviewer is requested, and that a restart keeps the back-off.

**Acceptance Scenarios**:

1. **Given** a request that returns 429, or a reviewer comment saying it is rate-limited or paused, **When** the legate records the outcome, **Then** the reviewer enters back-off and the attempt is not a failure.
2. **Given** a back-off with a stated reset time, **When** the legate ticks before that time, **Then** it makes no request to that reviewer on any PR in any profile.
3. **Given** a back-off with no stated reset time, **When** further attempts are rate-limited, **Then** the wait grows exponentially up to a ceiling, with no tight retry loop.
4. **Given** CodeRabbit is in back-off, **When** a forge PR is ready, **Then** Copilot is never requested in its place.
5. **Given** a legate restart during back-off, **When** it rebuilds state, **Then** the back-off is still in force.
6. **Given** a reviewer in back-off, **When** a review from it arrives anyway, **Then** the legate still senses and honours it.
7. **Given** a rate-limit hit, **When** the legate records it, **Then** a rate-limit counter for that reviewer increments and the request span carries outcome `backoff`.

---

### User Story 6: Show Review State to the Operator (Priority: P2)

As an operator, I want to see each PR's review state, and how much review budget is left, so that I can tell why a forge PR is waiting.

**Why this priority**: It is needed to run the feature but does not affect merges.

**Independent Test**: Build PRs in each review state. Assert the state each one resolves to, that the state appears in `march herald state`, both the table and `--json`, and that the remaining-cap gauge matches the recorded requests.

**Acceptance Scenarios**:

1. **Given** sensed reviews, recorded requests and back-offs, **When** a PR's review state is derived, **Then** it is exactly one of `none`, `requested`, `in_progress`, `approved_by_bot`, `changes_requested` or `rate_limited`.
2. **Given** an operator running `march herald state`, **When** tracked PRs exist, **Then** each shows its review state, and `--json` includes it.
3. **Given** reviewer caps, **When** metrics are exported, **Then** a gauge reports the remaining cap per reviewer and window, with low-cardinality labels and no PR numbers.
4. **Given** the legate dashboard, **When** an operator opens it, **Then** panels show requests by reviewer and outcome, rate-limit hits and cap remaining.

---

### User Story 7: Request Copilot Within a Hard Budget (Priority: P3)

As an operator, I want to optionally add Copilot as a second reviewer, billed to my own plan and held under hard daily and monthly caps, so that I get a second opinion without another quota blow-out.

**Why this priority**: It is optional and off by default, and it depends on Tessera's user identity.

**Independent Test**: Against fake Tessera and fake GitHub, enable Copilot for forge with a daily cap of 1. Then check each of these:
- one request is made with the user token;
- a second ready PR the same UTC day is not requested;
- with the default cap of 0, nothing is ever requested;
- if Tessera fails, no request is made and the span is errored.

**Acceptance Scenarios**:

1. **Given** default configuration, **When** any PR is ready, **Then** Copilot is never requested.
2. **Given** a profile that opts forge into Copilot with a non-zero daily and monthly cap, **When** a ready forge PR has no Copilot request on its head, **Then** the legate requests Copilot with the operator's `user` identity from Tessera.
3. **Given** the daily or monthly cap is reached, **When** another PR is ready, **Then** no request is made and the span is errored with outcome `cap_exhausted`.
4. **Given** Tessera cannot supply the `user` identity, **When** a Copilot request is due, **Then** no request is made, the span is errored, and no app token or ambient credential is used instead.
5. **Given** a Copilot review arrives, **When** the gate runs, **Then** it never satisfies approval unless an operator has added Copilot to that profile's allowlist.
6. **Given** a Copilot request has been made, **When** the legate restarts, **Then** the request still counts toward the caps.

### Edge Cases

- **Draft to ready:** a PR marked ready is treated like a newly ready PR. Earlier requests on the same head still count.
- **Force-push during an in-progress review:** the head changes. The in-progress comment on the old head does not suppress a request on the new head, and the old head's request does not count as done.
- **Reopened PR:** recorded requests on its head still apply, so reopening does not trigger a new request.
- **CodeRabbit's own pre-merge check fails:** CodeRabbit withholds approval. The PR waits, and the legate does not re-request on that head.
- **CodeRabbit without Pro:** it never approves, so forge waits for a human. Review state shows `requested` or `none`, not an error.
- **"In progress" comment never clears:** after the bounded wait it no longer suppresses a request.
- **Legacy slice with no verb:** it fails closed and needs a human approval. The waiting-for-approval readiness metric shows it.
- **Dependabot PR:** it has no verb and keeps #577's path. The bot-approver allowlist never applies to it.
- **Same reviewer, several profiles:** one back-off and one cap cover them all.
- **Clock and day boundary:** caps are bucketed on the request timestamp in UTC, and a new UTC day or month resets the count.
- **Request recorded but the comment post failed:** the bounded wait and back-off cover it, with no tight loop.
- **The trigger comment is edited or deleted by a human:** it does not reset the ledger.

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| US1 | Resolve the Merge Gate From a Per-Verb Policy Table | — | specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/01-resolve-the-merge-gate-from-a-per-verb-policy-table.tasks.md |
| US3 | Keep Bot Review Chatter From Creating Fix Work | — | specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/03-keep-bot-review-chatter-from-creating-fix-work.tasks.md |
| US2 | Gate Forge on Allowlisted Bot Verdicts | US1 | specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/02-gate-forge-on-allowlisted-bot-verdicts.tasks.md |
| US4 | Request a CodeRabbit Review Once per Head Commit | US1, US2, US3 | — |
| US5 | Back Off When a Reviewer Is Rate-Limited | US4 | — |
| US6 | Show Review State to the Operator | US2, US4, US5 | — |
| US7 | Request Copilot Within a Hard Budget | US4, US5 | — |

## Requirements *(mandatory)*
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: recommended -->

### Functional Requirements

**Policy**

- **FR-001**: The merge policy MUST hold, per verb, the approval requirement, the changes-requested requirement, whether bot approvals count, an allowlist of bot-approver logins, and the reviewers to request. *(US1)*
- **FR-002**: The built-in table MUST be:
  - `cut`: no approval.
  - `forge`: approval satisfied by an allowlisted bot, with the allowlist set to CodeRabbit only, and no reviewer requested.
  - `spark`, `ignite`, `render`, `mark`, `fix` and `strike`: human approval, and bot approvals never count.

  Every row MUST set every field. *(US1)*
- **FR-003**: A profile's per-verb entry MUST override the built-in row field by field. A profile's profile-wide defaults MUST NOT change a known verb. *(US1)*
- **FR-004**: An unknown verb, or a slice with no verb, MUST require a human approval with bot approvals not counting, and MUST ignore every profile-wide relaxation. A verb the profile names in its own per-verb policy is known. *(US1)*
- **FR-005**: Turning bot approval on without an allowlist MUST resolve to the built-in allowlist, never to "any bot". *(US1)*
- **FR-006**: Policy validation MUST reject March's own bot login in any allowlist. Invalid shapes are rejected as today. *(US1)*
- **FR-007**: The operator CLI MUST be able to add and remove bot-approver logins and reviewers to request per verb, and to show the effective resolved policy for every known verb. *(US1)*
- **FR-008**: Changes-requested MUST stay mandatory for every verb unless explicitly relaxed per verb. The CI, conflict and unresolved-thread preconditions MUST stay unchanged. *(US1, US2)*

**Gate**

- **FR-009**: Sensing MUST record each reviewer's latest verdict with its login, author kind and the commit it was submitted on. Sensing MUST stay policy-free, and the legate applies the allowlist. *(US2)*
- **FR-010**: A bot approval MUST satisfy the approval gate only when bot approvals count for the verb, the login is on the allowlist, and the approval was submitted on the PR's current head commit. *(US2)*
- **FR-011**: An allowlisted bot's latest CHANGES_REQUESTED MUST block the merge like a human one. A non-allowlisted bot's verdicts MUST NOT affect the gate. *(US2)*
- **FR-012**: March's own bot MUST never count as a reviewer. *(US2)*
- **FR-013**: Bot logins MUST match the allowlist whether or not they carry the `[bot]` suffix, and only when the author is a bot account. *(US2)*

**Comment classification**

- **FR-014**: Comments from a reviewer that are status, summary, in-progress or rate-limit notices, and the legate's own trigger comments, MUST NOT count as comments needing a response. This generalises PR #580's rule per reviewer. *(US3)*
- **FR-015**: A comment from an allowlisted reviewer that matches no known pattern MUST be treated as status. Inline review threads from any bot MUST still need a response and still gate. *(US3)*
- **FR-016**: A comment MUST be dropped only when a marker opens it. Quoting a marker later in the body MUST NOT drop it. *(US3)*

**Review requests**

- **FR-017**: The legate MUST request a configured reviewer on a tracked PR only when all of these hold:
  - the PR is open, non-draft and CI-green;
  - the verb's policy lists that reviewer;
  - the reviewer has no review and no in-progress notice on the head commit;
  - no request is recorded for (PR, reviewer, head commit) within the bounded wait;
  - the reviewer is not in back-off;
  - its caps are not exhausted. *(US4)*
- **FR-018**: A request MUST be recorded durably before it is posted, and MUST survive a legate restart. *(US4)*
- **FR-019**: If no review lands on the requested head within the bounded wait, the legate MUST request again, subject to back-off. *(US4)*
- **FR-020**: On a new head, the legate MUST re-request only when one of these holds:
  - the earlier bot approval was dismissed or is stale and approval is the only unmet gate;
  - the reviewer's latest verdict is CHANGES_REQUESTED on an older commit and its threads are resolved;
  - the reviewer has never submitted a verdict on this PR, so a request on an older head was superseded by a push before it was answered. This request carries `reason: initial`.

  It MUST NOT re-request on every push. A PR the reviewer has already reviewed only gets a new-head request under the first two conditions. *(US4)*
- **FR-021**: CodeRabbit MUST support two modes. In comment-trigger mode (the default) the legate posts the review trigger comment. In auto mode the legate only observes. *(US4)*
- **FR-022**: The legate MUST never post a reviewer command that approves or resolves on the reviewer's behalf. *(US4)*
- **FR-023**: Each request decision that acts or is refused MUST emit a `legate.review.request` span nested in the slice trace, with reviewer, verb and outcome. The span MUST be errored on failure or cap exhaustion. *(US4, US5, US7)*
- **FR-024**: The legate MUST count requests by reviewer and outcome on low-cardinality labels. *(US4)*

**Back-off**

- **FR-025**: A 429 or a reviewer comment saying it is rate-limited or paused MUST put that reviewer into back-off. Back-off is not a failure. *(US5)*
- **FR-026**: Back-off MUST honour a stated reset time, and otherwise grow exponentially to a ceiling. It MUST be durable and MUST apply per reviewer account across all profiles. *(US5)*
- **FR-027**: The legate MUST never fall back from one reviewer to another automatically. *(US5)*
- **FR-028**: The legate MUST count rate-limit hits per reviewer. *(US5)*

**Review state**

- **FR-029**: One shared derivation MUST map sensed reviews, recorded requests and back-offs to exactly one review state: `none`, `requested`, `in_progress`, `approved_by_bot`, `changes_requested` or `rate_limited`. *(US6)*
- **FR-030**: `march herald state` (table and `--json`) MUST expose each tracked PR's review state. It is computed with the shared derivation (FR-029) from the fold and Herald's profile registry, and is never stored on the sensed PR snapshot. *(US6)*
- **FR-031**: The legate MUST export the remaining cap per reviewer and window, and the legate dashboard MUST show requests, rate-limit hits and cap remaining. *(US6)*

**Copilot**

- **FR-032**: Copilot MUST be requested only when a profile opts the verb into it, and only with the operator's `user` identity from Tessera. It MUST never use the app token or ambient credentials, and a failure to get the identity MUST leave the request unmade. *(US7)*
- **FR-033**: Copilot requests MUST be held to a daily cap (`MARCH_COPILOT_REVIEWS_PER_DAY`, default 0) and a monthly cap (`MARCH_COPILOT_REVIEWS_PER_MONTH`, default 0). Both are counted from recorded requests in UTC days and months across all profiles. An optional CodeRabbit daily cap (`MARCH_CODERABBIT_REVIEWS_PER_DAY`, default unlimited) MUST be honoured the same way. *(US7, US4)*

**Cross-spec and docs**

- **FR-034**: Tessera spec `2026-11-15-013` User Story 7, FR-032 and SC-008 MUST be amended to defer the Copilot request policy to this spec. Tessera keeps the `user` identity provider. Its SD-009 is resolved by this spec's durable request record. *(US7)*
- **FR-035**: The legate contract, the compose header env documentation, and comments or docs that describe the approval gate as human-only MUST be updated to match. *(US1, US2, US4, US7)*

### Key Entities

- **Merge Requirements**: the per-verb gate fields: approval, changes-requested, bot approval and the bot-approver allowlist.
- **Review Request Policy**: the per-verb list of reviewers to request, each with an id and a mode.
- **Built-in Policy Table**: the default Merge Requirements and Review Request Policy for each known verb.
- **Review Observation**: one reviewer's latest verdict on a PR, with its login, author kind (human, allowlisted bot, other bot), state and reviewed commit.
- **Review Request Record**: a durable record that a reviewer was requested on a PR's head commit at a time.
- **Reviewer Back-off**: the durable back-off state for a reviewer account: until when, and how many attempts.
- **Review State**: the derived per-PR review status shown to operators.
- **Reviewer Adapter**: one reviewer's identity, comment classification, reset-time parsing and request method.

## Assumptions
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- The `.coderabbit.yaml` in each repo that opts in sets these keys:
  - `reviews.request_changes_workflow: true`. This needs Pro. CodeRabbit then approves once its comments are resolved and no pre-merge check is failing.
  - `reviews.auto_review.enabled: false`. This matches the default comment-trigger mode. Set it to `true` only with legate mode `auto`.
  - `reviews.auto_review.drafts: false`.

  Those files are written in a separate session.
- CodeRabbit accepts `@coderabbitai review` (incremental) as a manual trigger whatever its auto-review setting.
- CodeRabbit posts recognisable summary, in-progress and rate-limit comments. Fixtures pin the current formats.
- GitHub reports the commit each review was submitted on.
- Tessera's client (its slice 04) provides the `user` identity before User Story 7 is implemented.
- The legate's existing exponential back-off helper, with its ceiling and jitter, is reused for reviewer back-off.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Title | Source Category | Impact | Confidence | Origin |
|----|-------|-----------------|--------|------------|--------|

### Resolved

#### SD-001 — Profile defaults on known verbs

**Question:** What does a profile's profile-wide `defaults` tier do once every known verb has a built-in row? Does it keep relaxing unset fields, have no effect on known verbs, or get rejected for approval and botApproval?

**Answer:** Resolved 2026-11-16 by the operator: no effect on known verbs. Every built-in row sets every field, and `defaults` applies only to verbs a profile adds itself (FR-003).

#### SD-002 — Unanswered request retry

**Question:** A recorded request may never produce a review: the post failed, the reviewer stayed silent, or its in-progress notice never cleared. Is the request strictly at-most-once with a human fallback, or retried after a timeout?

**Answer:** Resolved 2026-11-16 by the operator: retried after a bounded wait, subject to back-off (FR-019).

#### SD-003 — Forge CodeRabbit opt-in

**Question:** Is forge's CodeRabbit request on by default for every profile (opt-out), or opt-in per profile?

**Answer:** Resolved 2026-11-16 by the operator: opt-in per profile. The built-in forge row lists no reviewer to request (FR-002).

#### SD-004 — Stale bot changes-requested

**Question:** After fixes are pushed, how is an allowlisted bot's CHANGES_REQUESTED on an older commit handled? Re-request, wait for the bot, or ignore the stale verdict?

**Answer:** Resolved 2026-11-16 by the operator: re-request once on the new head when the threads are resolved. The stale verdict keeps blocking until the bot replaces it (FR-020).

## Out of Scope
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- Dependabot auto-merge (PR #577 owns it).
- Creating the CodeRabbit account, installing the app, or writing `.coderabbit.yaml` (separate session).
- Building Tessera or its `user` identity provider (Tessera spec `2026-11-15-013`).
- Making the merge gate wait on Codex's review state (PR #580's follow-up). The reviewer adapter allows a classify-only reviewer, but moving Codex over is not required here.
- A separate review-policy registry entity apart from the merge policy.
- Per-PR status in `march status`, which stays stack health only.

## Success Criteria *(mandatory)*
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

### Measurable Outcomes

- **SC-001**: Policy resolution tests cover every known verb, an unknown verb and a missing verb under an empty, profile-wide-relaxed and per-verb-overridden policy. Each resolves to the expected row.
- **SC-002**: In tests, mark, render, spark, ignite, fix, strike and unknown-verb PRs never merge on any bot approval, and cut PRs merge with no approval.
- **SC-003**: A forge PR auto-merges on a CodeRabbit APPROVE on its head commit, and never on an approval for an older commit or from a non-allowlisted bot.
- **SC-004**: Across repeated ticks and a simulated restart, each (PR, reviewer, head commit) gets at most one request per bounded wait.
- **SC-005**: With default configuration, zero Copilot requests are made.
- **SC-006**: After a 429, no request reaches the limited reviewer before its reset or back-off expiry, and no other reviewer is requested in its place.
- **SC-007**: No review-bot status, in-progress, rate-limit or trigger comment produces a fix turn.
- **SC-008**: In a live check on one forge PR in an opted-in profile:
  - the trigger comment is posted once;
  - CodeRabbit's APPROVE satisfies the gate and the PR auto-merges;
  - the slice trace shows a `legate.review.request` span;
  - a non-forge PR gets no request.
- **SC-009**: Every tracked PR shows a review state in `march herald state`.
