import Fastify, { type FastifyInstance } from "fastify";
import type { LoopSnapshot } from "./runtime.js";

/**
 * HTTP API for the profile-agnostic Legate service, built on Fastify. The
 * legate-agent (a Claude conductor on the host) calls this to read loop state
 * deterministically rather than scraping logs. One container drives N profiles,
 * so `/status?profile=<p>` returns one profile's tick state and bare `/status`
 * returns the per-profile breakdown. Security model: the server binds `0.0.0.0`
 * inside the container so Docker's loopback port publish can reach it; the host
 * publishes only on loopback, so the API is never exposed beyond the host.
 */

export interface LoopHttpContext {
  readonly startedAtMs: number;
  readonly getSnapshot: () => LoopSnapshot;
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

/** Build the /status payload. With `profile`, that profile's status; else all. */
export function buildStatus(ctx: LoopHttpContext, profile?: string): Record<string, unknown> {
  const snap = ctx.getSnapshot();
  const tick = { lastTickAtMs: snap.lastTickAtMs, lastTickDurationMs: snap.lastTickDurationMs };
  if (profile) {
    const entry = snap.byProfile[profile];
    if (!entry) return { ok: false, error: `unknown profile "${profile}".`, profiles: snap.profiles };
    return { ok: true, profile, ...statusForRecord(entry.lastHeartbeat, tick) };
  }
  const byProfile: Record<string, unknown> = {};
  for (const p of snap.profiles) {
    byProfile[p] = statusForRecord(snap.byProfile[p].lastHeartbeat, tick);
  }
  return { ok: true, profiles: snap.profiles, by_profile: byProfile };
}

/** One entry in the /escalations interrogation payload — a task needing operator
 *  attention: either an escalated-stage slice OR a steward parked awaiting input. */
export interface EscalationEntry {
  /** The task — the slice id (encodes the smithy artifact/feature/slice). */
  task: string;
  /** The slice's PR branch, when known. */
  branch: string | null;
  /** The PR associated with the task (number + url), or null if none observed yet. */
  pr: { number: number | null; url: string | null } | null;
  /** Why it needs attention: the `escalated_reason` (e.g. `steward_stuck`), or
   *  `steward_awaiting_input` when the steward session is parked in `waiting`. */
  reason: string | null;
  /** True when the steward session is parked in `waiting` status (needs input) —
   *  a session-state signal independent of any GitHub state. */
  awaiting_input: boolean;
  /** The Castra/agent-deck session id — so the operator can attach and unblock it. */
  session_id: string | null;
  /** The steward's worktree path — where to attach / inspect. */
  worktree_path: string | null;
  /** Human-readable detail (the last action note, when escalated). */
  detail: string | null;
  /** When it entered the state (best-effort: escalation stamp or last action). */
  escalated_at: string | null;
}

/** Extract the tasks needing operator attention from a profile's working state
 *  (pure; testable): escalated-stage slices AND stewards parked awaiting input. */
export function escalationsForWorkingState(workingState: any): EscalationEntry[] {
  const slices = workingState?.slices;
  if (!slices || typeof slices !== "object") return [];
  const out: EscalationEntry[] = [];
  for (const [sliceId, s] of Object.entries(slices as Record<string, any>)) {
    if (!s || typeof s !== "object") continue;
    const isEscalated = s.stage === "escalated";
    const awaitingInput = s.steward_awaiting_input === true;
    if (!isEscalated && !awaitingInput) continue;
    const pr = s.pr;
    out.push({
      task: sliceId,
      branch: s.actual_branch ?? s.branch ?? null,
      pr: pr && (pr.number != null || pr.url != null) ? { number: pr.number ?? null, url: pr.url ?? null } : null,
      // An escalated slice keeps its escalated_reason; an otherwise-fine slice whose
      // steward is just parked surfaces as steward_awaiting_input.
      reason: isEscalated && typeof s.escalated_reason === "string" ? s.escalated_reason : awaitingInput ? "steward_awaiting_input" : null,
      awaiting_input: awaitingInput,
      session_id: s.worker_session_id ?? null,
      worktree_path: s.worktree_path ?? null,
      detail: typeof s.last_action_note === "string" ? s.last_action_note : awaitingInput ? "steward session parked in 'waiting' status — needs operator input" : null,
      escalated_at: s.steward_stuck_at ?? s.last_action ?? null,
    });
  }
  return out;
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
