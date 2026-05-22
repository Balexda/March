import { senseObserved, type SenseDeps } from "../../legate/loop/state/sense.js";
import { startHeraldSpan } from "../../observability/herald-trace.js";
import type { Attributes } from "@opentelemetry/api";
import type { AppendEventInput, EventBody, HeraldEvent, SystemState } from "../events.js";
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

/** A semantic span describing one observed state change. */
export interface ChangeSpan {
  /** Low-cardinality span name, e.g. `"herald.pr.merged"`. */
  readonly name: string;
  /**
   * The slice id when the change is slice-scoped — the span nests as a child of
   * that slice's dispatch trace so it joins `legate.dispatch → hatchery.spawn`
   * for a unified per-slice debug view. Undefined for system-wide changes
   * (workers/queue/session), which stand alone.
   */
  readonly dispatchKey?: string;
  readonly attributes: Attributes;
}

function prUpper(pr: unknown): string | undefined {
  const state = (pr as { state?: unknown } | undefined)?.state;
  return typeof state === "string" ? state.toUpperCase() : undefined;
}

/**
 * Map a diff'd change body to a semantic span — named for *what changed* (so a
 * Tempo timeline reads "pr.opened → pr.merged", not eight identical "observe"
 * lines). Slice-scoped changes carry `dispatchKey` so they nest in the slice's
 * dispatch trace. Returns undefined for bodies that should not be spanned.
 *
 * `prev` is the projection BEFORE this tick's appends, so the PR state
 * transition (none/open → merged/closed) can be resolved for the span name.
 */
export function describeChangeSpan(
  prev: SystemState,
  body: EventBody,
): ChangeSpan | undefined {
  switch (body.type) {
    case "slice.pr.changed": {
      const pr = body.pr as { number?: number } | undefined;
      const newState = prUpper(body.pr);
      const priorState = prUpper(prev.slices[body.sliceId]?.pr);
      let name = "herald.pr.changed";
      if (newState === "MERGED") name = "herald.pr.merged";
      else if (newState === "CLOSED") name = "herald.pr.closed";
      else if (newState === "OPEN" && priorState !== "OPEN") name = "herald.pr.opened";
      const attributes: Attributes = { "march.slice_id": body.sliceId };
      if (typeof pr?.number === "number") attributes["march.pr_number"] = pr.number;
      if (newState) attributes["march.pr_state"] = newState;
      return { name, dispatchKey: body.sliceId, attributes };
    }
    case "slice.output.changed":
      return {
        name: "herald.output.changed",
        dispatchKey: body.sliceId,
        attributes: {
          "march.slice_id": body.sliceId,
          "march.output_error": Boolean(body.recentOutput?.error),
        },
      };
    case "session.changed":
      return {
        name: "herald.session.changed",
        attributes: {
          "march.session_id": body.session.id,
          "march.session_present": body.session.present,
          ...(body.session.status ? { "march.session_status": body.session.status } : {}),
        },
      };
    case "workers.changed":
      return {
        name: "herald.workers.changed",
        attributes: {
          "march.workers_running": body.workers.running,
          "march.workers_idle": body.workers.idle,
          "march.workers_error": body.workers.error,
        },
      };
    case "smithy.queue.changed":
      return {
        name: "herald.queue.changed",
        attributes: {
          "march.queue_dispatchable": body.dispatchable,
          "march.queue_blocked": body.blocked,
          "march.queue_total": body.total,
        },
      };
    default:
      // heartbeat / state.* are not emitted by the observer; nothing to span.
      return undefined;
  }
}

/**
 * Run one observation tick: read the current projection, sense the world, diff,
 * and append one event per delta to the log (stamped with the observation ts).
 * The store's hot projection advances as a side effect of each append. Returns
 * the appended events + timing so the server can update `/status` and metrics.
 *
 * Telemetry-wise this tick emits a span PER state change (not per tick), named
 * for what changed (`herald.pr.merged`, …). Slice-scoped changes nest in the
 * slice's dispatch trace so a "stuck task" investigation reads as one trace
 * across legate/hatchery/herald. A quiet tick emits nothing; a failed tick emits
 * one errored `herald.observe.failed`. All no-ops when telemetry is disabled.
 *
 * Since the cutover (#176) Herald learns which slices to observe from its OWN
 * projection (`prev`, fed by the legate's `slice.dispatched` transition events)
 * rather than reading the legate's `state.json` — {@link senseObserved} takes the
 * projection and reads the live PR/output for each non-terminal slice.
 */
export async function runObservation(deps: ObserverDeps): Promise<ObserveResult> {
  const prev = deps.store.projection();
  const started = Date.now();
  try {
    const loop = await senseObserved(deps.senseDeps, prev);
    const senseEndMs = Date.now();
    const durationMs = senseEndMs - started;

    const bodies = diffObserved(prev, loop);
    // Resolve span descriptors from the pristine `prev` BEFORE the append loop
    // mutates the hot projection (so PR-state transitions read correctly).
    const spans = bodies.map((body) => describeChangeSpan(prev, body));

    const appended: HeraldEvent[] = [];
    bodies.forEach((body, i) => {
      appended.push(
        deps.store.append({ source: "herald", ts: loop.ts, ...body } as AppendEventInput),
      );
      const change = spans[i];
      if (change) {
        startHeraldSpan({
          name: change.name,
          dispatchKey: change.dispatchKey,
          attributes: change.attributes,
          startTimeMs: started,
        }).end({ endTimeMs: senseEndMs });
      }
    });
    return { observedAt: loop.ts, durationMs, appended };
  } catch (err) {
    startHeraldSpan({ name: "herald.observe.failed", startTimeMs: started }).end({
      error: true,
    });
    throw err;
  }
}
