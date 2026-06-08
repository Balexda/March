import { senseObserved, type SenseDeps } from "../../legate/loop/state/sense.js";
import { startHeraldSpan } from "../../observability/herald-trace.js";
import { recordHeraldSync } from "../../observability/herald-metrics.js";
import type { Attributes } from "@opentelemetry/api";
import type { AppendEventInput, EventBody, HeraldEvent, SystemState } from "../events.js";
import { diffObserved } from "./diff.js";

/** The slice of {@link EventStore} the observer needs. */
export interface ObserveStore {
  projectionFor(profile: string): SystemState;
  append(input: AppendEventInput): HeraldEvent;
}

export interface ObserverDeps {
  /** The Stage-1 sense I/O (built via `buildSenseIo` in src/observe/sense-io.ts).
   *  Built PER profile by the server, from that profile's registry record. */
  readonly senseDeps: SenseDeps;
  readonly store: ObserveStore;
  /** The profile being observed this tick — events are stamped with it and the
   *  `prev` projection is read from its bucket. */
  readonly profile: string;
  /**
   * Default-branch git sync for this profile (#300). Herald owns the sync, so it
   * fetches + fast-forwards origin's default branch BEFORE reading `smithy status`
   * — that is what makes freshly-merged work (e.g. a merged cut's `tasks.md`)
   * surface in the next observation. Wired by the server ONLY when Herald is in
   * sync mode (`MARCH_HERALD_SYNC=1`); `undefined` in read-only mode, where the
   * observation runs against the local checkout as-is. A failure is logged +
   * isolated (never fatal to the tick) so one diverged/offline repo can't stall
   * the others.
   */
  readonly syncDefaultBranch?: (repoPath: string, knownDefault?: string) => Promise<void>;
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
/**
 * Run this profile's default-branch sync before the observation read (#300),
 * when Herald is in sync mode (`deps.syncDefaultBranch` wired). The sync is
 * best-effort: a failure (no GitHub auth, gh outage, diverged local that won't
 * fast-forward) is swallowed so the tick still observes the local checkout, and
 * one repo's sync failure can't stall the profile or block the others. No-op when
 * sync is disabled or the repo path is unknown.
 *
 * A failure is made LOUD on every channel (#301 live-validation: the original
 * silence is exactly how the bug hid). It hits (1) the structured warn log
 * (`herald.jsonl` + OTLP), (2) the `march.herald.sync{outcome="error"}` metric
 * (queryable in Grafana), and (3) the process stderr so `docker logs march-herald`
 * surfaces it — because the service's pino logger writes only to a file/OTLP, not
 * the container's stdout/stderr. A success records `outcome="ok"` so a working
 * sync is visible too.
 */
async function syncDefaultBranchBeforeObserve(deps: ObserverDeps): Promise<void> {
  if (!deps.syncDefaultBranch) return;
  const repoPath = deps.senseDeps.meta.repo?.path;
  if (typeof repoPath !== "string" || repoPath.length === 0) return;
  try {
    await deps.syncDefaultBranch(repoPath);
    recordHeraldSync("ok");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `default-branch sync failed for ${deps.profile}: ${detail} — observing against stale local repo`;
    deps.senseDeps.warn?.(message);
    recordHeraldSync("error");
    // Bypass the file-only pino logger so the failure is visible in `docker logs`.
    process.stderr.write(`[herald] ${message}\n`);
  }
}

export async function runObservation(deps: ObserverDeps): Promise<ObserveResult> {
  const prev = deps.store.projectionFor(deps.profile);
  // Herald owns the default-branch sync (#300): pull origin's default branch
  // BEFORE the read so a freshly auto-merged cut's `tasks.md` surfaces in this
  // tick's `smithy status` (rather than drifting behind until an operator pulls).
  // Wired only in sync mode; a sync failure is logged + isolated so it can never
  // stall the observation or the other profiles' ticks.
  await syncDefaultBranchBeforeObserve(deps);
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
        deps.store.append({ source: "herald", ts: loop.ts, profile: deps.profile, ...body } as AppendEventInput),
      );
      const change = spans[i];
      if (change) {
        startHeraldSpan({
          name: change.name,
          dispatchKey: change.dispatchKey,
          // `march.profile` is a span ATTRIBUTE (cardinality-tolerant), never a
          // metric label — keeps the low-cardinality metric contract intact.
          attributes: { ...change.attributes, "march.profile": deps.profile },
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
