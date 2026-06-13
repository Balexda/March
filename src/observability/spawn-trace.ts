import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
  type Span,
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
 * Handle passed to a `span()`/`spanAsync()` callback so the body can enrich its
 * OWN child span — set attributes discovered mid-run (a patch diff-stat, a git
 * reject) and read the child's `{ traceId, spanId }` to correlate a log line to
 * THIS span (not just the root). Mirrors how {@link withCastraSpan} hands its
 * callback the span context; both are needed because this codebase registers no
 * OTel ContextManager, so a log must attach the ids explicitly. All methods are
 * no-ops when telemetry is disabled.
 */
export interface DispatchSpanHandle {
  setAttributes(attributes: Attributes): void;
  setError(message?: string): void;
  spanContext(): { traceId: string; spanId: string } | undefined;
}

const NOOP_SPAN_HANDLE: DispatchSpanHandle = {
  setAttributes: () => {},
  setError: () => {},
  spanContext: () => undefined,
};

/** Wrap a live child span in the {@link DispatchSpanHandle} the callback sees. */
function childHandle(child: Span): DispatchSpanHandle {
  return {
    setAttributes: (attributes) => child.setAttributes(attributes),
    setError: (message) =>
      child.setStatus({ code: SpanStatusCode.ERROR, message }),
    spanContext: () => {
      const sc = child.spanContext();
      return { traceId: sc.traceId, spanId: sc.spanId };
    },
  };
}

/**
 * A per-dispatch trace whose id is derived deterministically from the dispatch
 * key. `span()` runs a function inside a child span (the lifecycle "actions":
 * spawn.start, spawn.end, steward.apply, ...). No-op when telemetry is disabled.
 */
export interface DispatchTrace {
  readonly enabled: boolean;
  /**
   * The root span's `{ traceId, spanId }`, or `undefined` when telemetry is off.
   * Callers attach these to log records EXPLICITLY (this codebase registers no
   * OTel ContextManager, so `context.with`/`getActiveSpan` can't carry them) so
   * the line correlates to this span — Grafana's "Logs for this span". Mirrors
   * how {@link traceIdForDispatch}/{@link spanIdForDispatch} feed `emitLoopLog`.
   */
  spanContext(): { traceId: string; spanId: string } | undefined;
  span<T>(name: string, fn: (span: DispatchSpanHandle) => T, attributes?: Attributes): T;
  /**
   * Async sibling of {@link span}: brackets a child span around an awaited
   * function (a cross-system seam such as a Castra/Brood HTTP call). The span
   * stays open until the promise settles, recording an exception + ERROR status
   * on rejection. Use this — never `span` — for anything that returns a promise,
   * because `span` would end the child before the work completes.
   */
  spanAsync<T>(
    name: string,
    fn: (span: DispatchSpanHandle) => Promise<T>,
    attributes?: Attributes,
  ): Promise<T>;
  setAttributes(attributes: Attributes): void;
  recordException(err: unknown): void;
  /** W3C traceparent of the root span, for propagation into the spawn sandbox. */
  traceparent(): string | undefined;
  end(opts?: { error?: boolean }): void;
}

const NOOP_TRACE: DispatchTrace = {
  enabled: false,
  spanContext: () => undefined,
  span: (_name, fn) => fn(NOOP_SPAN_HANDLE),
  spanAsync: (_name, fn) => fn(NOOP_SPAN_HANDLE),
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
    spanContext() {
      const sc = root.spanContext();
      return { traceId: sc.traceId, spanId: sc.spanId };
    },
    span<T>(name: string, fn: (span: DispatchSpanHandle) => T, attributes?: Attributes): T {
      const child = tracer.startSpan(name, { attributes }, rootCtx);
      try {
        const result = fn(childHandle(child));
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
      fn: (span: DispatchSpanHandle) => Promise<T>,
      attributes?: Attributes,
    ): Promise<T> {
      const child = tracer.startSpan(name, { attributes }, rootCtx);
      try {
        const result = await fn(childHandle(child));
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
