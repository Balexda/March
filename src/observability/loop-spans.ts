import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
} from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";
import { deterministicIdGenerator } from "./deterministic-id-generator.js";
import { spanIdForDispatch, traceIdForDispatch } from "./trace-ids.js";

/**
 * Dispatch-lifecycle spans for the Legate loop service, emitted via the OTel SDK
 * tracer (no raw OTLP). Each dispatched unit of work is its own trace whose id
 * is hashed deterministically from the slice id ({@link traceIdForDispatch}), so
 * these loop spans share a trace with the orchestrator's `hatchery.spawn` /
 * `spawn.*` spans even though they're emitted by separate processes with no
 * shared in-memory context.
 *
 * `legate.dispatch` is the trace's **root**: it claims the deterministic span id
 * ({@link spanIdForDispatch}) so the orchestrator spans (which set that id as
 * their parent) nest beneath it. The non-dispatch lifecycle actions
 * (`legate.babysit` / `legate.cleanup` / `legate.relaunch` /
 * `legate.ghost-cleanup`) nest as children of that same deterministic parent —
 * and the runtime gives their downstream brood.teardown / castra.send the same
 * deterministic trace context (#234) so those join the trace too rather than
 * orphaning a root. (`legate.ghost-cleanup` keys off the session id since a ghost
 * steward belongs to no slice.) No-op when telemetry is disabled.
 */

export interface LoopSpanInput {
  /**
   * Span name: "legate.dispatch" | "legate.babysit" | "legate.cleanup" |
   * "legate.relaunch" | "legate.ghost-cleanup".
   */
  readonly name: string;
  /**
   * Key that determines the trace + deterministic ids — the slice id for
   * slice-scoped actions, the session id for ghost-cleanup (no slice).
   */
  readonly traceKey: string;
  /**
   * `true` for a `legate.dispatch` root span (claims `spanIdForDispatch` so
   * orchestrator spans nest under it); `false` for a lifecycle child span that
   * nests under that deterministic parent.
   */
  readonly root: boolean;
  /** Marks the span errored (status ERROR) — e.g. a dispatch whose launch threw. */
  readonly error?: boolean;
  /** Low-cardinality span attributes (slice id, action, dispatch mode, ...). */
  readonly attributes?: Attributes;
}

let defaults: { profile: string } = { profile: "unknown" };

/** Set the deployment profile stamped on every loop span. Call once at startup. */
export function initLoopSpans(d: { profile: string }): void {
  defaults = { profile: d.profile || "unknown" };
}

export function emitLoopSpan(input: LoopSpanInput): void {
  const otel = getActiveOtel();
  if (!otel.enabled || !input.traceKey) return;

  // Every loop span carries the deployment profile (set at `march legate init`,
  // also what places agent-deck sessions) so test/integ telemetry can be
  // filtered out of a real deployment's traces.
  const attributes: Attributes = {
    "march.profile": defaults.profile,
    ...(input.attributes ?? {}),
  };

  const tracer = otel.getTracer();
  const traceId = traceIdForDispatch(input.traceKey);
  const parentSpanId = spanIdForDispatch(input.traceKey);

  // A root span gets a random span id from the SDK by default, but the dispatch
  // root must own `parentSpanId` exactly. Force it onto the parentless root via
  // the deterministic id generator. Lifecycle children instead inherit the
  // trace id and point at that deterministic parent through a remote context.
  const span = input.root
    ? deterministicIdGenerator.withForcedIds(traceId, parentSpanId, () =>
        tracer.startSpan(input.name, { root: true, attributes }),
      )
    : tracer.startSpan(
        input.name,
        { attributes },
        trace.setSpanContext(ROOT_CONTEXT, {
          traceId,
          spanId: parentSpanId,
          traceFlags: TraceFlags.SAMPLED,
          isRemote: true,
        }),
      );

  span.setStatus({ code: input.error ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  span.end();
}
