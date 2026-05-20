# Castra — the interactive-sessions host

**Castra** (Latin: a Roman legion's fortified camp) is the March service that
owns the one tmux server / `agent-deck` install and exposes a small HTTP API over
it. It pairs with **Legate**, the commander: the camp is where the soldiers
(spawns) and stewards are quartered. Consumers call Castra's API instead of
shelling out to `agent-deck` or bind-mounting it, so `agent-deck` lives in exactly
one place and becomes an implementation detail of a single service.

> **Status — PR1 (service only).** This ships the API + agent-deck adapter +
> container + telemetry. Cutting the legate-loop over to the API, the dual-run
> migration, and removing the agent-deck bind-mounts from the legate container
> are tracked follow-ups (#156, #157); see also #158–#161.

## Topology

One **shared** Castra host: a single container (`march-castra`) on the `march`
docker network, owning one tmux server / `agent-deck` install for all profiles.
`profile` is a per-request parameter, never a per-container dimension.

## HTTP API

JSON in/out. `profile` is required on every call (body field for writes, query
param for reads) and validated before any `agent-deck` invocation. All `/v1/*`
routes require `Authorization: Bearer <CASTRA_API_TOKEN>`; `/healthz` and
`/status` are open.

| Method | Path | Maps to |
|---|---|---|
| `GET` | `/healthz` | liveness |
| `GET` | `/status` | service/version/uptime + `agent-deck` reachability |
| `GET` | `/v1/sessions?profile=&group=` | `agent-deck list --json` |
| `POST` | `/v1/sessions` | `agent-deck launch …` (→ `201`) |
| `GET` | `/v1/sessions/:id?profile=` | `agent-deck session show --json` |
| `POST` | `/v1/sessions/:id/send` | `agent-deck session send` (→ `202`) |
| `GET` | `/v1/sessions/:id/output?profile=&lines=` | `agent-deck session output` |
| `POST` | `/v1/sessions/:id/set` | `agent-deck session set` (key allow-listed) |
| `DELETE` | `/v1/sessions/:id?profile=&pruneWorktree=` | `agent-deck session remove --force` |

Every non-2xx response is the uniform envelope `{"error":{"code","message"}}`.
Error codes: `400 invalid_request`, `401 unauthorized`, `404 not_found`,
`409 conflict` (the wrong-worktree launch race — callers re-dispatch),
`502 agent_deck_error`, `500 internal`. `DELETE` is idempotent: a missing session
returns `200 {removed:false}` rather than `404`.

The `set` key is restricted to an allow-list (`auto-mode`, `title`, `model`) — the
API is a focused control surface, not an arbitrary-mutation passthrough.

## Running it

```bash
# Build + launch the shared container on the `march` network.
export CASTRA_API_TOKEN=$(openssl rand -hex 32)
march castra up --repo /path/to/repo      # --repo is repeatable (worktree path parity)

# Or run the service directly on the host (binds 127.0.0.1 by default):
march castra serve --token "$CASTRA_API_TOKEN"
```

`march castra up` builds `march-castra:<version>` (the same toolbox base as the
legate container) and runs it on the `march` network, publishing a deterministic
loopback port in the **8800–9799** band (hashed from the service name, matching
the legate-loop scheme). Consumers reach it as `http://castra:<port>` on the
`march` network, or `http://127.0.0.1:<port>` from the host.

March launches its service containers imperatively (the legate container works
the same way) rather than via `docker-compose`, because the bind mounts are
host-specific: the install dir, repos at identical absolute paths, the tmux
socket dir, and the uid all vary per machine. The shared `march` network is
declared by the otel-lgtm compose stack; `march castra up` **creates it if it
doesn't exist** (`ensureMarchNetwork`), so Castra starts cleanly even when the
observability stack is down.

### Worktree path parity

Castra **relocates** `agent-deck` into one container; it does not re-home it.
`--repo <path>` bind-mounts a repo and its worktree-parent at the **same absolute
path** inside the container, so a worktree Castra creates at
`/abs/parent/feature-x` exists at that identical path on the host and in any spawn
container that mounts the same parent — no path translation, no broken
`git apply` cwd. (Whether sessions should instead run fully in-container is the
deferred decision in #161.)

## Security

Even on the `march` network, any peer that joins could otherwise drive
`agent-deck` (launch agents, prune worktrees), so `/v1/*` is gated by a shared
bearer token (`CASTRA_API_TOKEN`). Do **not** publish the port on a public
interface. Per-caller tokens / mTLS is a hardening follow-up (#160). If the token
is unset, `serve` logs a loud warning and runs unauthenticated — only acceptable
for a strictly loopback, single-user dev box.

## Observability

The service reports `service.name=march-castra` and emits RED metrics + per-op
spans — see [`Observability.md`](Observability.md) and the **March — Castra
sessions host** Grafana dashboard. All telemetry is a no-op unless `MARCH_OTEL=1`.
