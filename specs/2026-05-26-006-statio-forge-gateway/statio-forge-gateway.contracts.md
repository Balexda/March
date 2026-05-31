# Contracts: Statio Forge Gateway (Service Foundation)

## Overview

Statio defines the boundary between March consumers and the forge (`gh`). It
exposes a swappable `ForgeClient` interface (the consumer-facing seam, Castra's
adapter analogue), a bearer-token HTTP API that realizes it, and a uniform error
model. v1 is reads only; mutations (v2) extend the same interface in a later
Stage B follow-on. These contracts mirror Castra's
`src/castra/{types,client,server,config}.ts` — except Statio is **async-only**
(no `SyncStatioClient`; the Legate cutover adapts to async).

## Types

These named types appear in the signatures below. They map onto the entities in
the [data model](statio-forge-gateway.data-model.md); field-level validation rules
live there.

| Type | Kind | Shape |
|------|------|-------|
| `RepoInfo` | value | `{ owner: string; defaultBranch: string }`. |
| `ListPrsRequest` | input | `{ head?: string; author?: string; state?: "open" \| "closed" \| "merged" \| "all" }`. |
| `PullRequestListItem` | value | Bounded per-PR list shape (see data model). |
| `PullRequestSummary` | value | Rich single-PR read (state/mergeable/reviewDecision/checks/threads). |
| `ReviewThread` | value | Unresolved review thread with `commentIds` (#224 dedup). |
| `ForgeErrorBody` | error | `{ error: { code: ForgeErrorCode; message: string } }`. |
| `ForgeErrorCode` | enum | `"invalid_request" \| "unauthorized" \| "not_found" \| "forge_error" \| "internal"`. |
| `StatioClientError` | error | Typed client error preserving `code` + `status` from the envelope. |

## Interfaces

### ForgeClient (the consumer seam)

**Purpose**: One typed, mockable interface for all forge reads, depended on by
consumers instead of assembling `gh` argv. Realized by the async (`fetch`) HTTP
client and by an in-process test double.
**Consumers**: Herald `sense-io` (Herald cutover follow-on), legate loop / recovery (Legate cutover follow-on), their tests.
**Providers**: `StatioClient` (async), test fakes.

#### Signature

```typescript
interface ForgeClient {
  repoInfo(): Promise<RepoInfo>;
  listPrs(req: ListPrsRequest): Promise<PullRequestListItem[]>;
  getPr(number: number): Promise<PullRequestSummary>;
  reviewThreads(prNumber: number): Promise<ReviewThread[]>;
  reachable(): Promise<boolean>;
}
// Async-only: every method returns a Promise. Unlike Castra there is no
// SyncStatioClient; the legate loop's tick consumes the async client directly.
```

#### Inputs

| Method | Parameter | Type | Required | Description |
|--------|-----------|------|----------|-------------|
| `listPrs` | `head` | string | No | Filter by head branch (`gh pr list --head`). |
| `listPrs` | `author` | string | No | Filter by author, e.g. `@me` (`--author`). |
| `listPrs` | `state` | enum | No | PR state filter; default `open`. |
| `getPr` | `number` | number | Yes | PR number to read. |
| `reviewThreads` | `prNumber` | number | Yes | PR whose unresolved threads to read. |

#### Outputs

Each method returns the corresponding wire entity (see the data model).
`reachable()` returns `true` only when Statio is up, the token is accepted, AND
`gh` answered — it never throws.

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Transport unreachable | throws `StatioClientError` (no `code`) | Could not reach Statio. |
| Non-2xx envelope | throws `StatioClientError` (`code`, `status`) | Maps the server envelope; callers branch on `code` (e.g. retry on `forge_error`). |
| `reachable()` any failure | returns `false` | Best-effort probe; never throws. |

---

### Statio HTTP API

**Purpose**: The bearer-token HTTP surface realizing `ForgeClient`.
**Consumers**: the HTTP client above.
**Providers**: `march statio serve` (Fastify).

JSON in/out. All `/v1/*` routes require `Authorization: Bearer <MARCH_STATIO_TOKEN>`;
`/healthz` and `/status` are open. Requests may carry `x-march-slice-id` for span
correlation. Every non-2xx response is the uniform `ForgeErrorBody`.

| Method | Path | Maps to (`gh`) | Success |
|--------|------|----------------|---------|
| `GET` | `/healthz` | liveness | `200` |
| `GET` | `/status` | service/version/uptime + `gh` reachability | `200` |
| `GET` | `/v1/repo` | `gh repo view --json nameWithOwner,defaultBranchRef` | `200` `{ repo: RepoInfo }` |
| `GET` | `/v1/prs?head=&author=&state=` | `gh pr list --head/--author --state --json …` | `200` `{ prs: PullRequestListItem[] }` |
| `GET` | `/v1/prs/:number` | `gh pr view <n> --json …` | `200` `{ pr: PullRequestSummary }` |
| `GET` | `/v1/prs/:number/review-threads` | `gh api graphql` review threads | `200` `{ threads: ReviewThread[] }` |

#### Error Conditions

| Condition | Code | HTTP |
|-----------|------|------|
| Missing/invalid bearer token on `/v1/*` | `unauthorized` | 401 |
| Bad field / invalid query argument | `invalid_request` | 400 |
| Unknown route or absent PR | `not_found` | 404 |
| `gh` failed / timed out / unreachable / unparseable | `forge_error` | 502 |
| Unexpected service error | `internal` | 500 |

---

### Service configuration

**Purpose**: Deterministic port, env var names, service name, identifier
validation (the `src/statio/config.ts` analogue of Castra's config).
**Consumers**: service entrypoint, the async client.
**Providers**: `src/statio/config.ts`.

#### Signature

```typescript
const STATIO_SERVICE_NAME = "march-statio";
const STATIO_URL_ENV = "MARCH_STATIO_URL";
const STATIO_PORT_ENV = "MARCH_STATIO_PORT";
const STATIO_TOKEN_ENV = "MARCH_STATIO_TOKEN";

function statioPort(): number;                 // 9689, sha256(name) → 8800–9799
function resolveStatioPort(override?, env?): number; // validates; fails fast
function resolveStatioBaseUrl(env?): string;   // MARCH_STATIO_URL || localhost:<port>
function resolveStatioToken(env?): string | undefined;
```

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Non-numeric / out-of-range port override | throws (validation) | A typo fails fast rather than binding an unintended port. |

## Events / Hooks

No new Herald event type is introduced by this spec. Statio is stateless and
emits no domain events. It emits **telemetry only** (OTel) under
`service.name=march-statio`: RED metrics, a heartbeat/uptime gauge, per-operation
spans (child-nested on `x-march-slice-id` when present, never a new root), and
request logs through the shared pino+OTLP logger — all no-op unless `MARCH_OTEL=1`.
Metric labels stay low-cardinality (operation name, status code class — never PR
numbers or concrete request paths).

## Integration Boundaries

- **Herald (`src/observe/sense-io.ts`)** — Herald-cutover follow-on PR. Replaces
  its direct `gh repo view` / `gh pr view` / `gh pr list` / `gh api graphql`
  calls with the `ForgeClient`; its `/readyz` swaps `isOnPath("gh")` for a Statio
  reachability probe; the Herald image drops `gh` + the `~/.config/gh` mount. v1
  response shapes are pinned to `sense-io.ts`'s current output so this cutover
  is behavior-preserving.
- **Legate (loop / recovery, `legate.unwedge`)** — Legate-cutover follow-on PR.
  Sources the on-remote PR-safety decision (`listPrs({ head })`) from Statio;
  the loop image drops `gh`.
- **Hatchery** — owns **no** forge logic. The #245 self-heal's forge-dependent
  branch into reads moves out of Hatchery; the pure-local no-remote fast-path
  (#249, already landed) stays. Any forge-dependent decision escalates to the
  Legate recovery path, which resolves it via Statio.
- **Castra** — the structural reference, not a runtime dependency. Statio reuses
  Castra's service/client/adapter/config/telemetry patterns; the two services are
  independent peers on the `march` network.
- **`git`** — explicitly **not** an integration boundary. Local git stays direct in
  its owning services; Statio is forge-only.
- **Observability stack** — Statio joins the existing OTel → `otel-lgtm` pipeline
  and adds a **March — Statio forge gateway** Grafana dashboard; it reuses the
  existing deterministic trace-id helpers rather than introducing new ones.
