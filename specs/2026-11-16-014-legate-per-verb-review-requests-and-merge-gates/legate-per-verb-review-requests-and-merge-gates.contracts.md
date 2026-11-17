# Contracts: Legate Per-Verb Review Requests and Merge Gates
<!-- applicability: code-shaped features only -->

## Interfaces
<!-- audience: builder; mode: reference; length: tables only; diagram: optional; examples: required; applicability: code-shaped features only -->

### Merge Policy Resolution

**Purpose**: Resolve the effective gate and the reviewers for one verb.
**Consumers**: Legate babysit merge gate, the merge-readiness classifier, the review-request handler, and `march profile merge-policy show`.
**Providers**: The pure merge policy module, shared by Herald (validation on write) and the legate (resolution each tick).

#### Signature

```ts
const KNOWN_TASK_TYPES: readonly ["cut","forge","spark","ignite","render","mark","fix","strike"];
function resolveMergeRequirements(policy: MergePolicy | undefined, taskType: string | undefined): ResolvedMergeRequirements;
function resolveReviewRequests(policy: MergePolicy | undefined, taskType: string | undefined): readonly ReviewerConfig[];
function approvalSatisfied(req: ResolvedMergeRequirements, pr: PrSnapshot): boolean;          // existing, now SHA- and allowlist-aware
function changesRequestedSatisfied(req: ResolvedMergeRequirements, pr: PrSnapshot): boolean;  // new; human or allowlisted-bot CR blocks
function validateMergePolicy(value: unknown): { ok: true; policy: MergePolicy } | { ok: false; error: string };
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `policy` | MergePolicy | No | The profile's stored policy, read live from the Herald registry. |
| `taskType` | string | No | The slice verb. Missing or unknown resolves to the fail-closed row. |
| `pr` | PrSnapshot | Yes | Must carry `head_sha` and `reviews[]`. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `approval`, `changesRequested`, `botApproval` | boolean | Fully resolved, never undefined. |
| `botApprovers` | readonly string[] | Normalised logins. Empty unless `botApproval`. |
| `ReviewerConfig[]` | `{id, mode}` | Reviewers to request for the verb. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Stored policy JSON is malformed or invalid | Resolves as an empty policy (built-in table) | The read path never throws. This is existing behaviour. |
| `botApprovers` contains March's own bot | `validateMergePolicy` returns `ok:false` | Rejected on `POST /profiles` and on CLI set. |
| Unknown reviewer id or mode | `ok:false` | |

Example:

```ts
resolveMergeRequirements(undefined, "forge")
// → { approval:true, changesRequested:true, botApproval:true, botApprovers:["coderabbitai"] }
resolveMergeRequirements({ defaults:{ approval:false, botApproval:true } }, "mark")
// → { approval:true, changesRequested:true, botApproval:false, botApprovers:[] }
resolveMergeRequirements({ defaults:{ approval:false } }, undefined)
// → { approval:true, changesRequested:true, botApproval:false, botApprovers:[] }
```

### Merge Policy Wire Shape (Herald registry `merge_policy`)

**Purpose**: The stored per-profile policy. It extends the #577 shape and is backward-compatible.
**Consumers**: Herald `POST /profiles`, `march profile merge-policy`, and the legate.
**Providers**: Herald profile registry.

#### Signature

```json
{
  "defaults":   { "approval": true },
  "byTaskType": { "forge": { "botApprovers": ["coderabbitai[bot]"] } },
  "reviewRequests": { "byTaskType": { "forge": { "reviewers": [ { "id": "coderabbit", "mode": "comment-trigger" } ] } } },
  "dependencyUpdates": { "autoMerge": false }
}
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reviewRequests.byTaskType[verb].reviewers` | ReviewerConfig[] | No | New. Absent means the built-in row (no reviewers). |
| `byTaskType[verb].botApprovers` | string[] | No | New. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| Normalised policy | MergePolicy | Known fields only. Logins normalised. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Unknown top-level key | 400 `merge policy has unknown key` | Existing behaviour, with `reviewRequests` added to the allowed set. |

### Operator CLI

**Purpose**: Manage and inspect per-verb review policy.
**Consumers**: The operator.
**Providers**: `march profile merge-policy`. It is npm-safe and uses the Herald HTTP API only.

#### Signature

```text
march profile merge-policy set <profile> --task-type <verb> [--bot-approver <login>]... [--no-bot-approver <login>]...
march profile merge-policy set <profile> --task-type <verb> --review-request <coderabbit[:comment-trigger|auto]|copilot>
march profile merge-policy set <profile> --task-type <verb> --no-review-request <reviewer>
march profile merge-policy show <profile> [--json]
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `--task-type` | string | Yes for `set` | The verb to edit. |
| `--bot-approver` | string (repeatable) | No | Adds a login to the verb's allowlist. |
| `--review-request` | string | No | Adds a reviewer, with an optional mode. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `show` table | text | One row per known or profile-added verb: approval, changesRequested, botApproval, botApprovers, reviewers, and whether each value comes from built-in, profile, or fail-closed. |
| `show --json` | object | The same data, keyed by verb. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Validation fails | Exit 1, Herald's error message | For example, a self-bot login. |
| Herald unreachable | Exit 1 | Existing CLI behaviour. |

### Reviewer Adapter

**Purpose**: Isolate each reviewer's identity, comment formats and request method.
**Consumers**: Sensing (classification) and the legate review-request handler.
**Providers**: A CodeRabbit adapter and a Copilot adapter. A classify-only adapter, such as Codex, is allowed.

#### Signature

```ts
interface ReviewerAdapter {
  readonly id: "coderabbit" | "copilot" | string;     // string only for classify-only adapters
  readonly logins: readonly string[];                 // normalised, e.g. ["coderabbitai"]
  classifyComment(c: { author: string; authorType: string; body: string }):
    { kind: "status" | "in_progress" | "rate_limited" | "trigger" | "feedback"; resetAt?: string };
  request?(pr: { repoPath: string; number: number; headSha: string }, deps: ReviewRequestDeps): Promise<ReviewRequestResult>;
}
type ReviewRequestResult =
  | { ok: true }
  | { ok: false; kind: "rate_limited"; resetAt?: string }
  | { ok: false; kind: "identity_unavailable" | "failed"; error: string };
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `c.body` | string | Yes | Full comment body. Classification is marker-led: only a body that opens with the marker matches. |
| `pr.headSha` | string | Yes | Recorded for idempotency. |
| `deps` | ReviewRequestDeps | Yes | Seams: `postPrComment`, `requestReviewers`, `getUserToken`. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `kind` | enum | `trigger` means a comment that starts with March's `[march-bot]` marker and carries a reviewer command. |
| `resetAt` | ISO-8601 | Parsed from rate-limit notices when stated. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| HTTP 429 or a secondary rate limit | `{ok:false, kind:"rate_limited"}` | Never thrown. |
| Tessera `user` identity unavailable (Copilot) | `{ok:false, kind:"identity_unavailable"}` | No fallback credential is used. |
| Any other GitHub error | `{ok:false, kind:"failed"}` | |

Example: CodeRabbit's trigger body is `[march-bot] @coderabbitai review`. The `[march-bot]` prefix keeps it out of `commentsNeedingResponse`. If live verification shows CodeRabbit ignores a command that does not open the comment, the trigger becomes `@coderabbitai review\n\n<!-- march-bot:review-trigger -->`, recognised by its hidden marker.

### GitHub Request Seams (legate runtime)

**Purpose**: Make the side effects injectable for tests, following the `reactToCommentGh` pattern.
**Consumers**: Reviewer adapters.
**Providers**: Legate runtime.

#### Signature

```ts
postPrComment(repoPath: string, pr: number, body: string): Promise<{ ok: true; id: number } | { ok: false; status?: number; error: string }>;
//   gh api --method POST repos/{owner}/{repo}/issues/<pr>/comments -f body=<body>       (ambient/app credential)
requestReviewers(repoPath: string, pr: number, reviewers: string[], token: string): Promise<{ ok: true } | { ok: false; status?: number; error: string }>;
//   gh api --method POST repos/{owner}/{repo}/pulls/<pr>/requested_reviewers  with GH_TOKEN=<user token>
getUserToken(sliceId: string): Promise<{ ok: true; token: string } | { ok: false; code: string }>;
//   Tessera getGitHubToken({ identity: "user", access: "write", sliceId })
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `token` | string | Yes (Copilot) | Tessera `user` token, used only for this call. Never logged. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `status` | number | HTTP status, so 429 can be classified. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| `gh` exits non-zero | `{ok:false, status?}` | The status is parsed from `gh` output when present. |

### Review State Derivation

**Purpose**: One shared definition of a PR's review state.
**Consumers**: The legate (metrics, spans) and `march herald state`.
**Providers**: A pure shared module.

#### Signature

```ts
function deriveReviewState(pr: PrSnapshot, ledger: ReviewLedgerView, backoff: ReviewerBackoffView,
  req: ResolvedMergeRequirements, now: Date): "none"|"requested"|"in_progress"|"approved_by_bot"|"changes_requested"|"rate_limited";
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `req` | ResolvedMergeRequirements | Yes | Supplies the allowlist. `march herald state` resolves it from Herald's own registry. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| state | enum | The precedence order is defined in the data model, entity 7. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Snapshot missing `head_sha` | `none` | Fail-safe. |

## Events / Hooks
<!-- audience: builder; mode: reference; length: tables only; diagram: optional; examples: required; applicability: code-shaped features only -->

| Event / Signal | Trigger | Payload / Attributes |
|---|---|---|
| Herald event `review.requested` (transition, legate `POST /events`) | Before a request is posted | `{sliceId, pr, reviewer, headSha, at, reason}`. Shape in the data model, entity 5. |
| Herald event `review.backoff` (transition) | 429, rate-limited/paused notice, post failure, or a success resetting attempts | `{reviewer, until, attempts, cause}`. Shape in the data model, entity 6. |
| Herald event `slice.pr.changed` (existing) | PR snapshot changed | Adds `pr.reviews[]`, `pr.reviewer_notices[]`, `pr.is_draft`. Review state is derived, not stored. |
| Span `legate.review.request` | Every request decision that acts or is refused | `march.slice_id`, `march.review.reviewer`, `march.task_type`, `march.review.outcome` ∈ `requested\|backoff\|failed\|cap_exhausted\|identity_unavailable`, `march.review.reason`. Errored for `failed`, `cap_exhausted` and `identity_unavailable`. Nested under the slice's deterministic dispatch trace. |
| Counter `march.legate.review.requests` | Each span | Labels `reviewer`, `outcome`. |
| Counter `march.legate.review.rate_limited` | Each back-off due to a rate limit | Labels `reviewer`. |
| Gauge `march.legate.review.cap_remaining` | Each tick | Labels `reviewer`, `window` ∈ `day\|month`. Not exported for an unlimited cap. |
| Action-log action `review-request` / `review-request-failed` | Mirrors the span | Feeds the existing `march.legate.loop.actions` counter. |

Example `review.requested`:

```json
{ "type": "review.requested", "profile": "march", "sliceId": "legate-review-us4-s1", "pr": 612,
  "reviewer": "coderabbit", "headSha": "3f1c…e9", "at": "2026-11-16T18:02:11Z", "reason": "initial" }
```

## Integration Boundaries
<!-- audience: builder; mode: reference; length: tables only; diagram: optional; examples: required; applicability: code-shaped features only -->

| Boundary | Direction | Contract | Failure mode |
|---|---|---|---|
| Legate → GitHub (CodeRabbit trigger) | Out | Issue comment `@coderabbitai review` on the PR, with legate credentials | `post_failed` back-off. Never retried in a tight loop. |
| CodeRabbit → GitHub | In (sensed) | Reviews (APPROVED/CHANGES_REQUESTED/COMMENTED) with `commit.oid`. Summary, in-progress and rate-limit comments. | Unknown format means the comment is treated as status (allowlisted login). Fixture tests pin the formats. |
| Repo `.coderabbit.yaml` (owned by another session) | Config | `reviews.request_changes_workflow: true`, `reviews.auto_review.enabled: false` (mode `comment-trigger`), `reviews.auto_review.drafts: false` | Without Pro there is no APPROVE, so the PR waits for a human. |
| Legate → Tessera | Out | `getGitHubToken({identity:"user", access:"write", sliceId})`, `legate` client only (Tessera FR-013) | `identity_unavailable`: errored span, no request, no fallback. |
| Legate → GitHub (Copilot) | Out | `POST /pulls/{n}/requested_reviewers` with reviewer `copilot-pull-request-reviewer[bot]`, using the user token | 429 leads to back-off. Other errors give an errored span. |
| Herald sensing → event log | In | `slice.pr.changed` snapshot with `reviews[]` (policy-free) | Existing back-compat counts stay. |
| Legate → Herald | Out | `POST /events` accepts `review.requested` and `review.backoff`. `EventType` stays low-cardinality. | An append failure is logged. The request is not posted when the intent append fails. |
| Legate env | Config | `MARCH_COPILOT_REVIEWS_PER_DAY` (0), `MARCH_COPILOT_REVIEWS_PER_MONTH` (0), `MARCH_CODERABBIT_REVIEWS_PER_DAY` (unset = unlimited), `MARCH_REVIEW_WAIT_MINUTES` (30), `MARCH_SELF_BOT_LOGIN` (`march-bot`) | Invalid values fall back to the defaults with a warning log. All are documented in the `docker/legate.docker-compose.yml` header. |
| Tessera spec `2026-11-15-013` | Doc | US7, FR-032, SC-008 and the contracts row defer to this spec. SD-009 is resolved. | — |
| Dependabot path (#577) | None | Untouched. The allowlist never applies to it. | Regression test. |
