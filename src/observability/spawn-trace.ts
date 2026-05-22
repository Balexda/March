import {
  context as otelContext,
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
} from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";
import {
  buildTraceparent,
  spanIdForDispatch,
  traceIdForDispatch,
} from "./trace-ids.js";

export interface StartDispatchSpanInput {
  /** Stable dispatch key (slice id, else spawn id) that determines the trace. */
  readonly traceKey: string;
  /** Root span name, e.g. "hatchery.spawn" or "spawn.dispatch". */
  readonly rootName: string;
  readonly attributes?: Attributes;
}

/**
 * A per-dispatch trace whose id is derived deterministically from the dispatch
 * key. `span()` runs a function inside a child span (the lifecycle "actions":
 * spawn.start, spawn.end, steward.apply, ...). No-op when telemetry is disabled.
 */
export interface DispatchTrace {
  readonly enabled: boolean;
  /**
   * Run `fn` with the root span installed as the active span in the OTel
   * context. Logs emitted inside `fn` (e.g. via the service's pino logger, whose
   * mixin reads {@link trace.getActiveSpan}) then carry this span's trace/span
   * ids, so Grafana's "Logs for this span" resolves. No-op passthrough when
   * telemetry is disabled.
   */
  runActive<T>(fn: () => T): T;
  span<T>(name: string, fn: () => T, attributes?: Attributes): T;
  /**
   * Async sibling of {@link span}: brackets a child span around an awaited
   * function (a cross-system seam such as a Castra/Brood HTTP call). The span
   * stays open until the promise settles, recording an exception + ERROR status
   * on rejection. Use this — never `span` — for anything that returns a promise,
   * because `span` would end the child before the work completes.
   */
  spanAsync<T>(name: string, fn: () => Promise<T>, attributes?: Attributes): Promise<T>;
  setAttributes(attributes: Attributes): void;
  recordException(err: unknown): void;
  /** W3C traceparent of the root span, for propagation into the spawn sandbox. */
  traceparent(): string | undefined;
  end(opts?: { error?: boolean }): void;
}

const NOOP_TRACE: DispatchTrace = {
  enabled: false,
  runActive: (fn) => fn(),
  span: (_name, fn) => fn(),
  spanAsync: (_name, fn) => fn(),
  setAttributes: () => {},
  recordException: () => {},
  traceparent: () => undefined,
  end: () => {},
};

export function startDispatchSpan(input: StartDispatchSpanInput): DispatchTrace {
  const otel = getActiveOtel();
  if (!otel.enabled) return NOOP_TRACE;

  const tracer = otel.getTracer();
  const traceId = traceIdForDispatch(input.traceKey);
  const parentSpanId = spanIdForDispatch(input.traceKey);

  // A "remote" parent context forces the deterministic trace id onto the root
  // span (a root span would otherwise get a random trace id). The virtual
  // parent span id is what a future cross-process legate.dispatch span claims.
  const parentCtx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: parentSpanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });

  const root = tracer.startSpan(
    input.rootName,
    { attributes: input.attributes },
    parentCtx,
  );
  const rootCtx = trace.setSpan(parentCtx, root);

  return {
    enabled: true,
    runActive<T>(fn: () => T): T {
      return otelContext.with(rootCtx, fn);
    },
    span<T>(name: string, fn: () => T, attributes?: Attributes): T {
      const child = tracer.startSpan(name, { attributes }, rootCtx);
      try {
        const result = fn();
        child.end();
        return result;
      } catch (err) {
        child.recordException(err as Error);
        child.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error)?.message,
        });
        child.end();
        throw err;
      }
    },
    async spanAsync<T>(
      name: string,
      fn: () => Promise<T>,
      attributes?: Attributes,
    ): Promise<T> {
      const child = tracer.startSpan(name, { attributes }, rootCtx);
      try {
        const result = await fn();
        child.end();
        return result;
      } catch (err) {
        child.recordException(err as Error);
        child.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error)?.message,
        });
        child.end();
        throw err;
      }
    },
    setAttributes(attributes: Attributes) {
      root.setAttributes(attributes);
    },
    recordException(err: unknown) {
      root.recordException(err as Error);
      root.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error)?.message,
      });
    },
    traceparent() {
      const sc = root.spanContext();
      return buildTraceparent(sc.traceId, sc.spanId);
    },
    end(opts?: { error?: boolean }) {
      if (opts?.error) root.setStatus({ code: SpanStatusCode.ERROR });
      root.end();
    },
  };
}
