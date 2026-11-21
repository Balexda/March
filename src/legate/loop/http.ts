import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { bearerMatches } from "../../shared/bearer.js";
import { threadCommentIds } from "./handlers/babysit.js";
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
 *
 * Operator levers (#593): every non-GET route is an operator action. When
 * {@link LEGATE_OPERATOR_TOKEN_ENV} is set, each needs `Authorization: Bearer
 * <token>` (constant-time compare; 401 otherwise). Unset keeps the pre-#593 open
 * loopback posture so an existing install keeps working (a warning is logged at
 * startup). Every lever takes an optional `operator` + `reason` and stamps them on
 * the Herald event it appends, so history shows operator actions next to the
 * loop's own.
 */

/** Env var holding the shared operator bearer token for the Legate API (#593). */
export const LEGATE_OPERATOR_TOKEN_ENV = "MARCH_LEGATE_OPERATOR_TOKEN";

/** Attribution every operator lever carries (#593): who asked, and why. */
export interface OperatorFields {
  /** Who asked (stamped on the Herald event envelope; "unknown" when absent). */
  operator?: string;
  /** Why (the envelope `note`). */
  reason?: string;
}

/** Common shape of an operator lever's result (also the HTTP response body). */
export interface OperatorActionResult {
  ok: boolean;
  profile?: string;
  sliceId?: string;
  /** The request event was appended; the next tick acts on it. */
  requested?: boolean;
  /** HTTP status hint for a refusal (404 unknown, 409 conflict, 502 Herald). */
  status?: number;
  error?: string;
  /** On an unknown-profile error, the known profiles (parity with /status). */
  profiles?: string[];
  /** The PR the lever acts on (merge now). */
  prNumber?: number;
}

/** Operator input to a profile-level lever (#593): tick / pause / resume.
 *  `profile` omitted = every registered profile. */
export interface ProfileLeverInput extends OperatorFields {
  profile?: string;
}

/** Result of a profile-level lever (#593). */
export interface ProfileLeverResult extends OperatorActionResult {
  /** The profiles the lever was recorded against. */
  targets?: string[];
  /** All-profile lever: the profiles whose append failed (the rest were recorded). */
  failed?: string[];
  /** Extra context on an accepted request (e.g. a tick that was not started). */
  note?: string;
  /** `POST /tick`: a tick was started. */
  started?: boolean;
}

/** Operator input to a plain slice lever (#593): recover, merge, relaunch. */
export interface SliceLeverInput extends OperatorFields {
  profile: string;
  sliceId: string;
}

/** Operator input to the review-thread resend endpoint (#593). */
export interface ResendThreadsInput extends SliceLeverInput {
  /** Review thread ids to re-send; omitted = every unresolved thread. */
  threadIds?: string[];
}

/** Result of a review-thread resend (#593). */
export interface ResendThreadsResult extends OperatorActionResult {
  /** The /smithy.fix reached the steward session. */
  delivered?: boolean;
  threadIds?: string[];
  commentIds?: string[];
}

/** Operator input to the recover endpoint (#593): walk the recovery ladder. */
export type RecoverInput = SliceLeverInput;

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
  /** Who answered (#593 attribution). */
  operator?: string;
  /** Why (#593 attribution). */
  reason?: string;
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
  /** Request the graduated recovery ladder for a slice (#593). */
  readonly requestRecovery?: (input: RecoverInput) => Promise<OperatorActionResult>;
  /** Request an operator merge-now (#593). */
  readonly requestMerge?: (input: SliceLeverInput) => Promise<OperatorActionResult>;
  /** Request an operator steward relaunch (#593). */
  readonly requestRelaunch?: (input: SliceLeverInput) => Promise<OperatorActionResult>;
  /** Re-send review threads to the slice's steward (#593). */
  readonly resendReviewThreads?: (input: ResendThreadsInput) => Promise<ResendThreadsResult>;
  /** Run a tick now (#593). */
  readonly requestTick?: (input: ProfileLeverInput) => Promise<ProfileLeverResult>;
  /** Pause / resume fresh dispatch (#593). */
  readonly setDispatchPaused?: (input: ProfileLeverInput & { paused: boolean }) => Promise<ProfileLeverResult>;
  /** Environment the operator-token gate reads (defaults to process.env). */
  readonly env?: NodeJS.ProcessEnv;
}

/** The profile + sliceId an operator request targets (body/`?profile=` + path). */
function readTarget(request: FastifyRequest): { profile: string; sliceId: string; body: Record<string, unknown> } {
  const params = (request.params ?? {}) as Record<string, string | undefined>;
  const query = (request.query ?? {}) as Record<string, string | undefined>;
  const body = (request.body ?? {}) as Record<string, unknown>;
  const sliceId = typeof params.sliceId === "string" ? params.sliceId : "";
  const profile =
    (typeof body.profile === "string" && body.profile.length > 0 && body.profile) ||
    (typeof query.profile === "string" && query.profile.length > 0 && query.profile) ||
    "";
  return { profile, sliceId, body };
}

/** Parse the optional `operator` / `reason` attribution off a lever body (#593). */
export function readOperatorFields(body: Record<string, unknown>): { ok: true; fields: OperatorFields } | { ok: false; error: string } {
  // Herald's attribution limits (operator ≤128, note ≤1000, measured untrimmed):
  // checked here, before any lever side effect, so a lever never acts and then
  // fails to record who asked.
  const limits = { operator: 128, reason: 1000 } as const;
  for (const field of ["operator", "reason"] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      return { ok: false, error: `${field} must be a string.` };
    }
    if (typeof body[field] === "string" && (body[field] as string).length > limits[field]) {
      return { ok: false, error: `${field} must be at most ${limits[field]} characters.` };
    }
  }
  const operator = typeof body.operator === "string" ? body.operator.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  return { ok: true, fields: { ...(operator ? { operator } : {}), ...(reason ? { reason } : {}) } };
}

/** HTTP status for a lever result: 202 on success, else its hint (404 for unknowns). */
function leverStatus(result: OperatorActionResult, okStatus = 202): number {
  if (result.ok) return okStatus;
  return result.status ?? (/^unknown (profile|slice)/.test(result.error ?? "") ? 404 : 400);
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
    // Operator pause (#593): fresh dispatch is held until `POST /dispatch/resume`.
    dispatch_paused: r?.dispatch_paused === true,
    ...(r?.dispatch_paused === true
      ? { dispatch_paused_since: r?.dispatch_paused_since ?? null, dispatch_paused_reason: r?.dispatch_paused_reason ?? null }
      : {}),
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

/** The outcome of resolving a review-thread resend target (pure). */
export type ResendTarget =
  | {
      ok: true;
      /** The PR object to build the /smithy.fix message from. */
      pr: any;
      prNumber: number;
      threads: any[];
      threadIds: string[];
      commentIds: string[];
      sessionId: string;
    }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Resolve (and validate) a review-thread resend (#593). Pure + testable. Picks
 * the named threads (all unresolved when `threadIds` is omitted) from the fold's
 * PR observation — fresher than the warm record, which it falls back to — and
 * needs a steward session to deliver to. Unlike babysit it ignores the seen-set
 * and `needs_response`: re-sending already-sent threads is the point.
 */
export function resolveResendTarget(slice: any, observedPr: any, threadIds?: string[]): ResendTarget {
  if (slice?.stage === "merged") return { ok: false, status: 409, error: "slice is merged." };
  const observed = observedPr && !observedPr.skipped && observedPr.number ? observedPr : null;
  const pr = observed ?? slice?.pr ?? null;
  const prNumber = typeof pr?.number === "number" && pr.number > 0 ? pr.number : null;
  if (prNumber === null) return { ok: false, status: 409, error: "slice has no observed PR." };
  const unresolved: any[] = Array.isArray(observed?.unresolved_threads)
    ? observed.unresolved_threads
    : Array.isArray(slice?.unresolved_threads)
      ? slice.unresolved_threads
      : [];
  let threads = unresolved;
  if (threadIds) {
    const byId = new Map(unresolved.map((t) => [String(t?.id), t]));
    const unknown = threadIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      return {
        ok: false,
        status: 400,
        error: `unknown or resolved review thread(s) on PR #${prNumber}: ${unknown.join(", ")} (unresolved: ${[...byId.keys()].join(", ") || "none"}).`,
      };
    }
    threads = threadIds.map((id) => byId.get(id));
  }
  if (threads.length === 0) return { ok: false, status: 409, error: `PR #${prNumber} has no unresolved review threads to re-send.` };
  const sessionId = typeof slice?.worker_session_id === "string" ? slice.worker_session_id : "";
  if (!sessionId) return { ok: false, status: 409, error: "slice has no steward session — relaunch it first." };
  return {
    ok: true,
    pr,
    prNumber,
    threads,
    threadIds: threads.map((t) => String(t.id)),
    commentIds: [...new Set(threads.flatMap((t) => threadCommentIds(t)))],
    sessionId,
  };
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

  // Operator-token gate (#593): every non-GET route is an operator lever. The
  // token is read per request so a rotated secret takes effect without a restart.
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    const token = (ctx.env ?? process.env)[LEGATE_OPERATOR_TOKEN_ENV]?.trim();
    if (!token) return;
    if (!bearerMatches(request.headers.authorization, token)) {
      reply.code(401);
      return reply.send({ ok: false, error: `operator token required (Authorization: Bearer $${LEGATE_OPERATOR_TOKEN_ENV}).` });
    }
  });

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
    const { profile, sliceId, body } = readTarget(request);
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
    const attribution = readOperatorFields(body);
    if (!attribution.ok) {
      reply.code(400);
      return { ok: false, error: attribution.error };
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
      ...attribution.fields,
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
    const { profile, sliceId, body } = readTarget(request);
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
    const attribution = readOperatorFields(body);
    if (!attribution.ok) {
      reply.code(400);
      return { ok: false, error: attribution.error };
    }
    if (!ctx.requeueSlice) {
      reply.code(501);
      return { ok: false, error: "requeue is not available in this context." };
    }
    const result = await ctx.requeueSlice({
      profile,
      sliceId,
      closePr: body.closePr === true,
      ...(body.releaseMerged === true ? { releaseMerged: true } : {}),
      ...attribution.fields,
    });
    reply.code(leverStatus(result));
    return result;
  });

  // Operator RECOVER (#593): walk the graduated recovery ladder for one slice —
  // the least-destructive way out of an escalation. Moved here from a direct
  // Herald append so the request is authenticated and attributed like every
  // other lever. Appends `slice.recovery.requested` (with the operator on the
  // envelope); the next tick's recovery handler acts on it.
  registerSliceLever(app, "/slices/:sliceId/recover", "recover", ctx.requestRecovery);

  // Operator MERGE NOW (#593): squash-merge the slice's open PR on the next tick
  // (kicked off immediately), bypassing the review/CI gates but still pinned to
  // the head SHA re-read from GitHub. 409 for no PR / already merged / closed.
  // Replaces running `gh pr merge` out of band, so the merge is in the log.
  registerSliceLever(app, "/slices/:sliceId/merge", "merge", ctx.requestMerge);

  // Operator RELAUNCH (#593): replace the slice's steward — remove a still-live
  // session (worktree kept) and attach a fresh one to the preserved PR/branch,
  // bypassing the self-heal backoff. 409 for a merged / PR-less slice (use
  // requeue to start one over).
  registerSliceLever(app, "/slices/:sliceId/relaunch", "relaunch", ctx.requestRelaunch);

  // Operator RESEND REVIEW THREADS (#593): deliver /smithy.fix for the named
  // unresolved review threads (all, when `threadIds` is omitted) straight into
  // the live steward session — even threads the loop's dedup already counts as
  // sent, or that the steward answered without fixing. Synchronous like respond:
  // 200 once delivered; 400 for an unknown thread id; 409 when there is nothing
  // to send or no steward session; 502 when the send fails.
  registerSliceLever<ResendThreadsInput>(
    app,
    "/slices/:sliceId/review-threads/resend",
    "resend",
    ctx.resendReviewThreads,
    (body) => {
      if (body.threadIds === undefined) return { ok: true, fields: {} };
      if (!Array.isArray(body.threadIds) || body.threadIds.length === 0) {
        return { ok: false, error: "threadIds must be a non-empty array of thread ids (omit it to re-send every unresolved thread)." };
      }
      const ids = body.threadIds.map((id) => (typeof id === "number" || typeof id === "string" ? String(id).trim() : ""));
      if (ids.some((id) => id.length === 0)) return { ok: false, error: "threadIds must be non-empty strings or numbers." };
      return { ok: true, fields: { threadIds: [...new Set(ids)] } };
    },
    200,
  );

  // Profile-level levers (#593). `profile` (body or `?profile=`) narrows to one
  // profile; omitted = every registered profile.
  //   - POST /tick runs a tick now (409 while one is already in flight).
  //   - POST /dispatch/pause holds fresh dispatch (durable `dispatch.paused` in
  //     the fold, so a restart stays paused); in-flight spawns still drain and
  //     relaunch/babysit/merge/recovery keep running.
  //   - POST /dispatch/resume lifts it.
  registerProfileLever(app, "/tick", "tick", ctx.requestTick);
  registerProfileLever(app, "/dispatch/pause", "pause", ctx.setDispatchPaused && ((i) => ctx.setDispatchPaused!({ ...i, paused: true })));
  registerProfileLever(app, "/dispatch/resume", "resume", ctx.setDispatchPaused && ((i) => ctx.setDispatchPaused!({ ...i, paused: false })));

  return app;
}

/**
 * Register a plain slice lever (#593): `POST <path>` with `{profile?, operator?,
 * reason?}` plus any lever-specific fields `extra` parses. 400 on a bad body, 501
 * when the runtime effect is absent, else the effect's result (202 on success).
 */
function registerSliceLever<I extends OperatorFields & { profile: string; sliceId: string }>(
  app: FastifyInstance,
  routePath: string,
  label: string,
  effect: ((input: I) => Promise<OperatorActionResult>) | undefined,
  extra?: (body: Record<string, unknown>) => { ok: true; fields: Omit<I, "profile" | "sliceId" | "operator" | "reason"> } | { ok: false; error: string },
  okStatus = 202,
): void {
  app.post(routePath, async (request, reply) => {
    const { profile, sliceId, body } = readTarget(request);
    if (!profile) {
      reply.code(400);
      return { ok: false, error: "profile is required (body.profile or ?profile=)." };
    }
    if (!sliceId) {
      reply.code(400);
      return { ok: false, error: "sliceId path param is required." };
    }
    const attribution = readOperatorFields(body);
    if (!attribution.ok) {
      reply.code(400);
      return { ok: false, error: attribution.error };
    }
    const parsed = extra ? extra(body) : { ok: true as const, fields: {} };
    if (!parsed.ok) {
      reply.code(400);
      return { ok: false, error: parsed.error };
    }
    if (!effect) {
      reply.code(501);
      return { ok: false, error: `${label} is not available in this context.` };
    }
    const result = await effect({ ...parsed.fields, profile, sliceId, ...attribution.fields } as I);
    reply.code(leverStatus(result, okStatus));
    return result;
  });
}

/** Register a profile-level lever (#593): `POST <path>` with `{profile?, operator?, reason?}`. */
function registerProfileLever(
  app: FastifyInstance,
  routePath: string,
  label: string,
  effect: ((input: ProfileLeverInput) => Promise<ProfileLeverResult>) | undefined,
): void {
  app.post(routePath, async (request, reply) => {
    const { profile, body } = readTarget(request);
    // An omitted profile means "every profile"; a supplied but malformed one
    // must not silently widen to all of them.
    const query = (request.query ?? {}) as Record<string, unknown>;
    if (!profile && (body.profile !== undefined || query.profile !== undefined)) {
      reply.code(400);
      return { ok: false, error: "profile must be a non-empty string (omit it to target every profile)." };
    }
    const attribution = readOperatorFields(body);
    if (!attribution.ok) {
      reply.code(400);
      return { ok: false, error: attribution.error };
    }
    if (!effect) {
      reply.code(501);
      return { ok: false, error: `${label} is not available in this context.` };
    }
    const result = await effect({ ...(profile ? { profile } : {}), ...attribution.fields });
    reply.code(leverStatus(result));
    return result;
  });
}

/** Start the loop HTTP server on the given port (loopback by default). */
export async function startLoopHttpServer(
  ctx: LoopHttpContext,
  port: number,
  host = "127.0.0.1",
): Promise<FastifyInstance> {
  const app = buildLoopServer(ctx);
  if (!(ctx.env ?? process.env)[LEGATE_OPERATOR_TOKEN_ENV]?.trim()) {
    console.warn(
      `${LEGATE_OPERATOR_TOKEN_ENV} is unset — the Legate operator levers (POST routes) are unauthenticated; ` +
        "set it to require a bearer token.",
    );
  }
  await app.listen({ port, host });
  return app;
}
