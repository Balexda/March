import {
  RandomIdGenerator,
  type IdGenerator,
} from "@opentelemetry/sdk-trace-base";

/**
 * An {@link IdGenerator} that can pin the trace/span id of the *next* span the
 * SDK creates, falling back to random ids otherwise.
 *
 * The OTel SDK assigns span ids through the tracer provider's id generator with
 * no per-`startSpan` override. The Legate loop's `legate.dispatch` span,
 * however, must claim a *specific* deterministic span id
 * (`spanIdForDispatch(sliceId)`) so that the orchestrator's `hatchery.spawn` /
 * `spawn.*` spans — emitted from a different process with no shared in-memory
 * context — nest beneath it on the same trace (see
 * [`trace-ids.ts`](./trace-ids.ts)). Installing this generator on the tracer
 * provider lets {@link withForcedIds} force exactly that one root span's ids
 * while every other span (the random-id children, anyone else's spans in the
 * process) keeps the default random behaviour.
 *
 * It is a process-wide singleton ({@link deterministicIdGenerator}) wired into
 * the provider in [`otel.ts`](./otel.ts). Forcing is opt-in and scoped to a
 * synchronous callback, so processes that never call {@link withForcedIds}
 * (the orchestrator, Castra, the CLI) behave exactly like the stock
 * {@link RandomIdGenerator}.
 */
export class DeterministicIdGenerator implements IdGenerator {
  private readonly random = new RandomIdGenerator();
  private nextTraceId: string | undefined;
  private nextSpanId: string | undefined;

  generateTraceId = (): string => {
    if (this.nextTraceId !== undefined) {
      const id = this.nextTraceId;
      this.nextTraceId = undefined;
      return id;
    }
    return this.random.generateTraceId();
  };

  generateSpanId = (): string => {
    if (this.nextSpanId !== undefined) {
      const id = this.nextSpanId;
      this.nextSpanId = undefined;
      return id;
    }
    return this.random.generateSpanId();
  };

  /**
   * Pin the trace id and span id for the span(s) created inside `fn`, then
   * restore random generation. `fn` must create exactly one span synchronously
   * (the SDK consumes both ids during `tracer.startSpan`); the JS event loop is
   * single-threaded so no other span creation can interleave. The pinned ids
   * are always cleared afterwards so a throwing or no-op `fn` can't leak them
   * onto the next span.
   */
  withForcedIds<T>(traceId: string, spanId: string, fn: () => T): T {
    this.nextTraceId = traceId;
    this.nextSpanId = spanId;
    try {
      return fn();
    } finally {
      this.nextTraceId = undefined;
      this.nextSpanId = undefined;
    }
  }
}

/** Process-wide generator installed on the tracer provider by `initOtel`. */
export const deterministicIdGenerator = new DeterministicIdGenerator();
