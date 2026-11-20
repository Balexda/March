import Fastify, { type FastifyInstance } from "fastify";
import type { LoopSnapshot } from "./runtime.js";
import { releasableArchive } from "./pure/slice.js";

/**
 * HTTP API for the profile-agnostic Legate service, built on Fastify. The
 * legate-agent (a Claude conductor on the host) calls this to read loop state
 * deterministically rather than scraping logs. One container drives N profiles,
 * so `/status?profile=<p>` returns one profile's tick state and bare `/status`
 * returns the per-profile breakdown. Security model: the server binds `0.0.0.0`
 * inside the container so Docker's loopback port publish can reach it; the host
 * publishes only on loopback, so the API is never exposed beyond the host.
 */

/** Operator input to the respond endpoint: an answer to deliver, or an ack. */
export interface RespondInput {
  /** Owning profile (which registered repo the slice belongs to). */
  profile: string;
  /** The escalated slice id. */
  sliceId: string;
  /** Free-text answer to deliver into the live steward session (answer mode). */
  message?: string;
  /** Mark-read: clear the escalation back to babysit handling without an answer. */
  ack?: boolean;
}

/** Result of a respond attempt (also the HTTP response body). */
export interface RespondResult {
  ok: boolean;
  profile?: string;
  sliceId?: string;
  /** `answer` when a message was delivered; `ack` when only marked read. */
  mode?: "answer" | "ack";
  /** Answer mode: whether the message reached the steward session. */
  delivered?: boolean;
  /** Whether the steward report was flipped to a non-awaiting status. */
  cleared?: boolean;
  /** Whether a recovery request was appended to drive the slice out of `escalated`
   *  (the graduated ladder un-escalates + relaunches even for a dead session). */
  recoveryRequested?: boolean;
  error?: string;
  /** On an unknown-profile error, the known profiles (parity with /status). */
  profiles?: string[];
}

/** Operator input to the requeue endpoint (#588/#593). */
export interface RequeueInput {
  profile: string;
  sliceId: string;
  /** Close the slice's open PR as part of the requeue (refused without it). */
  closePr?: boolean;
  /** Release an ARCHIVED slice whose PR merged (#592). An archived CLOSED slice
   *  is released without it; a merged one is refused unless this is set. */
  releaseMerged?: boolean;
  /** Who asked (attribution in the event log). */
  operator?: string;
  /** Why (attribution; also the PR-close comment). */
  reason?: string;
}

/** Result of a requeue request (also the HTTP response body). */
export interface RequeueResult {
  ok: boolean;
  profile?: string;
  sliceId?: string;
  /** The `slice.requeue.requested` event was appended; the next tick acts on it. */
  requested?: boolean;
  /** The requeue will close this open PR. */
  closesPr?: number | null;
  /** The target is an archived slice; the requeue releases its hold on the plan row (#592). */
  releasesArchive?: "MERGED" | "CLOSED";
  /** HTTP status hint for a refusal (404 unknown, 409 conflict). */
  status?: number;
  error?: string;
  profiles?: string[];
}

export interface LoopHttpContext {
  readonly startedAtMs: number;
  readonly getSnapshot: () => LoopSnapshot;
  /** Effect an operator's answer/ack to an escalated `steward_awaiting_input`
   *  slice. Supplied by the runtime (it needs Castra + Herald); absent in the
   *  pure HTTP unit tests, where the route reports 501. */
  readonly respondToEscalation?: (input: RespondInput) => Promise<RespondResult>;
  /** Request an operator requeue (#588/#593). Supplied by the runtime; absent in
   *  the pure HTTP unit tests, where the route reports 501. */
  readonly requeueSlice?: (input: RequeueInput) => Promise<RequeueResult>;
}

/** Per-profile status from a heartbeat record + tick timing (pure; testable). */
export function statusForRecord(
  r: any,
  tick: { lastTickAtMs: number; lastTickDurationMs: number },
): Record<string, unknown> {
  const ageSeconds =
    tick.lastTickAtMs > 0 ? Math.round((Date.now() - tick.lastTickAtMs) / 100) / 10 : null;
  return {
    last_tick_at: r?.ts ?? null,
    last_tick_age_seconds: ageSeconds,
    last_tick_duration_ms: tick.lastTickDurationMs || null,
    queue: {
      dispatchable: r?.dispatchable_count ?? 0,
      blocked: r?.blocked_count ?? 0,
      total: r?.pending_total ?? 0,
    },
    slices: {
      total: r?.slice_count ?? 0,
      archived: r?.archived_slice_count ?? 0,
    },
    workers: r?.workers ?? {},
    counters: {
      cleanup: r?.cleanup_count ?? 0,
      ghost_cleanup: r?.ghost_cleanup_count ?? 0,
      relaunch: r?.relaunch_count ?? 0,
      babysit: r?.babysit_action_count ?? 0,
      steward_nudge: r?.steward_nudge_count ?? 0,
      steward_stranded: r?.steward_stranded_count ?? 0,
      dispatch: r?.dispatch_action_count ?? 0,
      dispatch_failure: r?.dispatch_failure_count ?? 0,
    },
    state_present: r?.state_present ?? false,
    state_error: r?.state_error ?? null,
  };
}

/** One profile's `/queue` body from its latest dispatch snapshot (pure; testable). */
export function queueForEntry(entry: { lastHeartbeat: any; lastDispatch?: any } | undefined): Record<string, unknown> {
  const r = entry?.lastHeartbeat;
  const d = entry?.lastDispatch;
  return {
    last_tick_at: d?.at ?? r?.ts ?? null,
    smithy_ok: d ? d.smithyOk : null,
    queue: {
      dispatchable: r?.dispatchable_count ?? 0,
      blocked: r?.blocked_count ?? 0,
      total: r?.pending_total ?? 0,
    },
    items: d?.items ?? [],
    checkout: d?.checkout ?? null,
  };
}

/**
 * Build the `/queue` payload (#592): why each ready plan item did or did not
 * dispatch on the profile's last tick. With `profile`, that profile (or null for
 * an unknown one); else every profile under `by_profile`.
 */
export function buildQueue(ctx: LoopHttpContext, profile?: string): Record<string, unknown> | null {
  const snap = ctx.getSnapshot();
  if (profile) {
    const entry = Object.hasOwn(snap.byProfile, profile) ? snap.byProfile[profile] : undefined;
    if (!entry) return null;
    return { ok: true, profile, ...queueForEntry(entry) };
  }
  const byProfile: Record<string, unknown> = {};
  for (const p of snap.profiles) byProfile[p] = queueForEntry(snap.byProfile[p]);
  return { ok: true, profiles: snap.profiles, by_profile: byProfile };
}

/** Build the /status payload. With `profile`, that profile's status; else all. */
export function buildStatus(ctx: LoopHttpContext, profile?: string): Record<string, unknown> {
  const snap = ctx.getSnapshot();
  const tick = { lastTickAtMs: snap.lastTickAtMs, lastTickDurationMs: snap.lastTickDurationMs };
  if (profile) {
    const entry = snap.byProfile[profile];
    if (!entry) return { ok: false, error: `unknown profile "${profile}".`, profiles: snap.profiles };
    return { ok: true, profile, ...statusForRecord(entry.lastHeartbeat, tick), checkout: entry.lastDispatch?.checkout ?? null };
  }
  const byProfile: Record<string, unknown> = {};
  for (const p of snap.profiles) {
    byProfile[p] = { ...statusForRecord(snap.byProfile[p].lastHeartbeat, tick), checkout: snap.byProfile[p].lastDispatch?.checkout ?? null };
  }
  return { ok: true, profiles: snap.profiles, by_profile: byProfile };
}

/** One escalated task in the /escalations interrogation payload — work needing
 *  operator attention (escalated-stage slices, incl. `steward_awaiting_input`). */
export interface EscalationEntry {
  /** The task — the slice id (encodes the smithy artifact/feature/slice). */
  task: string;
  /** The slice's PR branch, when known. */
  branch: string | null;
  /** The PR associated with the task (number + url), or null if none observed yet. */
  pr: { number: number | null; url: string | null } | null;
  /** Why it's escalated (the bounded `escalated_reason`, e.g. `steward_awaiting_input`). */
  reason: string | null;
  /** The Castra/agent-deck session id — so the operator can attach and unblock it. */
  session_id: string | null;
  /** The steward's worktree path — where to attach / inspect. */
  worktree_path: string | null;
  /** Human-readable detail (the last action note — for awaiting-input, a snippet
   *  of what the steward is asking). */
  detail: string | null;
  /** When it entered the escalation (best-effort: escalation stamp or last action). */
  escalated_at: string | null;
}

/** Extract the escalated slices from a profile's working state (pure; testable) —
 *  the operator's list of tasks needing manual resolution, each with the session
 *  id + worktree to go find and unblock it. */
export function escalationsForWorkingState(workingState: any): EscalationEntry[] {
  const slices = workingState?.slices;
  if (!slices || typeof slices !== "object") return [];
  const out: EscalationEntry[] = [];
  for (const [sliceId, s] of Object.entries(slices as Record<string, any>)) {
    if (!s || typeof s !== "object" || s.stage !== "escalated") continue;
    const pr = s.pr;
    out.push({
      task: sliceId,
      branch: s.actual_branch ?? s.branch ?? null,
      pr: pr && (pr.number != null || pr.url != null) ? { number: pr.number ?? null, url: pr.url ?? null } : null,
      reason: typeof s.escalated_reason === "string" ? s.escalated_reason : null,
      session_id: s.worker_session_id ?? null,
      worktree_path: s.worktree_path ?? null,
      detail: typeof s.last_action_note === "string" ? s.last_action_note : null,
      escalated_at: s.steward_awaiting_input_at ?? s.steward_stuck_at ?? s.last_action ?? null,
    });
  }
  return out;
}

/** The outcome of resolving a respond target from a profile's working state (pure). */
export type RespondTarget =
  | { ok: true; sessionId: string | null; reason: string }
  | { ok: false; error: string };

/**
 * Resolve (and validate) the slice a respond call targets, from a profile's
 * in-memory working state. Pure + testable. Respond only handles a latched
 * `steward_awaiting_input` escalation — the only reason whose latch a non-awaiting
 * steward-report clears (other reasons, e.g. `hatchery_dispatch_failed`, are
 * cleared by `march legate recover`, not here).
 */
export function resolveRespondTarget(workingState: any, sliceId: string): RespondTarget {
  const slice = workingState?.slices?.[sliceId];
  if (!slice || typeof slice !== "object") return { ok: false, error: `unknown slice "${sliceId}".` };
  if (slice.stage !== "escalated") {
    return { ok: false, error: `slice "${sliceId}" is not escalated (stage="${slice.stage ?? "?"}").` };
  }
  const reason = typeof slice.escalated_reason === "string" ? slice.escalated_reason : "";
  if (reason !== "steward_awaiting_input") {
    return {
      ok: false,
      error: `slice "${sliceId}" is escalated for "${reason || "?"}", not steward_awaiting_input — respond handles only steward-awaiting escalations (use \`march legate recover\` for others).`,
    };
  }
  return { ok: true, sessionId: slice.worker_session_id ?? null, reason };
}

/** The outcome of resolving a requeue target from a profile's working state (pure). */
export type RequeueTarget =
  | { ok: true; openPr: number | null; archived?: "MERGED" | "CLOSED" }
  | { ok: false; status: 404 | 409; error: string };


/**
 * Resolve (and validate) the slice a requeue call targets (#588/#593). Pure +
 * testable. Unlike respond, requeue accepts ANY in-flight slice whatever its
 * stage, escalation reason or session liveness — it is the "discard and
 * re-dispatch" lever. It refuses only what it must: an unknown / not-in-flight
 * slice, a merged PR, and an open PR unless the caller opts into closing it.
 * `observedPr` is the fold's PR observation (fresher than the warm record).
 */
export function resolveRequeueTarget(
  workingState: any,
  sliceId: string,
  closePr: boolean,
  observedPr?: any,
  releaseMerged = false,
): RequeueTarget {
  const slice = workingState?.slices?.[sliceId];
  if (!slice || typeof slice !== "object") {
    const archived = workingState?.archived_slices?.[sliceId];
    if (!archived) return { ok: false, status: 404, error: `unknown slice "${sliceId}".` };
    const release = releasableArchive(archived, releaseMerged);
    return release.ok
      ? { ok: true, openPr: null, archived: release.terminal }
      : { ok: false, status: 409, error: `slice "${sliceId}" ${release.error}.` };
  }
  if (slice.recovered) return { ok: false, status: 409, error: `slice "${sliceId}" was already recovered — it re-dispatches on its own.` };
  if (slice.stage === "hatchery-pending") {
    return { ok: false, status: 409, error: `slice "${sliceId}" has a spawn in progress (hatchery-pending) — requeue once it lands.` };
  }
  const pr = observedPr && !observedPr.skipped ? observedPr : slice.pr;
  const number = typeof pr?.number === "number" && pr.number > 0 ? pr.number : null;
  const state = typeof pr?.state === "string" ? pr.state.toUpperCase() : null;
  if (number !== null && state === "MERGED") {
    return { ok: false, status: 409, error: `slice "${sliceId}" PR #${number} already merged — nothing to requeue.` };
  }
  const openPr = number !== null && state !== "CLOSED" ? number : null;
  if (openPr !== null && !closePr) {
    return {
      ok: false,
      status: 409,
      error: `slice "${sliceId}" has open PR #${openPr} — pass closePr:true to close it and requeue.`,
    };
  }
  return { ok: true, openPr };
}

/** Build the /escalations payload. With `profile`, that profile's escalated tasks;
 *  else every profile's, keyed by profile. */
export function buildEscalations(ctx: LoopHttpContext, profile?: string): Record<string, unknown> {
  const snap = ctx.getSnapshot();
  if (profile) {
    const entry = snap.byProfile[profile];
    if (!entry) return { ok: false, error: `unknown profile "${profile}".`, profiles: snap.profiles };
    const escalations = escalationsForWorkingState(entry.workingState);
    return { ok: true, profile, count: escalations.length, escalations };
  }
  const byProfile: Record<string, unknown> = {};
  for (const p of snap.profiles) {
    const escalations = escalationsForWorkingState(snap.byProfile[p].workingState);
    byProfile[p] = { count: escalations.length, escalations };
  }
  return { ok: true, profiles: snap.profiles, by_profile: byProfile };
}

/** Build the Fastify app with the loop routes registered. Exported for tests (inject). */
export function buildLoopServer(ctx: LoopHttpContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({
    status: "ok",
    pid: process.pid,
    uptime_seconds: Math.round((Date.now() - ctx.startedAtMs) / 1000),
    profiles: ctx.getSnapshot().profiles,
  }));

  app.get("/status", async (request) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const profile =
      typeof query.profile === "string" && query.profile.length > 0 ? query.profile : undefined;
    return buildStatus(ctx, profile);
  });

  // Per-item dispatch decisions (#592): why each ready plan item did or did not
  // dispatch last tick, the slice that holds it, and the checkout sync status.
  app.get("/queue", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const profile =
      typeof query.profile === "string" && query.profile.length > 0 ? query.profile : undefined;
    const body = buildQueue(ctx, profile);
    if (body) return body;
    reply.code(404);
    return { ok: false, error: `unknown profile "${profile}".`, profiles: ctx.getSnapshot().profiles };
  });

  // Interrogation endpoint: list escalated tasks (what the task is, the PR, the
  // escalation details) for a profile — the operator's view of work that needs
  // manual resolution (e.g. steward_stuck) now that the legate-agent path isn't
  // built. `?profile=<p>` for one profile; bare for all.
  app.get("/escalations", async (request) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const profile =
      typeof query.profile === "string" && query.profile.length > 0 ? query.profile : undefined;
    return buildEscalations(ctx, profile);
  });

  // Respond to a steward escalated as `steward_awaiting_input`. Two modes:
  //   - `{ "message": "<answer>" }` delivers the operator's answer into the live
  //     steward session (Castra send), then un-escalates the slice.
  //   - `{ "ack": true }` marks it read WITHOUT an answer — for the false-positive
  //     "stuck" stewards that actually just finished / await merge / have open
  //     review threads.
  // Both flip the steward report to non-awaiting AND drive the graduated recovery
  // ladder, so the slice leaves `escalated` and returns to babysit's PR (fix +
  // merge) path — even when its session is dead (babysit skips dead-session
  // slices, so the report flip alone can't un-escalate them).
  // Profile from the body or `?profile=`. Read-but-acting, so it's the one POST.
  app.post("/escalations/:sliceId/respond", async (request, reply) => {
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const sliceId = typeof params.sliceId === "string" ? params.sliceId : "";
    const profile =
      (typeof body.profile === "string" && body.profile.length > 0 && body.profile) ||
      (typeof query.profile === "string" && query.profile.length > 0 && query.profile) ||
      "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const ack = body.ack === true;

    if (!profile) {
      reply.code(400);
      return { ok: false, error: "profile is required (body.profile or ?profile=)." };
    }
    if (!sliceId) {
      reply.code(400);
      return { ok: false, error: "sliceId path param is required." };
    }
    if (!message && !ack) {
      reply.code(400);
      return {
        ok: false,
        error: "provide a non-empty `message` to answer the steward, or `ack:true` to mark it read and return it to babysit handling.",
      };
    }
    if (message && ack) {
      // Exactly one mode: a `message` (answer, delivered to the steward) OR
      // `ack:true` (mark-read, no delivery). Accepting both is ambiguous and would
      // silently deliver the message — reject so the caller picks one.
      reply.code(400);
      return {
        ok: false,
        error: "provide exactly one of `message` (answer) or `ack:true` (mark read), not both.",
      };
    }
    if (!ctx.respondToEscalation) {
      reply.code(501);
      return { ok: false, error: "respond is not available in this context." };
    }

    const result = await ctx.respondToEscalation({
      profile,
      sliceId,
      ...(message ? { message } : {}),
      ack,
    });
    if (result.ok) {
      reply.code(200);
    } else {
      reply.code(/^unknown (profile|slice)/.test(result.error ?? "") ? 404 : 400);
    }
    return result;
  });

  // Operator REQUEUE (#588/#593): discard the slice's current incarnation (steward
  // session, worktree, branch; its open PR only with `closePr:true`) and put the
  // smithy item back in the queue for a fresh dispatch. Works for any in-flight
  // slice — including a steward parked on a question whose session died, which
  // respond and recover both refuse. Appends `slice.requeue.requested` (with the
  // operator + reason for attribution); the next tick's requeue handler acts on
  // it, so the response is 202 Accepted.
  app.post("/slices/:sliceId/requeue", async (request, reply) => {
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const sliceId = typeof params.sliceId === "string" ? params.sliceId : "";
    const profile =
      (typeof body.profile === "string" && body.profile.length > 0 && body.profile) ||
      (typeof query.profile === "string" && query.profile.length > 0 && query.profile) ||
      "";
    if (!profile) {
      reply.code(400);
      return { ok: false, error: "profile is required (body.profile or ?profile=)." };
    }
    if (!sliceId) {
      reply.code(400);
      return { ok: false, error: "sliceId path param is required." };
    }
    for (const field of ["closePr", "releaseMerged"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "boolean") {
        reply.code(400);
        return { ok: false, error: `${field} must be a boolean.` };
      }
    }
    for (const field of ["operator", "reason"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "string") {
        reply.code(400);
        return { ok: false, error: `${field} must be a string.` };
      }
    }
    if (!ctx.requeueSlice) {
      reply.code(501);
      return { ok: false, error: "requeue is not available in this context." };
    }
    const operator = typeof body.operator === "string" ? body.operator.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const result = await ctx.requeueSlice({
      profile,
      sliceId,
      closePr: body.closePr === true,
      ...(body.releaseMerged === true ? { releaseMerged: true } : {}),
      ...(operator ? { operator } : {}),
      ...(reason ? { reason } : {}),
    });
    if (result.ok) {
      reply.code(202);
    } else {
      reply.code(result.status ?? (/^unknown profile/.test(result.error ?? "") ? 404 : 400));
    }
    return result;
  });

  return app;
}

/** Start the loop HTTP server on the given port (loopback by default). */
export async function startLoopHttpServer(
  ctx: LoopHttpContext,
  port: number,
  host = "127.0.0.1",
): Promise<FastifyInstance> {
  const app = buildLoopServer(ctx);
  await app.listen({ port, host });
  return app;
}
