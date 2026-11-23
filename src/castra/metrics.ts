import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";
import { getActiveOtel } from "../observability/otel.js";
import { REQUEST_LATENCY_BUCKETS_SECONDS } from "../observability/histogram-buckets.js";
import { startDispatchSpan } from "../observability/spawn-trace.js";

/**
 * Castra request telemetry. Metrics use only low-cardinality labels (route
 * pattern, method, status class, profile, outcome) — never session ids, paths,
 * or prompt content, which belong in spans/logs. All no-ops when telemetry is
 * disabled (MARCH_OTEL!=1), mirroring `spawn-metrics.ts`.
 */

export interface RecordCastraRequestInput {
  /** The matched route pattern (e.g. "/v1/sessions/:id"), NOT the raw URL. */
  readonly route: string;
  readonly method: string;
  /** "2xx" | "4xx" | "5xx" — the response status class. */
  readonly statusClass: string;
  /** The agent-deck profile the request targeted, or "unknown". */
  readonly profile: string;
  /** "success" for <500, "failure" otherwise. */
  readonly outcome: "success" | "failure";
  readonly durationSeconds: number;
}

/** How often `startCastraHeartbeat` ticks the liveness counter. */
const HEARTBEAT_INTERVAL_MS = 15000;

// OTel expects each instrument created once and reused; cache keyed by Meter so
// a fresh initOtel (e.g. between tests) rebuilds against the new provider.
let cachedMeter: Meter | undefined;
let requestsCounter: Counter | undefined;
let durationHistogram: Histogram | undefined;
let heartbeatCounter: Counter | undefined;
let sendsCounter: Counter | undefined;
let trustDialogsCounter: Counter | undefined;

interface CastraInstruments {
  counter: Counter;
  histogram: Histogram;
  heartbeat: Counter;
  sends: Counter;
  trustDialogs: Counter;
}

/** What the readiness gauges observe; set by the server, read at collection. */
export interface CastraReadinessGaugeSource {
  eventLoopLagMs(): number;
  refusedSessions(): number;
}

let readinessSource: CastraReadinessGaugeSource | undefined;

/**
 * Point the `march.castra.event_loop_lag_ms` / `march.castra.refused_sessions`
 * gauges at the server's live state. Returns an unregister function.
 */
export function setCastraReadinessSource(source: CastraReadinessGaugeSource): () => void {
  readinessSource = source;
  return () => {
    if (readinessSource === source) readinessSource = undefined;
  };
}

function castraInstruments(meter: Meter): CastraInstruments {
  if (meter !== cachedMeter) {
    cachedMeter = meter;
    requestsCounter = meter.createCounter("march.castra.requests", {
      description: "Count of Castra API requests by route and outcome",
      unit: "1",
    });
    durationHistogram = meter.createHistogram("march.castra.request.duration", {
      description: "Castra API request wall-clock duration",
      unit: "s",
      advice: { explicitBucketBoundaries: REQUEST_LATENCY_BUCKETS_SECONDS },
    });
    heartbeatCounter = meter.createCounter("march.castra.heartbeat", {
      description: "Liveness heartbeat ticks emitted by the castra service",
      unit: "1",
    });
    // Uptime as an observable gauge — registered once per meter alongside the
    // other instruments so a fresh provider re-attaches the callback.
    meter
      .createObservableGauge("march.castra.uptime", {
        description: "Castra service process uptime",
        unit: "s",
      })
      .addCallback((result) => result.observe(process.uptime()));
    // No unit on the readiness instruments, so the Prometheus names are exactly
    // march_castra_sends_total / _trust_dialogs_total / _event_loop_lag_ms /
    // _refused_sessions.
    sendsCounter = meter.createCounter("march.castra.sends", {
      description: "Castra session sends by outcome (delivered/refused/refused_cached/not_found/failed)",
    });
    trustDialogsCounter = meter.createCounter("march.castra.trust_dialogs", {
      description: "Claude directory-trust dialogs Castra found, by outcome",
    });
    meter
      .createObservableGauge("march.castra.event_loop_lag_ms", {
        description: "Castra event-loop lag p99 over the last minute, in milliseconds",
      })
      .addCallback((result) => {
        if (readinessSource) result.observe(readinessSource.eventLoopLagMs());
      });
    meter
      .createObservableGauge("march.castra.refused_sessions", {
        description: "Sessions Castra is fast-failing sends to after a composer refusal",
      })
      .addCallback((result) => {
        if (readinessSource) result.observe(readinessSource.refusedSessions());
      });
  }
  return {
    counter: requestsCounter!,
    histogram: durationHistogram!,
    heartbeat: heartbeatCounter!,
    sends: sendsCounter!,
    trustDialogs: trustDialogsCounter!,
  };
}

/** Count one send by `outcome` (a {@link SendOutcome}) and profile. */
export function recordCastraSend(input: { profile: string; outcome: string }): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  castraInstruments(otel.getMeter()).sends.add(1, {
    profile: input.profile,
    outcome: input.outcome,
  });
}

/**
 * Register the Castra instruments (including the readiness gauges) without
 * recording anything, so the gauges export before the first request.
 */
export function registerCastraInstruments(): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  castraInstruments(otel.getMeter());
}

export interface TrustDialogSpanInput {
  readonly traceKey: string;
  readonly profile: string;
  readonly sessionId: string;
  /** What found the dialog: a refused send, or the recovery sweep. */
  readonly trigger: "send_refusal" | "recover";
  readonly outcome: "resolved" | "not_owned" | "failed";
  readonly dir: string;
  readonly detail?: string;
  readonly sliceId?: string;
}

/**
 * Emit a `castra.trust_dialog` span and count it. `not_owned` and `failed` are
 * errored spans: both leave a steward unable to take prompts. Returns the span
 * ids for explicit log correlation.
 */
export function recordTrustDialog(input: TrustDialogSpanInput): CastraSpanContext | undefined {
  const otel = getActiveOtel();
  if (otel.enabled) {
    castraInstruments(otel.getMeter()).trustDialogs.add(1, {
      profile: input.profile,
      outcome: input.outcome,
      trigger: input.trigger,
    });
  }
  const dispatch = startDispatchSpan({
    traceKey: input.traceKey,
    rootName: "castra.trust_dialog",
    attributes: {
      "march.profile": input.profile,
      "castra.session_id": input.sessionId,
      "castra.trust_trigger": input.trigger,
      "castra.trust_outcome": input.outcome,
      "castra.trust_dir": input.dir,
      ...(input.detail ? { "castra.trust_detail": input.detail } : {}),
      ...(input.sliceId ? { "march.slice_id": input.sliceId } : {}),
    },
  });
  const ctx = dispatch.spanContext();
  if (input.outcome === "resolved") {
    dispatch.end();
  } else {
    dispatch.recordException(
      new Error(
        input.outcome === "not_owned"
          ? `directory-trust dialog for ${input.dir} is not Castra's steward directory; left for the operator`
          : `could not answer the directory-trust dialog for ${input.dir}: ${input.detail ?? "unknown"}`,
      ),
    );
    dispatch.end({ error: true });
  }
  return ctx;
}

export function recordCastraRequest(input: RecordCastraRequestInput): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;

  const { counter, histogram } = castraInstruments(otel.getMeter());
  const attributes: Attributes = {
    route: input.route,
    method: input.method,
    status_class: input.statusClass,
    profile: input.profile,
    outcome: input.outcome,
  };
  counter.add(1, attributes);
  histogram.record(input.durationSeconds, attributes);
}

/**
 * Start the periodic liveness heartbeat (and register the uptime gauge).
 * Returns a stop function. No-op (returns a no-op stopper) when telemetry is
 * disabled. The interval is unref'd so it never keeps the process alive.
 * Mirrors `startHeartbeat`/`startBroodHeartbeat`.
 */
export function startCastraHeartbeat(
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  const otel = getActiveOtel();
  if (!otel.enabled) return () => {};
  const { heartbeat } = castraInstruments(otel.getMeter());
  heartbeat.add(1); // tick immediately so liveness is visible before the first interval
  const timer = setInterval(() => heartbeat.add(1), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Map an HTTP status code to its status class label. */
export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export interface CastraSpanInput {
  /** Operation suffix; the span is named `castra.<op>` (e.g. "launch"). */
  readonly op: string;
  /**
   * Trace key — the dispatch slice id when the caller supplied one (so Castra
   * spans nest under the existing per-dispatch trace), else a per-request key.
   */
  readonly traceKey: string;
  readonly attributes?: Attributes;
}

/** The `castra.<op>` span's trace ids, for explicit log correlation. */
export interface CastraSpanContext {
  readonly traceId: string;
  readonly spanId: string;
}

/**
 * Run a mutating operation inside a `castra.<op>` span. No-op (just runs `fn`)
 * when telemetry is disabled. Records the exception and marks the span errored
 * if `fn` throws, so failures surface in traces rather than vanishing.
 *
 * `fn` receives the span's `{ traceId, spanId }` (or `undefined` when telemetry
 * is off). The handler attaches them to its log line EXPLICITLY — this codebase
 * registers no OTel ContextManager, so `getActiveSpan` (and thus the pino
 * traceMixin) can't pick them up; explicit attach is what makes Grafana's "Logs
 * for this span" resolve, mirroring `emitLoopLog`.
 */
export function withCastraSpan<T>(
  input: CastraSpanInput,
  fn: (span: CastraSpanContext | undefined) => T,
): T {
  const dispatch = startDispatchSpan({
    traceKey: input.traceKey,
    rootName: `castra.${input.op}`,
    attributes: input.attributes,
  });
  try {
    const result = fn(dispatch.spanContext());
    dispatch.end();
    return result;
  } catch (err) {
    dispatch.recordException(err);
    dispatch.end({ error: true });
    throw err;
  }
}

/**
 * Async sibling of {@link withCastraSpan}: the span stays open until `fn`'s
 * promise settles and is marked errored on rejection. Every Castra operation
 * that runs a child process is async, so the routes use this one.
 */
export async function withCastraSpanAsync<T>(
  input: CastraSpanInput,
  fn: (span: CastraSpanContext | undefined) => Promise<T>,
): Promise<T> {
  const dispatch = startDispatchSpan({
    traceKey: input.traceKey,
    rootName: `castra.${input.op}`,
    attributes: input.attributes,
  });
  try {
    const result = await fn(dispatch.spanContext());
    dispatch.end();
    return result;
  } catch (err) {
    dispatch.recordException(err);
    dispatch.end({ error: true });
    throw err;
  }
}
