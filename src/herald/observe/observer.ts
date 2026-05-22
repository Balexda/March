import { senseObserved, type SenseDeps } from "../../legate/loop/state/sense.js";
import { startHeraldSpan } from "../../observability/herald-trace.js";
import type { AppendEventInput, HeraldEvent, SystemState } from "../events.js";
import { diffObserved } from "./diff.js";

/** The slice of {@link EventStore} the observer needs. */
export interface ObserveStore {
  projection(): SystemState;
  append(input: AppendEventInput): HeraldEvent;
}

export interface ObserverDeps {
  /** The Stage-1 sense I/O (built via `buildSenseIo` in src/observe/sense-io.ts). */
  readonly senseDeps: SenseDeps;
  readonly store: ObserveStore;
}

export interface ObserveResult {
  /** Observation time (the snapshot ts). */
  observedAt: string;
  /** Wall-clock spent sensing the world. */
  durationMs: number;
  /** The change events appended this tick (empty when nothing changed). */
  appended: HeraldEvent[];
}

/**
 * Run one observation tick: read the current projection, sense the world, diff,
 * and append one event per delta to the log (stamped with the observation ts).
 * The store's hot projection advances as a side effect of each append. Returns
 * the appended events + timing so the server can update `/status` and metrics.
 *
 * Since the cutover (#176) Herald learns which slices to observe from its OWN
 * projection (`prev`, fed by the legate's `slice.dispatched` transition events)
 * rather than reading the legate's `state.json` — {@link senseObserved} takes the
 * projection and reads the live PR/output for each non-terminal slice.
 */
export async function runObservation(deps: ObserverDeps): Promise<ObserveResult> {
  // The tick is internally initiated (no inbound traceparent), so this is a
  // fresh root span — the trace that surfaces march-herald's observation work.
  const span = startHeraldSpan({ name: "herald.observe" });
  try {
    const prev = deps.store.projection();
    const started = Date.now();
    const loop = await senseObserved(deps.senseDeps, prev);
    const durationMs = Date.now() - started;

    const appended: HeraldEvent[] = [];
    for (const body of diffObserved(prev, loop)) {
      appended.push(
        deps.store.append({ source: "herald", ts: loop.ts, ...body } as AppendEventInput),
      );
    }
    span.setAttributes({
      "herald.observe.duration_ms": durationMs,
      "herald.observe.appended": appended.length,
    });
    span.end();
    return { observedAt: loop.ts, durationMs, appended };
  } catch (err) {
    span.end({ error: true });
    throw err;
  }
}
