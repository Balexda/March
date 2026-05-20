# CLAUDE.md

Claude Code reads this file as repo guidance. **[`AGENTS.md`](AGENTS.md) is the
canonical agent guide** — source ownership, working rules, and verification all
live there; keep edits in one place to avoid drift.

Quick pointers:

- **Why March is shaped this way:** [`docs/vision.md`](docs/vision.md) and
  [`docs/operating-philosophy.md`](docs/operating-philosophy.md). Read before
  proposing new components or non-trivial behavior changes.
- **Contributor setup, testing strategy, release checklist:**
  [`CONTRIBUTING.md`](CONTRIBUTING.md).
- **Observability (OpenTelemetry → `otel-lgtm`):**
  [`docs/Observability.md`](docs/Observability.md). Telemetry is opt-in
  (`MARCH_OTEL=1`) and a no-op when off. **Keep it in lock-step with the dispatch
  machinery** — new dispatch path or lifecycle action → emit a span; new failure
  mode → emit an *errored* span; a new process joining a trace → reuse the
  deterministic id helpers kept identical across `src/observability/trace-ids.ts`,
  `src/legate/init.ts`, and `src/observability/in-spawn-emitter.ts`; new
  metrics/labels (low-cardinality only) → `src/observability/spawn-metrics.ts`
  plus the dashboards under `docker/grafana/`.

## Verification

```bash
npm run typecheck
npm run build
npm test
```

Use `npm run` scripts — do not invoke `npx vitest`, `npx tsup`, or ad hoc
equivalents.
