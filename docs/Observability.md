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
runtime). The loop dispatches by POSTing to the Hatchery service over HTTP
(`MARCH_HATCHERY_URL`), and that service emits its own spawn telemetry. So **set
the env before `init`, and keep it set in the environment the loop runs in**:

```bash
export MARCH_OTEL=1
export MARCH_OTEL_ENDPOINT=http://localhost:4318   # host-conductor default
march legate init …            # freezes endpoint + enabled into loop meta
# launch the conductor/loop from this same environment
```

- **Host conductor (default):** `localhost:4318` works directly. Make sure the
  agent-deck conductor that launches the loop inherits `MARCH_OTEL=1` so the
  orchestrator children emit too.
- **Managed container (`--with-container`):** the loop runs as a service
  (`march legate loop`, one container per profile, no agent-deck session for the
  loop). `MARCH_OTEL*` / `OTEL_EXPORTER_OTLP_ENDPOINT` are forwarded into the
  container, but the endpoint must be reachable from *inside* it — use
  `http://host.docker.internal:4318` (or `http://otel-lgtm:4318` on the `march`
  network). Run `init` with the **same** endpoint the container will use, so the
  loop's frozen config matches its runtime network. (The service also reconciles
  env from the frozen `meta.otel` at startup, so a meta written with telemetry on
  lights up the SDK without re-setting the env.)

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
| `legate.dispatch` | Legate loop | loop service (`emitLoopSpan`, `src/observability/loop-spans.ts`; classified by `maybeEmitLoopSpan` in `src/legate/loop/runtime.ts`) |
| `legate.babysit` | Legate loop | loop service |
| `legate.cleanup` | Legate loop | loop service |
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
| `march.hatchery.dispatches` (counter) | `march_hatchery_dispatches_total` | spawn dispatch jobs by `{backend, task_type, profile, outcome}` (`outcome` = `success`/`failure`) |
| `march.hatchery.active_spawns` (up/down) | `march_hatchery_active_spawns` | spawn jobs currently executing |
| `march.hatchery.uptime` (gauge, `s`) | `march_hatchery_uptime_seconds` | service process uptime |
| `march.hatchery.heartbeat` (counter) | `march_hatchery_heartbeat_total` | liveness tick (every 15s) |

`march.hatchery.dispatches` is the **async** dispatch outcome, distinct from the
HTTP request metric: `POST /spawns` returns `202` (an HTTP success) and the job
runs in the background, so a dispatch that *fails* never shows up in
`march_hatchery_requests_total`. The dashboard's "Dispatch error rate" panel
reads this counter so failed spawns surface even though the HTTP response was a
202.

#### Castra (interactive-sessions host)

The Castra service (`service.name=march-castra`) emits one counter + histogram
per API request, tagged with **low-cardinality labels only** —
`{route, method, status_class, profile, outcome}`. The matched route *pattern*
(e.g. `/v1/sessions/:id`) is the label, never the raw URL; session ids, branches,
and prompt bodies stay out of metrics (they belong in spans/logs).

| OTel instrument | Prometheus series | Meaning |
|---|---|---|
| `march.castra.requests` (counter) | `march_castra_requests_total` | API requests by route + outcome |
| `march.castra.request.duration` (histogram, `s`) | `march_castra_request_duration_seconds_{bucket,count,sum}` | API request wall-clock duration |

`outcome` is `success` (status < 500) or `failure`. Mutating requests
(`launch`/`send`/`set`/`remove`) also emit a `castra.<op>` span; when the caller
passes an `x-march-slice-id` header, the span keys off that dispatch slice id so
it nests under the existing per-dispatch trace.

#### Loop heartbeat metrics

The loop **service** emits one set of heartbeat metrics per tick via the OTel SDK
([`src/observability/loop-metrics.ts`](../src/observability/loop-metrics.ts)),
tagged `{profile, conductor}` only (plus a bounded `state` on the workers gauge).
These answer "is the loop alive?" and "how deep is the queue?".

| OTel instrument | Prometheus series | Meaning |
|---|---|---|
| `march.legate.loop.up` (gauge) | `march_legate_loop_up` | `1` while alive; absence ⇒ down |
| `march.legate.loop.heartbeats` (counter) | `march_legate_loop_heartbeats_total` | completed ticks |
| `march.legate.tick.age` (gauge, `s`) | `march_legate_tick_age_seconds` | seconds since last tick (staleness) |
| `march.legate.tick.duration` (histogram, `s`) | `march_legate_tick_duration_seconds_{bucket,count,sum}` | tick wall-clock |
| `march.legate.queue.dispatchable` (gauge) | `march_legate_queue_dispatchable` | tasks ready to dispatch now |
| `march.legate.queue.blocked` (gauge) | `march_legate_queue_blocked` | pending tasks blocked on deps |
| `march.legate.queue.total` (gauge) | `march_legate_queue_total` | total pending tasks |
| `march.legate.workers` (gauge) | `march_legate_workers` | worker sessions by `state` |
| `march.legate.dispatch.actions` (counter) | `march_legate_dispatch_actions_total` | dispatch actions taken |
| `march.legate.dispatch.failures` (counter) | `march_legate_dispatch_failures_total` | dispatch failures |
| `march.legate.cleanup.actions` (counter) | `march_legate_cleanup_actions_total` | maintenance actions by `action` |

### Logs

The **Hatchery service** writes structured JSONL with pino to a log file
(`$MARCH_HATCHERY_LOG_DIR/hatchery.jsonl`, default `~/.march/logs/`) **and**, when
`MARCH_OTEL=1`, mirrors each record to the collector over OTLP/HTTP
(`/v1/logs`) → Loki. The file sink is always on so logs survive even with
telemetry off; the OTLP bridge and pino level→OTel-severity mapping live in
[`src/observability/logger.ts`](../src/observability/logger.ts). Records carry
`trace_id`/`span_id` when emitted inside a dispatch span, so you can pivot from a
log line to its trace. In Grafana: **Explore → Loki**, query
`{service_name="march-hatchery"}`.

The **Legate loop service** forwards its action log to Loki via the OTel logs SDK
([`src/observability/logs.ts`](../src/observability/logs.ts);
`service.name=march-legate`), **in addition to** writing the NDJSON/text files in
the mounted conductor dir (so `docker logs` / `tail` still work for offline
debugging). Each action event becomes one log record tagged `{profile, conductor,
event_kind}`; failures map to `severity_text=ERROR`. Records for a dispatched
unit of work carry the **same deterministic `trace_id`/`span_id`** as the dispatch
span, so a log line in Grafana links straight to its Tempo trace. The per-tick
heartbeat is **not** logged (it is captured by the metrics above).

### The loop HTTP API

The loop service runs a small loopback HTTP API (`src/legate/loop/http.ts`,
Fastify) so the legate-agent can read loop state deterministically instead of
scraping logs. It exposes `GET /healthz` (liveness) and `GET /status` (the latest
heartbeat: queue depth, slice/worker counts, last-tick age). It is published on a
**deterministic per-conductor loopback host port** (`legateLoopHostPort`,
8800–9799) so multiple per-profile containers don't collide; the port is printed
in the `march legate init --with-container` summary. Loopback only — never
exposed publicly.

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
  the API is an async job + poll. The `march hatchery spawn` CLI and the legate
  loop are both clients: the loop's dispatch runner POSTs a spawn and polls the
  job to completion (via `MARCH_HATCHERY_URL`), writing the same result shape its
  completion logic always consumed.
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

Two more dashboards cover the services.
[`docker/grafana/dashboards/march-hatchery.json`](../docker/grafana/dashboards/march-hatchery.json)
("**March — Hatchery service**") covers the Hatchery service: heartbeat/uptime,
active spawns, dispatch error rate (`march_hatchery_dispatches_total`), HTTP
request rate + latency percentiles, spawn success rate (shared
`march_spawn_runs_total`), a Loki logs panel
(`{service_name="march-hatchery"}`), and a Tempo traces table.
[`docker/grafana/dashboards/march-legate-loop.json`](../docker/grafana/dashboards/march-legate-loop.json)
("**March — Legate loop service**", uid `march-legate-loop`) monitors the loop
service: liveness (up / last-tick age / heartbeat rate), queue depth
(dispatchable / blocked / total), dispatch activity, workers by state, and
forwarded loop logs (Loki, with trace links). It is filtered by `profile` /
`conductor`, and cross-links the spawn dashboard via its header links.

A third dashboard,
[`docker/grafana/dashboards/march-castra.json`](../docker/grafana/dashboards/march-castra.json)
("**March — Castra sessions host**"), shows the Castra API's RED metrics:
request rate, 5xx error ratio, rate by status class, duration percentiles
(p50/p95/p99), a route × status-class table, and p95 by route — with `profile`
and `route` template variables. All dashboards land in the same **March** folder
(the provider loads every JSON under `/etc/march/dashboards`, so dropping the file
in is all that's needed).

To browse raw traces: **Explore → Tempo**, query
`{ resource.service.name =~ "march.*" }`. Metrics: **Explore → Prometheus**,
e.g. `march_spawn_runs_total` or `march_castra_requests_total`. Logs: **Explore → Loki**,
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
  [`src/legate/loop/runtime.ts`](../src/legate/loop/runtime.ts) that calls
  `emitLoopSpan` ([`src/observability/loop-spans.ts`](../src/observability/loop-spans.ts),
  the OTel SDK tracer) keyed off the slice id. A *new dispatched unit of work* is
  a root span (`root: true`) — it claims `spanIdForDispatch(sliceId)` so the
  orchestrator's spans nest beneath it; a lifecycle action on an existing
  dispatch is a child (`root: false`) under that same deterministic parent.
  Action events flowing through `append` are also forwarded to Loki by
  `maybeEmitLoopLog` — add the kind there too if it should show in the logs panels.
- **New failure mode** → emit an **errored** span (and, where the orchestrator
  runs, the appropriate metric `outcome`) so the failure shows up rather than
  silently vanishing. Recovery and direct-steward dispatches are the worked
  example.
- **A new process joins a trace** → reuse the deterministic id helpers so its
  spans land in the right trace. The loop service emits its spans through the OTel
  SDK ([`src/observability/loop-spans.ts`](../src/observability/loop-spans.ts)),
  reusing [`src/observability/trace-ids.ts`](../src/observability/trace-ids.ts) for
  the trace id and the deterministic parent span id; because the SDK assigns span
  ids itself, the root `legate.dispatch` span pins its id via the
  [`DeterministicIdGenerator`](../src/observability/deterministic-id-generator.ts)
  installed on the tracer provider. The in-container emitter
  ([`src/observability/in-spawn-emitter.ts`](../src/observability/in-spawn-emitter.ts))
  keeps a stand-alone raw-OTLP copy of the id derivation since it ships into a
  no-`node_modules` container without the SDK. Keep them aligned — the
  cross-process test in `init.test.ts` locks this in.
- **New metric or label** → spawn metrics in
  [`src/observability/spawn-metrics.ts`](../src/observability/spawn-metrics.ts);
  Hatchery service metrics in
  [`src/observability/hatchery-metrics.ts`](../src/observability/hatchery-metrics.ts);
  loop heartbeat metrics in
  [`src/observability/loop-metrics.ts`](../src/observability/loop-metrics.ts).
  Keep labels low-cardinality — never add a per-spawn/per-slice id or a concrete
  request path as a label; ids belong in traces, and routes use the template
  form. Then update the dashboard JSON if a panel should use it.
- **New log call** → the Hatchery service uses the pino logger in
  [`src/observability/logger.ts`](../src/observability/logger.ts) (file sink +
  OTLP); the loop uses the OTel logs SDK in
  [`src/observability/logs.ts`](../src/observability/logs.ts). Both stay no-ops
  when `MARCH_OTEL!=1` (the loop still writes its files). Keep log attributes
  low-cardinality.
- **New panel / query** → edit
  [`docker/grafana/dashboards/march-spawns.json`](../docker/grafana/dashboards/march-spawns.json),
  [`docker/grafana/dashboards/march-hatchery.json`](../docker/grafana/dashboards/march-hatchery.json),
  or
  [`docker/grafana/dashboards/march-legate-loop.json`](../docker/grafana/dashboards/march-legate-loop.json).
  Reference datasources by uid (`prometheus`, `tempo`, `loki`). Validate against
  a live stack before committing.

Source of truth for the emitters lives under
[`src/observability/`](../src/observability/); see [AGENTS.md](../AGENTS.md) and
[CONTRIBUTING.md](../CONTRIBUTING.md) for ownership.
