# Data Model: Statio Forge Gateway (Service Foundation)

## Overview

Statio is **stateless**: it persists nothing. The "entities" below are the JSON
wire shapes that cross the Statio API boundary plus the configuration value
object. They are point-in-time projections of forge state shaped from `gh` output,
narrowed to exactly the fields current consumers read (the way `CastraSession`
narrows agent-deck's snapshot). None of them is a stored record; Herald's event
log remains the only durable system state.

All wire shapes are **behavior-preserving** projections of the `gh` JSON that
`src/observe/sense-io.ts` consumes today — the Herald cutover must observe an
unchanged shape.

## Entities

### 1) RepoInfo (`repo_info`)

Purpose: Repository identity and default branch, resolved from `gh repo view`.
Underpins PR-scoping (`-R owner`) and default-branch logic.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `owner` | string | Yes | `owner/name` (`gh repo view --json nameWithOwner`). |
| `defaultBranch` | string | Yes | Default branch name (`--json defaultBranchRef`). |

Validation rules:
- `owner` must be splittable into `owner` and `name` for the GraphQL review-threads
  query; an unsplittable owner is treated as "owner unavailable" downstream.
- Empty `owner` is permitted only as the documented "owner unavailable" fallback
  signal, not a normal success.

### 2) PullRequestSummary (`pull_request_summary`)

Purpose: The single-PR read returned by `getPr` — the babysit projection. Mirrors
`queryPrForBabysit`'s output in `sense-io.ts`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `number` | number | Yes | PR number. |
| `url` | string | Yes | PR URL. |
| `state` | string | Yes | `gh` PR state (e.g. `OPEN`, `MERGED`, `CLOSED`). |
| `mergeable` | string | Yes | `gh` mergeable status. |
| `reviewDecision` | string | No | `gh` review decision; `""` when none. |
| `headBranch` | string | Yes | Head ref name (`headRefName`). |
| `title` | string | Yes | PR title. |
| `author` | string | Yes | Author login. |
| `checks` | CheckRollup | Yes | Summarized `statusCheckRollup` (counts by conclusion). |
| `failedChecks` | CheckSummary[] | Yes | The failing checks, summarized. |
| `unresolvedThreads` | ReviewThread[] | Yes | Unresolved review threads (see entity 4), each annotated with `needsResponse`. |
| `threadCount` | number | Yes | Count of unresolved threads. |
| `needsResponseCount` | number | Yes | Threads whose last author is not the PR author. |

Validation rules:
- `checks` and `failedChecks` summarize `statusCheckRollup`; an empty/null rollup
  yields a "no checks" summary, never an error.
- `unresolvedThreads[*].needsResponse` is derived: `last_author !== author`.

### 3) PullRequestListItem (`pull_request_list_item`)

Purpose: The bounded per-PR shape returned by `listPrs`. Mirrors the
`gh pr list --json number,url,state,mergeable,headRefName,title,statusCheckRollup,createdAt`
projection used by `discoverPrForSlice`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `number` | number | Yes | PR number. |
| `url` | string | Yes | PR URL. |
| `state` | string | Yes | PR state. |
| `mergeable` | string | No | Mergeable status when present. |
| `headBranch` | string | Yes | Head ref name. |
| `title` | string | Yes | PR title. |
| `checks` | CheckRollup | No | Summarized rollup when requested. |
| `createdAt` | ISO-8601 timestamp | Yes | Used by callers for `prDiscoverySince` floors. |

Validation rules:
- An empty result set is a valid empty list, not an error.
- `createdAt` must be present so callers can apply a discovery-since floor.

### 4) ReviewThread (`review_thread`)

Purpose: An unresolved review thread, shaped from the `gh api graphql`
review-threads query. Carries the per-comment ids the legate uses to dedup
`/smithy.fix` (#224).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | number | Yes | First comment's `databaseId`. |
| `path` | string | No | First comment's file path. |
| `line` | number | No | First comment's line. |
| `author` | string | No | First comment's author login. |
| `bodyPreview` | string | Yes | First comment body, bounded (≈140 chars today). |
| `lastAuthor` | string | No | Last comment's author login. |
| `lastCommentAt` | ISO-8601 timestamp | No | Last comment timestamp. |
| `commentCount` | number | Yes | Number of comments in the thread. |
| `commentIds` | number[] | Yes | Every comment's `databaseId` (the #224 dedup key set). |

Validation rules:
- Only threads with `isResolved === false` are included.
- Comments are sorted by `createdAt` ascending before first/last extraction.
- `bodyPreview` must be bounded; raw unbounded comment bodies are never returned.

### 5) ForgeErrorEnvelope (`forge_error_envelope`)

Purpose: The uniform error body on every non-2xx response.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `error.code` | enum | Yes | One of `invalid_request`, `unauthorized`, `not_found`, `forge_error`, `internal`. |
| `error.message` | string | Yes | Human-readable, bounded; safe to surface to a client. |

Status mapping:

| Code | HTTP | Meaning |
|------|------|---------|
| `invalid_request` | 400 | Bad field / invalid argument. |
| `unauthorized` | 401 | Missing or wrong bearer token on `/v1/*`. |
| `not_found` | 404 | Unknown route or absent forge resource (e.g. PR number). |
| `forge_error` | 502 | `gh` failed, timed out, was unreachable, or returned unparseable output. |
| `internal` | 500 | Unexpected service error. |

### 6) StatioConfig (`statio_config`)

Purpose: Service configuration value object (the `src/statio/config.ts` analogue
of Castra's config).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `serviceName` | const string | Yes | `march-statio` (OTel `service.name`). |
| `port` | number | Yes | Deterministic 9689 (`sha256(serviceName) → 8800–9799`); override `MARCH_STATIO_PORT`. |
| `urlEnv` | const string | Yes | `MARCH_STATIO_URL`. |
| `portEnv` | const string | Yes | `MARCH_STATIO_PORT`. |
| `tokenEnv` | const string | Yes | `MARCH_STATIO_TOKEN`. |

Validation rules:
- A `MARCH_STATIO_PORT` override must be a whole-string integer in 1..65535;
  anything else fails fast (the Castra `resolveCastraPort` rule).

## Supporting value types

- **CheckRollup**: summary of `statusCheckRollup` by conclusion (e.g.
  `{ total, passed, failed, pending }`). Exact shape mirrors `checksSummary` in
  `sense-io.ts`.
- **CheckSummary**: a single failed check (name + conclusion + url), mirroring
  `failedChecks`.

## Relationships

- One `RepoInfo` scopes all PR reads (owner → `-R owner`).
- One `PullRequestSummary` owns zero or more `ReviewThread`s
  (`unresolvedThreads`).
- `listPrs` returns zero or more `PullRequestListItem`s; a caller may then call
  `getPr(number)` to obtain the richer `PullRequestSummary`.
- Every error response is exactly one `ForgeErrorEnvelope`.

## State Transitions

Statio holds no entity state, so there are no persistent lifecycles. The only
transition is per-request:

1. `request -> shaped` — `gh` invoked (timeout-bounded), output parsed and
   narrowed to the wire shape; returns `200`.
2. `request -> forge_error` — `gh` fails, times out, is unreachable, or returns
   unparseable output; returns `502 forge_error`.
3. `request -> rejected` — bad token (`401`), bad argument (`400`), or unknown
   route / absent resource (`404`).

## Identity & Uniqueness

- No durable identity: Statio stores nothing.
- A `PullRequestSummary` / `PullRequestListItem` is identified within a response
  by `number`; a `ReviewThread` by its first-comment `id`.
- Responses are point-in-time; two reads of the same PR may differ as forge state
  changes. A future read cache (F6) must preserve this observable
  read-your-forge-state semantics (no stale source of truth).
