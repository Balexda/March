---
applyTo: "src/observability/**,docker/grafana/**,docker/otel-lgtm.docker-compose.yml"
excludeAgent: "coding-agent"
---
# Reviewing March telemetry

Telemetry is opt-in (`MARCH_OTEL=1`) and must be a complete no-op when off. A
down collector never fails a command. The guide is `docs/Observability.md`.

## Check

- **One slice, one trace.** The trace id is derived from the slice id. The
  deterministic id helpers are kept byte-for-byte identical across
  `src/observability/trace-ids.ts`, `src/legate/init.ts`, and
  `src/observability/in-spawn-emitter.ts`. A change to one without the other
  two splits a trace.
- **Children, not roots.** Herald (`herald-trace.ts`), Brood
  (`brood-trace.ts`), and Castra (via the `x-march-slice-id` header) attach
  their spans under the slice's trace. Only `legate.dispatch` is a root.
- **Errored spans carry the failure.** A failure path ends its span with an
  error status and the correct failure stage, so the trace shows where the
  slice stalled.
- **Low-cardinality labels only.** No slice, spawn, or session ids and no
  concrete request paths as metric labels. Request logs are bounded and do
  not record raw URLs.
- **Metrics live in their module.** Spawns in `spawn-metrics.ts`, the
  Hatchery service in `hatchery-metrics.ts`, Herald in `herald-metrics.ts`,
  and so on. Instruments are created once and cached, not per call.
- **Units match the name.** Set the unit so the Prometheus suffix comes out
  right (`_seconds`, not milliseconds behind a seconds name).
- **Dashboards follow the metrics.** A renamed or new metric updates the
  panels under `docker/grafana/dashboards/`. Read each changed PromQL or
  LogQL expression against the metric's real name, suffix, and labels.
- **Logs go through the pino logger** in `logger.ts`, not `console`.

## Do not ask for

- Telemetry that is on by default, or a hard dependency on the collector.
- Exposing the OTLP or Grafana ports on a public interface.
