import type { FastifyInstance } from "fastify";
import { isFinderAvailable, isOnPath } from "../../shared/deps.js";
import {
  outcomeFromStatus,
  recordHeraldRequest,
} from "../../observability/herald-metrics.js";
import { startHeraldSpan } from "../../observability/herald-trace.js";
import {
  recordHeraldAdminEvent,
  recordStewardReport,
  stewardReportClassification,
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
  /**
   * Env source for the break-glass admin token (#265). Defaults to
   * `process.env`; injectable so tests toggle the gate without mutating the
   * process environment.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/** Env var gating the break-glass `POST /admin/events` endpoint (#265). */
export const HERALD_ADMIN_TOKEN_ENV = "MARCH_HERALD_ADMIN_TOKEN";

/** Extract a `Bearer <token>` value from an Authorization header, or null. */
function bearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : null;
}

const DEFAULT_EVENTS_LIMIT = 100;
const MAX_EVENTS_LIMIT = 1000;

const EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "heartbeat",
  "state.error",
  "state.ok",
  "slice.pr.changed",
  "slice.output.changed",
  "session.changed",
  "workers.changed",
  "smithy.queue.changed",
  "slice.dispatched",
  "slice.steward.attached",
  "slice.stage.changed",
  "slice.archived",
  "slice.recovery.dispatched",
  "slice.recovery.requested",
  "steward.relaunched",
  "slice.escalated",
  "retry.counted",
]);

/** Slice-keyed event types that require a non-empty `sliceId`. */
const SLICE_TYPES: ReadonlySet<string> = new Set([
  "slice.pr.changed",
  "slice.output.changed",
  "slice.dispatched",
  "slice.steward.attached",
  "slice.stage.changed",
  "slice.archived",
  "slice.recovery.dispatched",
  "slice.recovery.requested",
  "steward.relaunched",
  "slice.escalated",
]);

/** Transition event types whose schema carries an optional steward `sessionId`. */
const SESSION_ID_TYPES: ReadonlySet<string> = new Set([
  "slice.dispatched",
  "slice.stage.changed",
  "steward.relaunched",
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
 * Validate a `POST /events` body against the shared taxonomy. A known `type`
 * (+ its required key) is enforced; the rest of the body is carried through as
 * the event payload. `source` is FORCED to `"legate"` — `POST /events` is the
 * legate write-path, and Herald's own observation events are appended by the
 * observer directly to the store (never over HTTP), so a client must not be able
 * to spoof Herald-authored observation events.
 */
export function validateEvent(body: Record<string, unknown>): EventValidation {
  const type = body.type;
  if (typeof type !== "string" || !EVENT_TYPES.has(type as EventType)) {
    return { ok: false, error: `unknown event type "${String(type)}".` };
  }
  if (SLICE_TYPES.has(type) && (typeof body.sliceId !== "string" || body.sliceId.length === 0)) {
    return { ok: false, error: `event "${type}" requires a non-empty sliceId.` };
  }
  // Transition events carry the steward sessionId so Herald's fold learns the
  // slice→session link PR discovery is gated on (#210). It is optional, but when
  // present it must be a non-empty (non-whitespace) string across every type that
  // supports it — an empty/garbage id would otherwise fold into slice.sessionId
  // and corrupt discovery downstream.
  if (SESSION_ID_TYPES.has(type) && body.sessionId !== undefined) {
    if (typeof body.sessionId !== "string" || body.sessionId.trim().length === 0) {
      return { ok: false, error: `event "${type}" sessionId must be a non-empty string.` };
    }
  }
  // slice.steward.attached (#213) is the Hatchery push: sessionId is MANDATORY
  // (it is the whole point of the event), so require it rather than treating it as
  // optional like the SESSION_ID_TYPES transitions above.
  if (type === "slice.steward.attached" && (typeof body.sessionId !== "string" || body.sessionId.trim().length === 0)) {
    return { ok: false, error: `event "slice.steward.attached" requires a non-empty sessionId.` };
  }
  if (type === "session.changed") {
    const session = body.session as { id?: unknown } | undefined;
    if (!session || typeof session.id !== "string" || session.id.length === 0) {
      return { ok: false, error: `event "session.changed" requires session.id.` };
    }
  }
  return { ok: true, input: { ...(body as object), source: "legate" } as AppendEventInput };
}

export async function registerRoutes(
  app: FastifyInstance,
  opts: RoutesOptions,
): Promise<void> {
  const { store } = opts;
  const env = opts.env ?? process.env;
  const getObserveStatus =
    opts.getObserveStatus ??
    (() => ({ lastObserveAtMs: null, lastObserveDurationMs: null }));

  // Record every request keyed by route TEMPLATE (not the concrete path) to
  // keep metric cardinality bounded — the same rule the other services use.
  // Requests are spanned SPARINGLY (the high-frequency GET /events drain and
  // health polls would otherwise drown the traces): only mutations (POST) and
  // 5xx failures get a span — the cases worth seeing in a debug trace. Read
  // volume is left to the RED metrics above. The span is synthesized at response
  // time with the real duration, nesting under any inbound traceparent.
  app.addHook("onResponse", async (request, reply) => {
    const status = reply.statusCode;
    if (request.method === "POST" || status >= 500) {
      const tp = request.headers["traceparent"];
      const traceparent = Array.isArray(tp) ? tp[0] : tp;
      startHeraldSpan({
        name: "herald.request",
        traceparent,
        startTimeMs: Date.now() - reply.elapsedTime,
        attributes: {
          "http.method": request.method,
          "http.route": request.routeOptions.url ?? "unknown",
          "http.status_code": status,
        },
      }).end({ error: status >= 500 });
    }
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
    // The legate drains the whole multiplexed stream (one cursor); `?profile=`
    // is an operator/debug filter only.
    const profile =
      typeof query.profile === "string" && query.profile.length > 0 ? query.profile : undefined;
    const events = store.readAfter(after, limit, profile);
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

  // Steward self-report write path (#steward-self-report): the steward's hook (or
  // the legate-agent, pushing a classified result) POSTs its own state here. Herald
  // only RECORDS it as a `slice.steward.report` event — the legate acts on the fold.
  // Distinct from POST /events (which forces legate transition events) so an
  // external reporter has a small, purpose-shaped body.
  app.post("/steward-report", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const profile = typeof body.profile === "string" ? body.profile : "";
    const sliceId = typeof body.sliceId === "string" ? body.sliceId : "";
    if (profile.length === 0 || sliceId.length === 0) {
      reply.code(400);
      return { error: "steward-report requires non-empty profile and sliceId." };
    }
    if (typeof body.classified !== "boolean") {
      reply.code(400);
      return { error: "steward-report requires a boolean `classified`." };
    }
    const status = body.status;
    if (status !== undefined && status !== "awaiting_input" && status !== "reported" && status !== "working") {
      reply.code(400);
      return { error: `steward-report status must be awaiting_input|reported|working (got "${String(status)}").` };
    }
    const event = store.append({
      type: "slice.steward.report",
      source: "legate",
      profile,
      sliceId,
      classified: body.classified,
      ...(status !== undefined ? { status: status as "awaiting_input" | "reported" | "working" } : {}),
      ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
    } as AppendEventInput);
    // Track report volume + the heuristic-vs-legate-agent split (#371): a rising
    // `unclassified` share means the cheap hook heuristics are missing cases and
    // pushing the expensive legate-agent harder — the heuristic-health monitor.
    recordStewardReport({
      profile,
      classification: stewardReportClassification(
        body.classified,
        typeof status === "string" ? status : undefined,
      ),
    });
    reply.code(201);
    return event;
  });

  // Break-glass operator endpoint (#265): author a corrective event into the
  // fold through the normal pipeline (validated, sequenced, audited) instead of
  // hand-editing the sqlite log or growing dead auto-heal code in the legate.
  //
  // The token (MARCH_HERALD_ADMIN_TOKEN) is read PER REQUEST so the gate tracks
  // the live env: UNSET → the route 404s (invisible by default — prod leaves it
  // unset); SET but the Bearer is missing/wrong → 401. Read at request time so a
  // single long-lived server can be armed and disarmed without a restart.
  app.post("/admin/events", async (request, reply) => {
    const expected = env[HERALD_ADMIN_TOKEN_ENV]?.trim();
    if (!expected) {
      reply.code(404);
      return { error: "not found" };
    }
    if (bearerToken(request.headers["authorization"]) !== expected) {
      reply.code(401);
      return { error: "invalid or missing admin bearer token." };
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const profile = typeof body.profile === "string" ? body.profile.trim() : "";
    const operator = typeof body.operator === "string" ? body.operator.trim() : "";
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (!profile) {
      reply.code(422);
      return { error: "profile is required." };
    }
    if (!operator) {
      reply.code(422);
      return { error: "operator is required." };
    }
    if (!note) {
      reply.code(422);
      return { error: "note is required." };
    }
    // Reuse the SAME union validator POST /events uses — reducer-safe by
    // construction; an operator cannot author an out-of-taxonomy event (the
    // forensic admin.event.appended type is intentionally absent from the
    // validator's accepted set, so it can't be posted here either).
    const validation = validateEvent((body.event ?? {}) as Record<string, unknown>);
    if (!validation.ok) {
      reply.code(422);
      return { error: validation.error };
    }
    // Stamp the corrective event with the audit attributes (admin/operator/note)
    // and the operator-chosen profile; it folds by its own type, identically to a
    // normal append.
    const appended = store.append({ ...validation.input, profile }, { operator, note });
    // Pair it with a forensic audit row so the log is self-describing even to
    // tooling that only reads events and never inspects the audit columns.
    const auditRow = store.append({
      type: "admin.event.appended",
      appendedSeq: appended.seq,
      operator,
      note,
      source: "legate",
      profile,
    });
    recordHeraldAdminEvent(appended.type);
    request.log.info(
      { operator, note, eventType: appended.type, profile, seq: appended.seq, auditSeq: auditRow.seq },
      "herald admin event appended",
    );
    reply.code(200);
    return { seq: appended.seq, auditSeq: auditRow.seq };
  });

  // The projection, or as-of a `seq`. `?profile=` → that profile's SystemState
  // (the legate's per-profile cold-start); `?all=1` → the full MultiProfileState;
  // bare → the default profile's SystemState (back-compat single-profile view).
  app.get("/state", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    let at: number | undefined;
    if (query.at !== undefined && query.at !== "") {
      const parsed = parseNonNegInt(query.at, 0);
      if (parsed === null) {
        reply.code(400);
        return { error: "at must be a non-negative integer." };
      }
      at = parsed;
    }
    const all = query.all === "1" || query.all === "true";
    const profile =
      typeof query.profile === "string" && query.profile.length > 0 ? query.profile : undefined;
    if (all) {
      return at !== undefined ? store.multiStateAt(at) : store.multiProjection();
    }
    if (profile) {
      return at !== undefined ? store.stateAtFor(profile, at) : store.projectionFor(profile);
    }
    return at !== undefined ? store.stateAt(at) : store.projection();
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
    const profile =
      typeof query.profile === "string" && query.profile.length > 0 ? query.profile : undefined;
    const events = store.range(from, to);
    return { from, to, events: profile ? events.filter((e) => e.profile === profile) : events };
  });

  // Heartbeat/observe summary — mirrors the legate loop's GET /status, now with a
  // per-profile breakdown. Top-level workers/smithy reflect the default profile
  // (back-compat); `profiles`/`by_profile` cover the multi-profile deployment.
  app.get("/status", async () => {
    const multi = store.multiProjection();
    const def = store.projection();
    const observe = getObserveStatus();
    const nowMs = Date.now();
    const profiles = Object.keys(multi.byProfile).sort();
    const byProfile: Record<string, unknown> = {};
    let slicesObserved = 0;
    for (const p of profiles) {
      const s = multi.byProfile[p];
      const sliceCount = Object.keys(s.slices).length;
      slicesObserved += sliceCount;
      byProfile[p] = {
        slices_observed: sliceCount,
        workers: s.workers,
        smithy: s.smithy,
        state_present: s.statePresent,
        state_error: s.stateError,
      };
    }
    return {
      ok: true,
      last_observe_at: observe.lastObserveAtMs ? new Date(observe.lastObserveAtMs).toISOString() : null,
      last_observe_age_seconds: observe.lastObserveAtMs
        ? Math.round((nowMs - observe.lastObserveAtMs) / 1000)
        : null,
      last_observe_duration_ms: observe.lastObserveDurationMs,
      event_count: store.count(),
      last_seq: store.lastSeq(),
      profiles,
      by_profile: byProfile,
      slices_observed: slicesObserved,
      workers: def.workers,
      smithy: def.smithy,
      state_present: def.statePresent,
      state_error: def.stateError,
    };
  });
}
