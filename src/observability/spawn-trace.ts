import {
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
  span<T>(name: string, fn: () => T, attributes?: Attributes): T;
  setAttributes(attributes: Attributes): void;
  recordException(err: unknown): void;
  /** W3C traceparent of the root span, for propagation into the spawn sandbox. */
  traceparent(): string | undefined;
  end(opts?: { error?: boolean }): void;
}

const NOOP_TRACE: DispatchTrace = {
  enabled: false,
  span: (_name, fn) => fn(),
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
