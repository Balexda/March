# Observability

March emits OpenTelemetry traces, metrics, and logs so you can answer three
questions about the autonomous dispatch loop:

1. **Spawn success rate** — what fraction of dispatched spawns exit cleanly?
2. **Spawn runtime** — how long do spawns take, by backend and task type?
3. **Per-dispatch lineage** — what happened to one unit of work, across the three
   separate processes that touch it (the loop, the spawn orchestrator, the
   in-container agent)?

Telemetry is **opt-in and a complete no-op unless `MARCH_OTEL=1`**. A missing or
down collector can never fail a command — emitters are best-effort behind short
timeouts, and the spawn sandbox's argv is byte-for-byte identical whether
telemetry is on or off.

## The stack: `otel-lgtm`

[`docker/otel-lgtm.docker-compose.yml`](../docker/otel-lgtm.docker-compose.yml)
runs Grafana's all-in-one [`grafana/otel-lgtm`](https://github.com/grafana/docker-otel-lgtm)
image: Grafana + an OpenTelemetry Collector + **T**empo (traces) + **L**oki
(logs) + Prometheus/Mimir (**G**rafana **M**etrics). Datasources are
auto-provisioned; March's dashboard is provisioned on top (see below).

```bash
docker compose -f docker/otel-lgtm.docker-compose.yml up -d
open http://localhost:3000      # Grafana — default login admin/admin
```

Exposed ports: Grafana `3000`, OTLP gRPC `4317`, OTLP HTTP `4318`. **Do not
expose these on a public interface.** Persistence is via named volumes, so
dashboards/metrics/traces survive a restart; `docker compose ... down -v` wipes
them.

The compose declares a `march` network. It's the seed of the eventual
multi-container stack — a containerized loop / hatchery / Herald can join it and
reach the collector at `otel-lgtm:4318`.

## Turning telemetry on

| Variable | Default | Meaning |
|---|---|---|
| `MARCH_OTEL` | unset | Master switch. Telemetry is active **only** when set to `1`. |
| `MARCH_OTEL_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP base endpoint. `MARCH_OTEL_ENDPOINT` wins if both are set. |
| `MARCH_OTEL_SERVICE_NAME` | `march` | `service.name` resource attribute for the orchestrator's spans/metrics. The Legate loop's own spans always report `service.name=march-legate`; the Hatchery service container sets `march-hatchery`. |
| `MARCH_HATCHERY_URL` | `http://localhost:8080` | Base URL the `march hatchery spawn` thin client posts to. |
| `MARCH_HATCHERY_PORT` | `8080` | Port the `march hatchery serve` service listens on. |
| `MARCH_HATCHERY_LOG_DIR` | `~/.march/logs` | Directory for the service's JSONL log file (`hatchery.jsonl`). |

How each emitter reaches the collector:

- **`march` CLI on the host** → `http://localhost:4318`
- **a spawn sandbox** (bridge network) → `http://host.docker.internal:4318`
  (the orchestrator injects this plus a W3C `traceparent` into the container)
- **a containerized legate loop** → `http://host.docker.internal:4318`, or
  `http://otel-lgtm:4318` when the container is attached to the `march` network

### Enabling it for a Legate deployment

The Legate loop freezes its telemetry config into its meta file at
`march legate init` time (so the standalone loop process needs no env at
runtime). The `march hatchery spawn` orchestrator the loop shells out to reads
the env at runtime. So **set the env before `init`, and keep it set in the
environment the loop runs in**:

```bash
export MARCH_OTEL=1
export MARCH_OTEL_ENDPOINT=http://localhost:4318   # host-conductor default
march legate init …            # freezes endpoint + enabled into loop meta
# launch the conductor/loop from this same environment
```

- **Host conductor (default):** `localhost:4318` works directly. Make sure the
  agent-deck conductor that launches the loop inherits `MARCH_OTEL=1` so the
  orchestrator children emit too.
- **Managed container (`--with-container`):** `MARCH_OTEL*` /
  `OTEL_EXPORTER_OTLP_ENDPOINT` are forwarded into the container, but the
  endpoint must be reachable from *inside* it — use
  `http://host.docker.internal:4318` (or `http://otel-lgtm:4318` on the `march`
  network). Run `init` with the **same** endpoint the container will use, so the
  loop's frozen config matches its runtime network.

## What gets emitted

### Traces — one trace per dispatched unit of work

The trace id is hashed deterministically from the slice id
(`trace id = sha256("march.trace:" + sliceId)[:32]`), so spans emitted by three
separate processes with no shared in-memory context still land in one trace.
`legate.dispatch` claims the deterministic root span id
(`sha256("march.span:" + sliceId)[:16]`); everything else nests beneath it.
render / mark / cut / forge stay **separate** traces — there is no work-item
grouping.

| span | emitted by | where |
|---|---|---|
| `legate.dispatch` | Legate loop | generated loop (`maybeEmitLoopSpan`) |
| `legate.babysit` | Legate loop | generated loop |
| `legate.cleanup` | Legate loop | generated loop |
| `hatchery.spawn` | orchestrator | `runHatcherySpawn` |
| `spawn.start` | orchestrator | container create/start |
| `spawn.end` | orchestrator | `waitForSpawnContainer` |
| `steward.apply` | orchestrator | `applyPatchToManagerWorktree` |
| `spawn.exec` | **inside the sandbox** | wrapped backend entrypoint |

The human `march spawn dispatch` path emits `spawn.dispatch` → `spawn.start` /
`spawn.end`.

**Failed-spawn handling** also shows up as traces. The loop tags every dispatch
span with `march.dispatch_mode`:

- `spawn` — a normal codex spawn.
- `recovery` — a recovery codex spawn after a prior dispatch failed
  (`<sliceId>-recovery-N`). It is its own dispatched unit of work, so it gets its
  own trace and the recovery spawn's `hatchery.spawn` / `spawn.*` spans nest
  beneath it.
- `direct_steward` — the no-spawn direct-steward fallback (`<sliceId>-direct`).
  There is no codex container, so the trace is just the root span.

A dispatch whose **launch throws** (the orchestrator never runs) is recorded as
an **errored** `legate.dispatch` span carrying `march.error`, so the failure
still surfaces as a trace even though no `hatchery.spawn` was ever emitted.

Every span also carries `march.profile` — see [Profiles](#profiles-isolating-testinteg-telemetry).

### Metrics

Tagged `{backend, task_type, profile, outcome}`. `spawn_id` / `slice_id` are
deliberately **not** metric labels — per-spawn detail lives in traces, and
keeping ids out of labels bounds cardinality.

| OTel instrument | Prometheus series | Meaning |
|---|---|---|
| `march.spawn.runs` (counter) | `march_spawn_runs_total` | spawn dispatches by outcome |
| `march.spawn.duration` (histogram, `s`) | `march_spawn_duration_seconds_{bucket,count,sum}` | spawn wall-clock duration |

`outcome` is `success` (container exit 0) or `failure`.

#### Hatchery service metrics

The Hatchery service (see [Hatchery as a service](#hatchery-as-a-service)) emits
its own instruments, defined in
[`src/observability/hatchery-metrics.ts`](../src/observability/hatchery-metrics.ts).
Labels stay low-cardinality — `route` is the route **template** (`/spawns/:id`),
never the concrete path.

| OTel instrument | Prometheus series | Meaning |
|---|---|---|
| `march.hatchery.requests` (counter) | `march_hatchery_requests_total` | HTTP requests by `{route, method, outcome}` (`outcome` = `success` for 2xx/3xx, else `error`) |
| `march.hatchery.request.duration` (histogram, `s`) | `march_hatchery_request_duration_seconds_{bucket,count,sum}` | HTTP request latency |
| `march.hatchery.active_spawns` (up/down) | `march_hatchery_active_spawns` | spawn jobs currently executing |
| `march.hatchery.uptime` (gauge, `s`) | `march_hatchery_uptime_seconds` | service process uptime |
| `march.hatchery.heartbeat` (counter) | `march_hatchery_heartbeat_total` | liveness tick (every 15s) |

### Logs

The Hatchery service writes structured JSONL with pino to a log file
(`$MARCH_HATCHERY_LOG_DIR/hatchery.jsonl`, default `~/.march/logs/`) **and**, when
`MARCH_OTEL=1`, mirrors each record to the collector over OTLP/HTTP
(`/v1/logs`) → Loki. The file sink is always on so logs survive even with
telemetry off; the OTLP bridge and pino level→OTel-severity mapping live in
[`src/observability/logger.ts`](../src/observability/logger.ts). Records carry
`trace_id`/`span_id` when emitted inside a dispatch span, so you can pivot from a
log line to its trace. In Grafana: **Explore → Loki**, query
`{service_name="march-hatchery"}`.

### Profiles (isolating test/integ telemetry)

Every metric and span is tagged with a **profile** — metric label `profile`,
span attribute `march.profile`. The profile is the **Legate deployment's
profile**, chosen at deploy time:

```bash
march legate init -p smithy …    # this deployment's telemetry is profile="smithy"
```

It is owned by the deployment, not derived from the agent-deck profile or an
environment variable. The same profile is what places the deployment's
agent-deck sessions, so telemetry, sessions, and on-disk paths all line up under
one name.

This is what keeps integration-test runs from polluting a real deployment's
numbers: run the tests under a dedicated profile (e.g. `gate`), and every panel
filters them out with `profile=~"$profile"` (or
`march_spawn_runs_total{profile!="gate"}` in a raw query). The profile flows
through every emitter — loop spans (`meta.profile`), the orchestrator and the
in-sandbox `spawn.exec` span (`march hatchery spawn --profile`, passed down by
the loop), and the metrics. Spawns with no deployment profile (e.g. an ad-hoc
`march spawn dispatch` without `--profile`) report `profile="unknown"`.

## Hatchery as a service

Hatchery runs as a **single long-running container** that exposes an HTTP API;
`march hatchery spawn` is a thin client that posts to it instead of doing the
work in-process. This gives one place that emits the logs/metrics/traces above
and can be observed as a service.

- **Entrypoint:** `march hatchery serve` (Fastify). Compose:
  [`docker/hatchery.docker-compose.yml`](../docker/hatchery.docker-compose.yml),
  image: [`docker/hatchery.Dockerfile`](../docker/hatchery.Dockerfile).
- **API:** `POST /spawns` (creates a job, returns `202 {id}`),
  `GET /spawns/:id` (job status/result), `GET /healthz` (liveness),
  `GET /readyz` (docker + agent-deck reachable). Spawns can run up to an hour, so
  the API is an async job + poll; the client blocks by polling, preserving the
  legate loop's existing `march hatchery spawn --json` contract.
- **Execution:** each job runs in a `worker_threads` worker that re-loads the CLI
  bundle and calls the unchanged `runHatcherySpawn`, so the synchronous
  agent-deck/docker/git work never blocks the event loop.
- **Host access:** the container joins the `march` network (reaches the collector
  at `otel-lgtm:4318`) and mounts the docker socket, the host `HOME` at the
  **identical path** (so repo + worktree paths agent-deck creates are valid
  inside the container — this is required for `git apply`), the host tmux socket,
  and the agent-deck binary. Spawn sandboxes it launches are siblings on the host
  daemon and still reach the collector at `host.docker.internal:4318`.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the bring-up commands.

## The dashboard

[`docker/grafana/dashboards/march-spawns.json`](../docker/grafana/dashboards/march-spawns.json)
("**March — Spawn observability**") is auto-provisioned into a **March** folder
in Grafana. The provider config
([`docker/grafana/provisioning/dashboards/march.yaml`](../docker/grafana/provisioning/dashboards/march.yaml))
is mounted alongside the image's own provider files, so it adds the folder
without clobbering the bundled datasources or RED/JVM dashboards.

Panels: spawn success rate, spawns by outcome, spawn rate by outcome, a
task-type × outcome breakdown table, duration percentiles (p50/p95/p99), p95 by
task type, and a recent-dispatch-traces table (Tempo). `backend` / `task_type` /
`profile` / `outcome` template variables filter the metric panels — set
`profile` to scope a dashboard to one deployment (or exclude a test profile).

A second dashboard,
[`docker/grafana/dashboards/march-hatchery.json`](../docker/grafana/dashboards/march-hatchery.json)
("**March — Hatchery service**"), covers the service itself: heartbeat/uptime,
active spawns, HTTP request rate + latency percentiles + error rate, spawn
success rate (shared `march_spawn_runs_total`), a Loki logs panel
(`{service_name="march-hatchery"}`), and a Tempo traces table.

To browse raw traces: **Explore → Tempo**, query
`{ resource.service.name =~ "march.*" }`. Metrics: **Explore → Prometheus**,
e.g. `march_spawn_runs_total`. Logs: **Explore → Loki**,
`{service_name="march-hatchery"}`.

## Validating the stack end to end

```bash
docker compose -f docker/otel-lgtm.docker-compose.yml up -d
export MARCH_OTEL=1 MARCH_OTEL_ENDPOINT=http://localhost:4318
# run a tagged dispatch (or let the Legate loop run one), then:
open http://localhost:3000/d/march-spawns
```

You should see the spawn counters climb and a trace per dispatch
(`legate.dispatch → hatchery.spawn → spawn.start/end/steward.apply + spawn.exec`)
in the traces table. If panels are empty, confirm `MARCH_OTEL=1` was set for the
emitting process and that its endpoint resolves from where it runs (host vs.
container).

## Keeping observability current

Telemetry only stays useful if it tracks the code. When you change the dispatch
machinery, update the signals in lock-step:

- **New loop lifecycle action or dispatch path** (a new `kind`/`action` in the
  loop's event stream) → add a branch to `maybeEmitLoopSpan` in
  [`src/legate/init.ts`](../src/legate/init.ts) so it emits a span keyed off the
  slice id. Root spans for a *new dispatched unit of work* should claim
  `otelSpanId(sliceId)`; lifecycle actions on an existing dispatch should nest
  under it via `parentSpanId`.
- **New failure mode** → emit an **errored** span (and, where the orchestrator
  runs, the appropriate metric `outcome`) so the failure shows up rather than
  silently vanishing. Recovery and direct-steward dispatches are the worked
  example.
- **A new process joins a trace** → reuse the deterministic id helpers so its
  spans land in the right trace. They are intentionally duplicated, byte-for-byte
  identical, in three places — keep them in sync:
  [`src/observability/trace-ids.ts`](../src/observability/trace-ids.ts) (the
  orchestrator), `otelTraceId` / `otelSpanId` in
  [`src/legate/init.ts`](../src/legate/init.ts) (the loop), and
  [`src/observability/in-spawn-emitter.ts`](../src/observability/in-spawn-emitter.ts)
  (the in-container emitter). The cross-process test in `init.test.ts` locks this
  alignment in.
- **New metric or label** → add it in
  [`src/observability/spawn-metrics.ts`](../src/observability/spawn-metrics.ts)
  (spawn metrics) or
  [`src/observability/hatchery-metrics.ts`](../src/observability/hatchery-metrics.ts)
  (Hatchery service metrics). Keep labels low-cardinality — never add a
  per-spawn/per-slice id or a concrete request path as a label; ids belong in
  traces, and routes use the template form. Then update the dashboard JSON if a
  panel should use it.
- **New log call** → use the pino logger from
  [`src/observability/logger.ts`](../src/observability/logger.ts) so it lands in
  the file sink and ships via OTLP. Logs stay a complete no-op transport when
  `MARCH_OTEL!=1` (the file is still written). Keep log attributes
  low-cardinality too.
- **New panel / query** → edit
  [`docker/grafana/dashboards/march-spawns.json`](../docker/grafana/dashboards/march-spawns.json)
  or [`docker/grafana/dashboards/march-hatchery.json`](../docker/grafana/dashboards/march-hatchery.json).
  Reference datasources by uid (`prometheus`, `tempo`, `loki`). Validate against
  a live stack before committing.

Source of truth for the emitters lives under
[`src/observability/`](../src/observability/); see [AGENTS.md](../AGENTS.md) and
[CONTRIBUTING.md](../CONTRIBUTING.md) for ownership.
