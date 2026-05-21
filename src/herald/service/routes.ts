import type { FastifyInstance } from "fastify";
import { isFinderAvailable, isOnPath } from "../../shared/deps.js";
import {
  outcomeFromStatus,
  recordHeraldRequest,
} from "../../observability/herald-metrics.js";
import { createCastraClientFromEnv } from "../../castra/client.js";
import type { EventStore } from "./store.js";
import type { AppendEventInput, EventType } from "../events.js";

/** Snapshot of the server's last observe tick, surfaced on `/status`. */
export interface ObserveStatus {
  /** Epoch ms of the last completed observe tick (null before the first). */
  readonly lastObserveAtMs: number | null;
  /** Wall-clock ms of the last observe tick. */
  readonly lastObserveDurationMs: number | null;
}

export interface RoutesOptions {
  readonly store: EventStore;
  /** Returns the latest observe-status snapshot (server-owned, in-memory). */
  readonly getObserveStatus?: () => ObserveStatus;
}

const DEFAULT_EVENTS_LIMIT = 100;
const MAX_EVENTS_LIMIT = 1000;

const EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "heartbeat",
  "state.error",
  "slice.pr.changed",
  "slice.output.changed",
  "session.changed",
  "workers.changed",
  "smithy.queue.changed",
  "slice.dispatched",
  "slice.stage.changed",
  "slice.archived",
  "slice.recovery.dispatched",
  "steward.relaunched",
  "slice.escalated",
  "retry.counted",
]);

/** Slice-keyed event types that require a non-empty `sliceId`. */
const SLICE_TYPES: ReadonlySet<string> = new Set([
  "slice.pr.changed",
  "slice.output.changed",
  "slice.dispatched",
  "slice.stage.changed",
  "slice.archived",
  "slice.recovery.dispatched",
  "steward.relaunched",
  "slice.escalated",
]);

/** Parse a non-negative integer query param; returns `fallback` when absent. */
function parseNonNegInt(raw: unknown, fallback: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export type EventValidation =
  | { readonly ok: true; readonly input: AppendEventInput }
  | { readonly ok: false; readonly error: string };

/**
 * Validate a `POST /events` body against the shared taxonomy. Only the `source`
 * + a known `type` (+ its required key) are enforced; the rest of the body is
 * carried through as the event payload.
 */
export function validateEvent(body: Record<string, unknown>): EventValidation {
  const type = body.type;
  if (typeof type !== "string" || !EVENT_TYPES.has(type as EventType)) {
    return { ok: false, error: `unknown event type "${String(type)}".` };
  }
  const source = body.source === "herald" || body.source === "legate" ? body.source : "legate";
  if (SLICE_TYPES.has(type) && (typeof body.sliceId !== "string" || body.sliceId.length === 0)) {
    return { ok: false, error: `event "${type}" requires a non-empty sliceId.` };
  }
  if (type === "session.changed") {
    const session = body.session as { id?: unknown } | undefined;
    if (!session || typeof session.id !== "string" || session.id.length === 0) {
      return { ok: false, error: `event "session.changed" requires session.id.` };
    }
  }
  return { ok: true, input: { ...(body as object), source } as AppendEventInput };
}

export async function registerRoutes(
  app: FastifyInstance,
  opts: RoutesOptions,
): Promise<void> {
  const { store } = opts;
  const getObserveStatus =
    opts.getObserveStatus ??
    (() => ({ lastObserveAtMs: null, lastObserveDurationMs: null }));

  // Record every request keyed by route TEMPLATE (not the concrete path) to
  // keep metric cardinality bounded — the same rule the other services use.
  app.addHook("onResponse", async (request, reply) => {
    recordHeraldRequest({
      route: request.routeOptions.url ?? "unknown",
      method: request.method,
      outcome: outcomeFromStatus(reply.statusCode),
      durationSeconds: reply.elapsedTime / 1000,
    });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    const finder = isFinderAvailable();
    // Herald needs git + gh + smithy on PATH to observe the world; Castra
    // (sessions/output) is probed best-effort and does not gate readiness.
    const git = finder && isOnPath("git");
    const gh = finder && isOnPath("gh");
    const smithy = finder && isOnPath("smithy");
    const castra = await createCastraClientFromEnv().reachable();
    const ready = git && gh && smithy;
    reply.code(ready ? 200 : 503);
    return { ready, git, gh, smithy, castra };
  });

  // The inbox: events strictly after a cursor. The legate drains this.
  app.get("/events", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const after = parseNonNegInt(query.after, 0);
    if (after === null) {
      reply.code(400);
      return { error: "after must be a non-negative integer." };
    }
    let limit = parseNonNegInt(query.limit, DEFAULT_EVENTS_LIMIT);
    if (limit === null || limit === 0) {
      reply.code(400);
      return { error: "limit must be a positive integer." };
    }
    if (limit > MAX_EVENTS_LIMIT) limit = MAX_EVENTS_LIMIT;
    const events = store.readAfter(after, limit);
    const lastSeq = events.length > 0 ? events[events.length - 1].seq : after;
    return { events, lastSeq };
  });

  // The legate's write path (PR2): append a transition event; Herald assigns seq.
  app.post("/events", async (request, reply) => {
    const validation = validateEvent((request.body ?? {}) as Record<string, unknown>);
    if (!validation.ok) {
      reply.code(400);
      return { error: validation.error };
    }
    const event = store.append(validation.input);
    reply.code(201);
    return event;
  });

  // The current projection (fold of the whole log), or as-of a `seq`.
  app.get("/state", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    if (query.at !== undefined && query.at !== "") {
      const at = parseNonNegInt(query.at, 0);
      if (at === null) {
        reply.code(400);
        return { error: "at must be a non-negative integer." };
      }
      return store.stateAt(at);
    }
    return store.projection();
  });

  // The events that moved state from `from` to `to` (default `to` = latest).
  app.get("/state/delta", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const from = parseNonNegInt(query.from, 0);
    if (from === null) {
      reply.code(400);
      return { error: "from must be a non-negative integer." };
    }
    const to = parseNonNegInt(query.to, store.lastSeq());
    if (to === null) {
      reply.code(400);
      return { error: "to must be a non-negative integer." };
    }
    if (from > to) {
      reply.code(400);
      return { error: "from must be <= to." };
    }
    return { from, to, events: store.range(from, to) };
  });

  // Heartbeat/observe summary — mirrors the legate loop's GET /status.
  app.get("/status", async () => {
    const proj = store.projection();
    const observe = getObserveStatus();
    const nowMs = Date.now();
    return {
      ok: true,
      last_observe_at: observe.lastObserveAtMs ? new Date(observe.lastObserveAtMs).toISOString() : null,
      last_observe_age_seconds: observe.lastObserveAtMs
        ? Math.round((nowMs - observe.lastObserveAtMs) / 1000)
        : null,
      last_observe_duration_ms: observe.lastObserveDurationMs,
      event_count: store.count(),
      last_seq: store.lastSeq(),
      workers: proj.workers,
      smithy: proj.smithy,
      slices_observed: Object.keys(proj.slices).length,
      state_present: proj.statePresent,
      state_error: proj.stateError,
    };
  });
}
