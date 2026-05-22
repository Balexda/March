# Castra — the interactive-sessions host

**Castra** (Latin: a Roman legion's fortified camp) is the March service that
owns the one tmux server / `agent-deck` install and exposes a small HTTP API over
it. It pairs with **Legate**, the commander: the camp is where the soldiers
(spawns) and stewards are quartered. Consumers call Castra's API instead of
shelling out to `agent-deck` or bind-mounting it, so `agent-deck` lives in exactly
one place and becomes an implementation detail of a single service.

> **Status.** PR1 shipped the API + agent-deck adapter + container + telemetry.
> The **legate loop is now cut over** to the API (#156): it makes all session
> calls (list/launch/output/send/set/remove) to Castra via HTTP and the legate
> container no longer mounts the `agent-deck` binary or `~/.agent-deck` (#157).
> The session shape exposes agent-deck `status` and launch supports
> `createBranch:false` (attach to an existing worktree) for the loop's steward
> relaunch. Remaining: dual-run migration tooling; see also #158–#161.

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

## Consumers

The **Hatchery** and the **legate loop** are both consumers, through the client
in [`src/castra/client.ts`](../src/castra/client.ts). `runHatcherySpawn`
(`src/hatchery/spawn-handoff.ts`) launches the steward (`POST /v1/sessions`),
hands it the patch prompt (`POST /v1/sessions/:id/send`), and prunes it on
failure (`DELETE /v1/sessions/:id`) via the async `CastraClient` — so the
Hatchery container no longer mounts `agent-deck` or the tmux socket. The legate
loop (#156, #157) makes all of its session calls (list/launch/output/send/remove)
the same way, but through `SyncCastraClient` in the same module — its tick is
synchronous, so it uses a `curl` transport while sharing the URL/token
resolution, slice-id header, error envelope, and wire types. Both point at Castra
with `CASTRA_URL` (default `http://castra:9264` on the `march` network) +
`CASTRA_API_TOKEN`.

## Running it

Castra deploys as a container via Docker Compose, mirroring the Hatchery service
([`docker/castra.docker-compose.yml`](../docker/castra.docker-compose.yml),
image [`docker/castra.Dockerfile`](../docker/castra.Dockerfile)):

```bash
# 1. observability stack first (creates the shared `march` network):
docker compose -f docker/otel-lgtm.docker-compose.yml up -d

# 2. build + run castra (from the repo root):
npm run build:castra-image
export CASTRA_API_TOKEN=$(openssl rand -hex 32)   # required — compose aborts without it
docker compose -f docker/castra.docker-compose.yml up -d
```

Consumers reach the API at `http://localhost:${CASTRA_PORT:-9264}` on the host,
or `http://castra:${CASTRA_PORT:-9264}` from peers on the `march` network. The
default port is the deterministic **9264** (in the 8800–9799 band, hashed from the
service name); override with `CASTRA_PORT`. The compose file binds the port to
localhost only and joins the `march` network as `external: true` (created by the
otel-lgtm stack). Host-specific knobs (`MARCH_HOST_HOME`, `MARCH_HOST_UID`,
`MARCH_DOCKER_GID`, …) are documented inline in the compose file.

For host-local development you can also run the service directly without a
container — it binds `127.0.0.1` by default:

```bash
CASTRA_API_TOKEN=… march castra serve
```

### Worktree path parity

Castra **relocates** `agent-deck` into one container; it does not re-home it. The
compose file bind-mounts the host `HOME` at the **same absolute path** inside the
container (`${MARCH_HOST_HOME}:${MARCH_HOST_HOME}`, the Hatchery pattern), so a
worktree agent-deck creates at `/abs/parent/feature-x` exists at that identical
path on the host and in any spawn container that mounts it — no path translation,
no broken `git apply` cwd. (Whether sessions should instead run fully in-container
is the deferred decision in #161.)

## Security

Even on the `march` network, any peer that joins could otherwise drive
`agent-deck` (launch agents, prune worktrees), so `/v1/*` is gated by a shared
bearer token (`CASTRA_API_TOKEN`). The compose file **requires** it
(`${CASTRA_API_TOKEN:?…}`) and aborts the bring-up if it's unset, because the
container binds `0.0.0.0` on the shared network. Do **not** publish the port on a
public interface. Per-caller tokens / mTLS is a hardening follow-up (#160). The
host-only `march castra serve` path, by contrast, binds loopback and logs a loud
warning if it runs without a token — acceptable only for a single-user dev box.

## Observability

The service reports `service.name=march-castra` and emits RED metrics, a
liveness heartbeat + uptime gauge, per-op spans, and request logs (via the OTLP
pino logger) — see [`Observability.md`](Observability.md) and the **March —
Castra sessions host** Grafana dashboard. All telemetry is a no-op unless
`MARCH_OTEL=1`.
