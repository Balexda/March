### Services + ports

This variant is generated for the **{{CONTEXT}}** execution context:
{{ADDRESSING}}. Every programmatic base URL below is baked for that context and
can be overridden with the matching `MARCH_*_URL` env var (an explicit value
always wins). Grafana is a browser endpoint you open from the host, so it stays
on `localhost` regardless of context.

| Service | URL | Notes |
|---|---|---|
| otel-lgtm (Grafana) | http://localhost:3000 | dashboards: `march-legate`, `march-herald`, `march-hatchery` (browser, from the host) |
| OTel collector (OTLP HTTP) | http://localhost:4318 | where services ship traces/metrics/logs; read them via Grafana above |
| Castra | {{{CASTRA_BASE}}} | interactive-session host; `/v1/sessions` carries `branch` (#264) |
| Hatchery | {{{HATCHERY_BASE}}} | spawn flow |
| Brood | {{{BROOD_BASE}}} | session-state + teardown authority |
| Herald | {{{HERALD_BASE}}} | event log + fold projection |
| Legate loop | {{{LEGATE_BASE}}} | the deterministic two-stage tick, one shared container, N profiles |
{{#if IS_CONTAINER}}
> Running **inside the Castra container**: reach sibling services by the docker
> service hostnames above, never `localhost` (that is the container's own
> loopback). `column`/`python3` are absent here — the scripts degrade to `jq`
> and plain output. Open Grafana from the **host** browser at `http://localhost:3000`.
{{/if}}
