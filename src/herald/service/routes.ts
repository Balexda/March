import type { FastifyInstance } from "fastify";
import { isFinderAvailable, isOnPath } from "../../shared/deps.js";
import { bearerMatches } from "../../shared/bearer.js";
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
import { selfBotLogin } from "../profiles/merge-policy.js";
import { reviewWaitMs } from "../profiles/review-config.js";
import type { ProfileStore } from "../profiles/store.js";
import { projectReviewStates } from "./state-projection.js";
import { buildInfo } from "../../shared/build-info.js";
import type { AppendAttribution, EventStore } from "./store.js";
import { emptySystemState, REVIEW_BACKOFF_CAUSES, REVIEW_REQUEST_REASONS, type AppendEventInput, type EventType, type OperatorSliceAction } from "../events.js";

/** Snapshot of the server's last observe tick, surfaced on `/status`. */
export interface ObserveStatus {
  /** Epoch ms of the last completed observe tick (null before the first). */
  readonly lastObserveAtMs: number | null;
  /** Wall-clock ms of the last observe tick. */
  readonly lastObserveDurationMs: number | null;
  /** Per-profile default-branch sync attempt/success times (#592), in memory. */
  readonly syncByProfile?: Readonly<Record<string, { lastFetchAt: string | null; lastSuccessAt: string | null }>>;
}

export interface RoutesOptions {
  readonly store: EventStore;
  readonly profileStore?: ProfileStore;
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

/** The Legate operator token (#593). When set on Herald too, `POST /events`
 *  requires it as a bearer for the operator-request event types below. */
export const OPERATOR_TOKEN_ENV = "MARCH_LEGATE_OPERATOR_TOKEN";

/**
 * Event types that ask the legate to act (#593): an operator request, or the
 * legate's own recovery-ladder transitions of the same type. Merge-now skips the
 * review and CI gates, so these must not be writable by anyone who can reach
 * Herald when the operator token is configured. Only the legate writes them, and
 * its Herald client sends the token on every append.
 */
export const OPERATOR_REQUEST_TYPES: ReadonlySet<string> = new Set([
  "slice.merge.requested",
  "slice.relaunch.requested",
  "slice.requeue.requested",
  "slice.recovery.requested",
  "dispatch.paused",
  "dispatch.resumed",
  "legate.tick.requested",
]);

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
  "review.requested",
  "review.backoff",
  "slice.pr.changed",
  "slice.output.changed",
  "session.changed",
  "workers.changed",
  "smithy.queue.changed",
  "repo.sync.changed",
  "slice.dispatched",
  "slice.steward.attached",
  "slice.stage.changed",
  "slice.archived",
  "slice.recovery.dispatched",
  "slice.recovery.requested",
  "steward.relaunched",
  "slice.escalated",
  "slice.requeue.requested",
  "slice.requeue.refused",
  "retry.counted",
  "slice.merge.requested",
  "slice.relaunch.requested",
  "slice.operator.refused",
  "legate.tick.requested",
  "dispatch.paused",
  "dispatch.resumed",
]);

/** Slice-keyed event types that require a non-empty `sliceId`. */
const SLICE_TYPES: ReadonlySet<string> = new Set([
  "review.requested",
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
  "slice.requeue.requested",
  "slice.requeue.refused",
  "slice.merge.requested",
  "slice.relaunch.requested",
  "slice.operator.refused",
]);

/** The operator slice levers `slice.operator.refused` may name (#593). */
const OPERATOR_SLICE_ACTIONS: readonly OperatorSliceAction[] = ["merge", "relaunch"];

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
  | { readonly ok: true; readonly input: AppendEventInput; readonly attribution?: AppendAttribution }
  | { readonly ok: false; readonly error: string };

/** Bounds on the operator attribution carried by `POST /events` (#593). */
export const MAX_ATTRIBUTION_OPERATOR = 128;
export const MAX_ATTRIBUTION_NOTE = 1000;

/**
 * Parse the optional `attribution: {operator?, note?}` object on a `POST /events`
 * body (#593). Nested (not top-level) so it can never collide with an event-body
 * field of the same name (e.g. `slice.requeue.requested.operator`). Returns the
 * parsed attribution (undefined when absent/empty) or an error string.
 */
function parseAttribution(raw: unknown): { attribution?: AppendAttribution } | { error: string } {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "attribution must be an object." };
  const { operator, note } = raw as Record<string, unknown>;
  if (operator !== undefined && (typeof operator !== "string" || operator.length > MAX_ATTRIBUTION_OPERATOR)) {
    return { error: `attribution.operator must be a string of at most ${MAX_ATTRIBUTION_OPERATOR} characters.` };
  }
  if (note !== undefined && (typeof note !== "string" || note.length > MAX_ATTRIBUTION_NOTE)) {
    return { error: `attribution.note must be a string of at most ${MAX_ATTRIBUTION_NOTE} characters.` };
  }
  const op = typeof operator === "string" ? operator.trim() : "";
  const nt = typeof note === "string" ? note.trim() : "";
  if (!op && !nt) return {};
  return { attribution: { ...(op ? { operator: op } : {}), ...(nt ? { note: nt } : {}) } };
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}

/**
 * Validate a `POST /events` body against the shared taxonomy. A known `type`
 * (+ its required key) is enforced; the rest of the body is carried through as
 * the event payload. `source` is FORCED to `"legate"` — `POST /events` is the
 * legate write-path, and Herald's own observation events are appended by the
 * observer directly to the store (never over HTTP), so a client must not be able
 * to spoof Herald-authored observation events.
 *
 * An optional `attribution: {operator?, note?}` (#593) names the operator who
 * asked for this transition; it is stripped from the payload and returned
 * separately so the store stamps it on the envelope (never folded).
 */
export function validateEvent(rawBody: Record<string, unknown>): EventValidation {
  const { attribution: rawAttribution, ...body } = rawBody;
  const parsedAttribution = parseAttribution(rawAttribution);
  if ("error" in parsedAttribution) return { ok: false, error: parsedAttribution.error };
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
  if (type === "slice.stage.changed" && body.handledFeedback !== undefined) {
    const feedback = body.handledFeedback as
      { kind?: unknown; commentIds?: unknown; dispatchKey?: unknown; headSha?: unknown } | null;
    const optionalString = (value: unknown) => value === undefined || typeof value === "string";
    if (!feedback || (feedback.kind !== "inline" && feedback.kind !== "conversation")
      || !Array.isArray(feedback.commentIds)
      || !feedback.commentIds.every((id) => typeof id === "string" && id.trim().length > 0)
      || !optionalString(feedback.dispatchKey) || !optionalString(feedback.headSha)) {
      return { ok: false, error: "handledFeedback requires an inline or conversation kind, an array of comment IDs and optional string dispatchKey and headSha." };
    }
  }
  if (type === "repo.sync.changed") {
    const sync = body.sync as Record<string, unknown> | undefined;
    const nullableString = (v: unknown) => v === null || typeof v === "string";
    const nullableCount = (v: unknown) => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
    if (!sync || typeof sync !== "object" || typeof sync.ok !== "boolean" || typeof sync.at !== "string" ||
        !nullableString(sync.defaultBranch) || !nullableString(sync.head) || !nullableString(sync.originHead) ||
        !nullableCount(sync.behind) || !nullableCount(sync.ahead) ||
        (sync.error !== undefined && typeof sync.error !== "string")) {
      return { ok: false, error: `event "repo.sync.changed" requires a sync status { ok, at, defaultBranch, head, originHead, behind, ahead }.` };
    }
  }
  if (type === "session.changed") {
    const session = body.session as { id?: unknown } | undefined;
    if (!session || typeof session.id !== "string" || session.id.length === 0) {
      return { ok: false, error: `event "session.changed" requires session.id.` };
    }
  }
  // Durable worktree path (#412) carried by slice.dispatched / slice.steward.attached
  // / steward.relaunched. Optional, but when present it must be a non-empty
  // (non-whitespace) string — an empty/garbage value would fold into
  // slice.worktreePath and send the relaunch handler to a bogus path.
  if (body.worktreePath !== undefined) {
    if (typeof body.worktreePath !== "string" || body.worktreePath.trim().length === 0) {
      return { ok: false, error: `event "${type}" worktreePath must be a non-empty string.` };
    }
  }
  // The slice action key (#653) on slice.dispatched / slice.recovery.dispatched.
  // Optional (pre-#653 legates omit it), but typed when present — it folds into
  // slice.command/arguments/artifactPath, which the legate's dedup matchers key on.
  if (type === "slice.dispatched" || type === "slice.recovery.dispatched") {
    if (body.command !== undefined && (typeof body.command !== "string" || body.command.trim().length === 0)) {
      return { ok: false, error: `event "${type}" command must be a non-empty string.` };
    }
    if (body.arguments !== undefined &&
        (!Array.isArray(body.arguments) || !body.arguments.every((arg) => typeof arg === "string"))) {
      return { ok: false, error: `event "${type}" arguments must be an array of strings.` };
    }
    if (body.artifactPath !== undefined &&
        (typeof body.artifactPath !== "string" || body.artifactPath.trim().length === 0)) {
      return { ok: false, error: `event "${type}" artifactPath must be a non-empty string.` };
    }
  }
  // Graduated-recovery rung (#412) on slice.recovery.requested: optional, but when
  // present it selects the reducer branch, so it must be an integer in {0,1,2,3}
  // (3 = the last-resort tombstone-and-redispatch; 0-2 = the gentle rungs).
  if (type === "slice.recovery.requested" && body.rung !== undefined) {
    if (typeof body.rung !== "number" || !Number.isInteger(body.rung) || body.rung < 0 || body.rung > 3) {
      return { ok: false, error: `event "slice.recovery.requested" rung must be an integer in {0,1,2,3}.` };
    }
  }
  // Operator requeue (#588/#593): optional fields, but typed when present —
  // `closePr` gates closing a PR, so it must be a real boolean, never truthy junk.
  if (type === "slice.requeue.requested" && body.closePr !== undefined && typeof body.closePr !== "boolean") {
    return { ok: false, error: `event "slice.requeue.requested" closePr must be a boolean.` };
  }
  if (type === "slice.requeue.requested" && body.releaseMerged !== undefined && typeof body.releaseMerged !== "boolean") {
    return { ok: false, error: `event "slice.requeue.requested" releaseMerged must be a boolean.` };
  }
  if (type === "slice.requeue.requested" || type === "slice.requeue.refused") {
    for (const field of type === "slice.requeue.requested" ? ["operator", "reason"] : ["reason"]) {
      if (body[field] !== undefined && typeof body[field] !== "string") {
        return { ok: false, error: `event "${type}" ${field} must be a string.` };
      }
    }
  }
  if (type === "slice.merge.requested" &&
      (typeof body.prNumber !== "number" || !Number.isSafeInteger(body.prNumber) || body.prNumber < 1)) {
    return { ok: false, error: `event "slice.merge.requested" requires a positive integer prNumber.` };
  }
  if (type === "steward.relaunched" && body.requestSeq !== undefined &&
      (typeof body.requestSeq !== "number" || !Number.isSafeInteger(body.requestSeq))) {
    return { ok: false, error: `event "steward.relaunched" requestSeq must be an integer.` };
  }
  if (type === "slice.operator.refused" &&
      (!OPERATOR_SLICE_ACTIONS.includes(body.action as OperatorSliceAction) || typeof body.reason !== "string" ||
        (body.requestSeq !== undefined && (typeof body.requestSeq !== "number" || !Number.isSafeInteger(body.requestSeq))))) {
    return { ok: false, error: `event "slice.operator.refused" requires action (${OPERATOR_SLICE_ACTIONS.join("|")}), a string reason and an optional integer requestSeq.` };
  }
  if ((type === "legate.tick.requested" || type === "dispatch.paused" || type === "dispatch.resumed") &&
      body.reason !== undefined && typeof body.reason !== "string") {
    return { ok: false, error: `event "${type}" reason must be a string.` };
  }
  if (type === "review.backoff") {
    const { reviewer, until, attempts, cause, signalAt, noticeId, resetObservedAt } = body;
    if ((reviewer !== "coderabbit" && reviewer !== "copilot") ||
        !isUtcTimestamp(until) || typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 0 ||
        !REVIEW_BACKOFF_CAUSES.some((candidate) => candidate === cause) || (cause === "reset") !== (attempts === 0) ||
        (signalAt !== undefined && !isUtcTimestamp(signalAt)) ||
        (resetObservedAt !== undefined && (!isUtcTimestamp(resetObservedAt) || cause === "reset")) ||
        (noticeId !== undefined && (typeof noticeId !== "string" || !noticeId.trim() || noticeId.length > 512))) {
      return { ok: false, error: "invalid reviewer back-off record." };
    }
  }
  if (type === "review.requested") {
    const { pr, reviewer, headSha, at, reason } = body;
    if (typeof body.sliceId !== "string" || !body.sliceId.trim() ||
        typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1 ||
        (reviewer !== "coderabbit" && reviewer !== "copilot") ||
        typeof headSha !== "string" || !/^[a-f0-9]{40}$/i.test(headSha) ||
        !isUtcTimestamp(at) ||
        !REVIEW_REQUEST_REASONS.some((candidate) => candidate === reason)) {
      return { ok: false, error: "invalid review request PR, reviewer, headSha, UTC timestamp or reason." };
    }
  }
  return {
    ok: true,
    input: { ...(body as object), source: "legate" } as AppendEventInput,
    ...(parsedAttribution.attribution ? { attribution: parsedAttribution.attribution } : {}),
  };
}

export async function registerRoutes(
  app: FastifyInstance,
  opts: RoutesOptions,
): Promise<void> {
  const { store } = opts;
  const env = opts.env ?? process.env;
  const waitMs = reviewWaitMs(env, (message) => app.log.warn(message));
  const selfLogin = selfBotLogin(env);
  const getObserveStatus =
    opts.getObserveStatus ??
    ((): ObserveStatus => ({ lastObserveAtMs: null, lastObserveDurationMs: null }));

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

  app.get("/healthz", async () => ({ status: "ok", build: buildInfo("herald") }));

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
    // Operator requests need the operator bearer when the token is set (#593).
    // Read per request, like the admin gate, so it tracks the live env.
    const operatorToken = env[OPERATOR_TOKEN_ENV]?.trim();
    if (operatorToken && OPERATOR_REQUEST_TYPES.has(String(validation.input.type))) {
      if (!bearerMatches(request.headers["authorization"], operatorToken)) {
        reply.code(401);
        return { error: `event "${String(validation.input.type)}" requires the operator bearer token.` };
      }
    }
    const event = store.append(validation.input, undefined, validation.attribution);
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
    const fold = at !== undefined ? store.multiStateAt(at) : store.multiProjection();
    const now = at !== undefined ? new Date(fold.ts) : new Date();
    const project = (name: string) => projectReviewStates(
      Object.hasOwn(fold.byProfile, name) ? fold.byProfile[name] : emptySystemState(), fold.reviewBackoffs,
      opts.profileStore?.get(name, { includeRemoved: true })?.mergePolicy,
      selfLogin, waitMs, now,
    );
    if (all) {
      for (const name of Object.keys(fold.byProfile)) project(name);
      return fold;
    }
    return project(profile ?? store.defaultProfile);
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
        // #592: the fold's last-changed sync status plus the in-memory fetch times.
        sync: s.repoSync || observe.syncByProfile?.[p]
          ? {
              ...(s.repoSync ?? {}),
              last_fetch_at: observe.syncByProfile?.[p]?.lastFetchAt ?? null,
              last_success_at: observe.syncByProfile?.[p]?.lastSuccessAt ?? null,
            }
          : null,
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
      build: buildInfo("herald"),
    };
  });
}
