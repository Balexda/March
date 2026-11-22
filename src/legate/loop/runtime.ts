/**
 * Legate runtime — the wiring layer of the containerized, profile-agnostic legate
 * service. ONE container drives N profiles: each tick lists the registered
 * profiles from Herald (the source of truth), drains the single multiplexed
 * Herald stream once, then runs the proven two-stage tick (sense → coordinator →
 * heartbeat) for EACH profile against its own isolated working state. Every
 * profile's tick is wrapped in its own try/catch so one bad repo (gh outage,
 * missing path) can't stall the others.
 *
 * The decision and effecting logic lives in the tested modules under
 * pure/ / state/ / handlers/ (they already take `meta` + deps as params, so they
 * are profile-agnostic); what remains here is composition: build the per-profile
 * deps, run the coordinator, schedule the interval.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordDwell,
  recordLoopHeartbeat,
  recordOperatorAction,
  recordReviewCaps,
  recordSpawnBudget,
  type OperatorAction,
} from "../../observability/loop-metrics.js";
import { stampDwell } from "./pure/dwell.js";
import { createServiceLogger, resolveServiceLogFilePath } from "../../observability/logger.js";
import { emitLoopLog } from "../../observability/logs.js";
import { emitLoopSpan } from "../../observability/loop-spans.js";
import {
  getJob,
  postSpawn,
  resolveHatcheryUrl,
} from "../../hatchery/service/client.js";
import { CastraClient } from "../../castra/client.js";
import { ProfileClient } from "../../herald/profiles/client.js";
import type { ProfileRecord } from "../../herald/profiles/types.js";
import { byDispatchPriority } from "../../herald/profiles/types.js";
import type { MergePolicy } from "../../herald/profiles/merge-policy.js";
import { legateStateDir, metaForProfileRecord } from "../profile-paths.js";
// Decomposed two-stage loop: Stage 1 sense → coordinator (ordered handlers) →
// heartbeat. runtime now only wires these to the proven I/O seams below.
import { rebuildWorkingState, senseFromHerald, type HeraldInbox } from "./state/sense.js";
import { createFoldDeps } from "./state/fold-deps.js";
import { execLegateGh, LegateGitHubError, requestCopilotReview } from "./clients/github.js";
import { LABEL_SPECS } from "./pure/pr-labels.js";
import { runTick as coordinatorRunTick } from "./coordinator.js";
import { resolveMaxConcurrentSpawns } from "./meta.js";
import { SpawnBreaker } from "./spawn-breaker.js";
import { createSpawnBudget, liveSpawnCount, taskTypeForSlice, type DispatchDecisionRow, type SpawnBudget } from "./pure/slice.js";
import { ReviewerBackoff, reviewSignals, verifyStartupIntent, type ReviewPostOutcome } from "./handlers/review-backoff.js";
import type { ReviewRequestHistory } from "./handlers/coderabbit-rereview.js";
import { reviewCapSamples, reviewRequestLimits } from "./pure/review-budget.js";
import { markedCodeRabbitHead } from "../../observe/coderabbit-review.js";
import { runHeartbeat } from "./heartbeat.js";
import { broodRegister as broodRegisterCli, broodRetire as broodRetireCli, broodTeardown as broodTeardownCli } from "./clients/brood.js";
import { LegateHerald, type OperatorAttribution } from "./clients/herald.js";
// Dispatch ops (ask Hatchery to spawn / poll a job to completion). The legate's
// effecting dispatch logic, behind the DispatchIoDeps seam built below. #144.
import type { DispatchIoDeps } from "./handlers/dispatch-io.js";
import {
  completePendingHatcheryDispatches,
  launchDispatch,
  recoverDispatch,
} from "./handlers/dispatch-ops.js";
// Legate-judgement requests (#144): event build + dedup + doorbell, behind
// injected I/O; runtime supplies the concrete sinks.
import { requestJudgement } from "./judgement.js";
// Loop domain → OTel payload mapping (#144): action events → spans/logs, and the
// heartbeat record → the loop-metrics activity. The OTel SDK wiring lives behind.
import { buildLoopTickActivity, emitActionEventLog, emitActionEventSpan, recordActionEventMetrics } from "./loop-telemetry.js";
// Cadence layer (#144): the re-entrancy guard + interval + tick timing. runtime
// supplies the tick body, error handler, and metrics flush.
import { createScheduler, type LoopScheduler } from "./scheduler.js";
import { reviewFixMessage } from "./pure/messages.js";
// Operator respond endpoint (#459 follow-up): the pure target resolver + I/O
// shapes; runtime supplies the Castra/Herald effects below. http.ts imports only
// the LoopSnapshot TYPE from here, so this value import is a one-way edge.
import {
  resolveRequeueTarget,
  resolveResendTarget,
  resendStillCurrent,
  relaunchGeneration,
  resolveRespondTarget,
  type OperatorActionResult,
  type OperatorFields,
  type ProfileLeverInput,
  type ProfileLeverResult,
  type RecoverInput,
  type RequeueInput,
  type SliceLeverInput,
  type RequeueResult,
  type ResendThreadsInput,
  type ResendThreadsResult,
  type RespondInput,
  type RespondResult,
} from "./http.js";

// ── Container-wide singletons (shared across all profiles) ──────────────────

// Lazily-built async Castra client (constructed on first use so it reads the
// CASTRA_URL/token env the container passes in). Profile is a per-call arg.
let _castra: CastraClient | undefined;
function castra(): CastraClient {
  return (_castra ??= new CastraClient());
}

// The single Herald inbox/write client (#175, #176). ONE cursor over the ONE
// multiplexed (all-profiles) event stream — built lazily so it reads
// MARCH_HERALD_URL. The per-profile fold is read via herald.snapshotFor(profile).
let _herald: LegateHerald | undefined;
function legateHerald(): LegateHerald {
  return (_herald ??= new LegateHerald({ stateDir: legateStateDir(homeDir), env }));
}

// ── Per-profile runtime state ───────────────────────────────────────────────

interface ProfileRuntime {
  /** The loose LoopMeta the runtime + handlers consume (paths/repo/profile/…). */
  meta: any;
  /** In-memory working state (the former state.json `raw`), threaded across ticks
   *  for THIS profile; rebuilt from the profile's Herald fold on cold start. */
  workingState: any;
  /** Latest heartbeat record for this profile (HTTP /status + metric gauges). */
  lastHeartbeat: any;
  /** The profile's per-task-type merge policy, refreshed from the registry each
   *  tick (undefined = all merge requirements enforced). */
  mergePolicy?: MergePolicy;
  /** This profile's latest per-item dispatch decisions (#592), for `GET /queue`.
   *  In memory only — never written to the heartbeat ndjson. */
  lastDispatch?: DispatchSnapshot | null;
}

/** The latest tick's per-item dispatch decisions for one profile (#592). */
export interface DispatchSnapshot {
  readonly at: string;
  /** False when smithy could not be read this tick (no rows then). */
  readonly smithyOk: boolean;
  readonly items: readonly DispatchDecisionRow[];
  /** The plan checkout's last-known default-branch sync status (Herald fold), or null. */
  readonly checkout: unknown;
}

const runtimes = new Map<string, ProfileRuntime>();

/** Build (or refresh the meta of) a profile's runtime context. */
function runtimeFor(rec: ProfileRecord): ProfileRuntime {
  const meta = metaForProfileRecord(rec, { homeDir, env });
  let rt = runtimes.get(rec.profile);
  if (!rt) {
    rt = { meta, workingState: null, lastHeartbeat: null, mergePolicy: rec.mergePolicy };
    runtimes.set(rec.profile, rt);
  } else {
    rt.meta = meta; // pick up registry edits (repo path / worker group / …)
    rt.mergePolicy = rec.mergePolicy; // pick up live merge-policy edits each tick
  }
  return rt;
}

// ── Injected at startup by configureLoopRuntime() ───────────────────────────
let profileClient: ProfileClient;
let intervalSeconds = 60;
let homeDir: string = os.homedir();
let env: NodeJS.ProcessEnv = process.env;
// The GLOBAL concurrent-spawn cap (#313): one budget shared across ALL profiles on
// this single legate container. Resolved from MARCH_MAX_CONCURRENT_SPAWNS at
// startup (configureLoopRuntime), default 10.
let maxConcurrentSpawns = resolveMaxConcurrentSpawns(env);

// The agent-health circuit-breaker (#codex-down backpressure): collapses the
// effective spawn cap to 0 when the agent is hard-down (e.g. codex auth expired)
// so the loop stops flooding doomed spawns, periodically probing for recovery.
// Module-level: the cap is global across all profiles, so the breaker is too.
const spawnBreaker = new SpawnBreaker();
// Reported breaker state, so a trip/recover is logged once on the edge.
let lastBreakerOpen = false;

// The cadence driver, built lazily on first start/tick (after configureLoopRuntime
// has set the interval). Owns the re-entrancy guard, the interval, and tick timing.
let _scheduler: LoopScheduler | undefined;
function scheduler(): LoopScheduler {
  return (_scheduler ??= createScheduler({
    tick,
    onTickError: logTickError,
    onTickComplete: () => {},
    intervalSeconds,
  }));
}

/** Wire the runtime to the profile registry + tick interval. Call once before start. */
export function configureLoopRuntime(opts: {
  profileClient: ProfileClient;
  intervalSeconds: number;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  profileClient = opts.profileClient;
  intervalSeconds = opts.intervalSeconds;
  if (opts.homeDir) homeDir = opts.homeDir;
  if (opts.env) env = opts.env;
  maxConcurrentSpawns = resolveMaxConcurrentSpawns(env);
}

export interface LoopSnapshot {
  /** Per-profile latest heartbeat record + live working state (the in-memory
   *  `raw` for that profile, whose `slices` carry per-slice stage/PR/escalation —
   *  the source for the /escalations interrogation endpoint). */
  readonly byProfile: Record<string, { lastHeartbeat: any; workingState: any; lastDispatch?: DispatchSnapshot | null }>;
  readonly profiles: string[];
  readonly lastTickAtMs: number;
  readonly lastTickDurationMs: number;
  /** Back-compat: an arbitrary profile's heartbeat (first registered). */
  readonly lastHeartbeat: any;
}

/** Latest tick snapshot, consumed by the HTTP /status + /escalations endpoints. */
export function getLoopSnapshot(): LoopSnapshot {
  const byProfile: Record<string, { lastHeartbeat: any; workingState: any; lastDispatch?: DispatchSnapshot | null }> = {};
  for (const [profile, rt] of runtimes)
    byProfile[profile] = { lastHeartbeat: rt.lastHeartbeat, workingState: rt.workingState, lastDispatch: rt.lastDispatch ?? null };
  const profiles = Object.keys(byProfile);
  return {
    byProfile,
    profiles,
    lastTickAtMs: _scheduler?.lastTickAtMs ?? 0,
    lastTickDurationMs: _scheduler?.lastTickDurationMs ?? 0,
    lastHeartbeat: profiles.length > 0 ? byProfile[profiles[0]].lastHeartbeat : null,
  };
}

/** Run a single tick immediately (used by start + future /tick endpoint). */
export async function runTickOnce(): Promise<void> {
  await scheduler().runOnce();
}

/** Bound an operator note posted into the fold as a steward-report summary. */
function clampReportSummary(text: string, max = 500): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

/**
 * Effect an operator's response to a slice escalated as `steward_awaiting_input`
 * — the side-effecting half of POST /escalations/:sliceId/respond (the routing +
 * validation live in http.ts; this needs the Castra/Herald singletons). Modes:
 *
 *   - **answer** (`message`): deliver the answer into the live steward session
 *     via Castra, then clear the latch.
 *   - **ack** (no message): clear the latch only — explicitly release a steward
 *     the operator judges is not really blocked (finished / awaiting merge / open
 *     review threads) without sending an answer.
 *
 * This is the operator lever for a steward held on a LIVE session — the relaunch
 * self-heal already drains a `steward_awaiting_input` slice automatically once its
 * session has VANISHED (HUMAN_HOLD_REASONS, relaunch.ts), so respond is for the
 * case the auto path deliberately leaves alone (a live prompt the operator must
 * resolve) plus immediate manual override.
 *
 * Clearing posts a NON-awaiting `slice.steward.report` to Herald; on the next tick
 * babysit sees `!awaitingNow`, drops the `steward_awaiting_input` latch, and
 * resumes normal PR handling (the /smithy.fix + merge path) for that slice.
 */
export async function respondToEscalation(input: RespondInput): Promise<RespondResult> {
  const profile = input.profile;
  // Emit a `legate.respond` child span + a slice-correlated log for every outcome
  // so this operator lifecycle action (and its send/clear failure modes) is
  // visible in the slice trace (AGENTS.md observability requirement). The span
  // nests on the slice's deterministic id like the other lifecycle actions.
  const finish = (result: RespondResult): RespondResult => {
    emitLoopSpan({
      name: "legate.respond",
      traceKey: input.sliceId,
      root: false,
      error: !result.ok,
      attributes: {
        "march.slice_id": input.sliceId,
        "march.profile": profile,
        "march.respond.mode": result.mode ?? "unknown",
        "march.respond.delivered": result.delivered ?? false,
        "march.respond.cleared": result.cleared ?? false,
        "march.respond.recovery_requested": result.recoveryRequested ?? false,
        "march.operator": operatorOf(input),
      },
    });
    recordOperatorAction("respond", result.ok ? "accepted" : "refused");
    emitLoopLog({
      severity: result.ok ? "INFO" : "ERROR",
      body: result.ok
        ? `respond ${result.mode} for ${input.sliceId}: delivered=${result.delivered ?? false} cleared=${result.cleared ?? false} recovery_requested=${result.recoveryRequested ?? false}`
        : `respond failed for ${input.sliceId}: ${result.error ?? "unknown error"}`,
      eventKind: "respond",
      sliceId: input.sliceId,
      attributes: {
        "march.profile": profile,
        "march.respond.mode": result.mode ?? "unknown",
      },
    });
    return result;
  };

  const rt = runtimes.get(profile);
  if (!rt) return finish({ ok: false, error: `unknown profile "${profile}".`, profiles: [...runtimes.keys()] });

  const target = resolveRespondTarget(rt.workingState, input.sliceId);
  if (!target.ok) return finish({ ok: false, profile, sliceId: input.sliceId, error: target.error });

  const message = input.message?.trim();
  const mode: "answer" | "ack" = message ? "answer" : "ack";
  let delivered = false;

  if (mode === "answer") {
    if (!target.sessionId) {
      return finish({
        ok: false,
        profile,
        sliceId: input.sliceId,
        mode,
        error: `slice "${input.sliceId}" has no steward session to deliver the answer to — use { "ack": true } to clear it back to babysit handling instead.`,
      });
    }
    try {
      await sendAgentDeckMessage(rt.meta, target.sessionId, message!, input.sliceId);
      delivered = true;
    } catch (err: any) {
      return finish({
        ok: false,
        profile,
        sliceId: input.sliceId,
        mode,
        delivered: false,
        error: `failed to deliver the answer to session ${target.sessionId}: ${err?.message ?? String(err)} — the steward session may be gone; try { "ack": true }.`,
      });
    }
  }

  const summary =
    mode === "answer"
      ? clampReportSummary(`operator answer via respond API: ${message}`)
      : "operator marked read via respond API (returned to babysit handling).";
  // 1. Flip the steward report to a NON-awaiting status. This clears the
  //    dashboard's `steward_awaiting_input` and, crucially, lifts the recovery
  //    ladder's rung-0b refusal (recovery.ts refuses to touch a slice whose
  //    report is `awaiting_input`).
  try {
    await legateHerald().stewardReport(profile, {
      sliceId: input.sliceId,
      status: "working",
      classified: true,
      summary,
    });
  } catch (err: any) {
    return finish({
      ok: false,
      profile,
      sliceId: input.sliceId,
      mode,
      delivered,
      cleared: false,
      error: `${mode === "answer" ? "answer delivered, but " : ""}failed to clear the steward report: ${err?.message ?? String(err)}`,
    });
  }
  // 2. Drive the graduated recovery ladder so the slice actually LEAVES the
  //    `escalated` stage. The report flip alone is insufficient: babysit skips a
  //    slice whose session is dead (`if (!worker) continue`), which is exactly
  //    the state these false positives sit in after a restart. The recovery
  //    ladder (now un-refused by step 1) un-escalates least-destructively —
  //    relaunch re-attaches a fresh steward to the preserved worktree for an
  //    open PR — handing the slice back to babysit's PR (fix + merge) path.
  let recoveryRequested = false;
  try {
    await legateHerald().append(
      profile,
      { type: "slice.recovery.requested", sliceId: input.sliceId },
      attributionOf(input, `respond ${mode}`),
    );
    recoveryRequested = true;
  } catch (err: any) {
    return finish({
      ok: false,
      profile,
      sliceId: input.sliceId,
      mode,
      delivered,
      cleared: true,
      recoveryRequested: false,
      error: `report cleared, but failed to request recovery (the slice may stay escalated): ${err?.message ?? String(err)}`,
    });
  }
  return finish({ ok: true, profile, sliceId: input.sliceId, mode, delivered, cleared: true, recoveryRequested });
}

/**
 * Request an operator REQUEUE (#588/#593) — the side-effecting half of
 * `POST /slices/:sliceId/requeue`. Validates the target against the profile's
 * warm working state (refusing an unknown / merged slice, or an open PR without
 * `closePr`), then appends `slice.requeue.requested` to Herald with the operator +
 * reason. It mutates nothing in memory: the requeue handler acts on the folded
 * request at the start of the next tick (tear down, tombstone, re-dispatch).
 */
export async function requeueSlice(input: RequeueInput): Promise<RequeueResult> {
  const profile = input.profile;
  const finish = (result: RequeueResult): RequeueResult => {
    emitLoopSpan({
      name: "legate.requeue.request",
      traceKey: input.sliceId,
      root: false,
      error: !result.ok,
      attributes: {
        "march.slice_id": input.sliceId,
        "march.profile": profile,
        "march.requeue.close_pr": input.closePr === true,
        "march.requeue.release_merged": input.releaseMerged === true,
        "march.requeue.requested": result.requested ?? false,
        "march.operator": operatorOf(input),
      },
    });
    recordOperatorAction("requeue", result.ok ? "accepted" : "refused");
    emitLoopLog({
      severity: result.ok ? "INFO" : "ERROR",
      body: result.ok
        ? `requeue requested for ${input.sliceId}${input.operator ? ` by ${input.operator}` : ""}${result.closesPr ? ` (closing PR #${result.closesPr})` : ""}`
        : `requeue refused for ${input.sliceId}: ${result.error ?? "unknown error"}`,
      eventKind: "requeue",
      sliceId: input.sliceId,
      attributes: { "march.profile": profile },
    });
    return result;
  };

  const rt = runtimes.get(profile);
  if (!rt) return finish({ ok: false, status: 404, error: `unknown profile "${profile}".`, profiles: [...runtimes.keys()] });

  const target = resolveRequeueTarget(rt.workingState, input.sliceId, input.closePr === true, undefined, input.releaseMerged === true);
  if (!target.ok) return finish({ ok: false, status: target.status, profile, sliceId: input.sliceId, error: target.error });

  try {
    await legateHerald().append(profile, {
      type: "slice.requeue.requested",
      sliceId: input.sliceId,
      closePr: input.closePr === true,
      ...(input.releaseMerged === true ? { releaseMerged: true } : {}),
      ...(input.operator ? { operator: input.operator } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    }, attributionOf(input));
  } catch (err: any) {
    return finish({
      ok: false,
      status: 502,
      profile,
      sliceId: input.sliceId,
      error: `failed to record the requeue request in Herald: ${err?.message ?? String(err)}`,
    });
  }
  return finish({
    ok: true,
    profile,
    sliceId: input.sliceId,
    requested: true,
    closesPr: target.openPr,
    ...(target.archived ? { releasesArchive: target.archived } : {}),
  });
}

// ── Operator levers (#593) ──────────────────────────────────────────────────
// Every lever validates against the profile's warm working state, appends ONE
// attributed request event to Herald (the operator on the envelope), and lets the
// tick act on the folded request — so the log shows the operator's ask next to
// the loop's response, and a restart re-reads any request not yet acted on.

/** The operator name stamped on the envelope ("unknown" when the caller gave none). */
function operatorOf(input: OperatorFields): string {
  return input.operator?.trim() || "unknown";
}

/** Envelope attribution for an operator lever: who asked, and why. */
function attributionOf(input: OperatorFields, fallbackNote?: string): OperatorAttribution {
  const note = input.reason?.trim() || fallbackNote;
  return { operator: operatorOf(input), ...(note ? { note } : {}) };
}

/**
 * Emit the span, log and metric for an operator lever outcome (#593). The span is
 * `legate.operator.<action>` on the slice trace (a child, never root), errored on
 * refusal; profile-level levers (tick/pause/resume) have no slice and emit a root
 * span instead.
 */
function finishOperatorAction<R extends OperatorActionResult>(
  action: OperatorAction,
  input: OperatorFields & { profile?: string; sliceId?: string },
  result: R,
  attributes: Record<string, string | number | boolean> = {},
): R {
  const sliceId = input.sliceId;
  emitLoopSpan({
    name: `legate.operator.${action}`,
    traceKey: sliceId ?? `operator:${action}:${Date.now()}`,
    root: !sliceId,
    error: !result.ok,
    attributes: {
      ...(sliceId ? { "march.slice_id": sliceId } : {}),
      ...(input.profile ? { "march.profile": input.profile } : {}),
      "march.operator": operatorOf(input),
      "march.operator.action": action,
      ...(result.status ? { "http.status_code": result.status } : {}),
      ...attributes,
    },
  });
  recordOperatorAction(action, result.ok ? "accepted" : "refused");
  emitLoopLog({
    severity: result.ok ? "INFO" : "ERROR",
    body: result.ok
      ? `operator ${action}${sliceId ? ` for ${sliceId}` : ""} by ${operatorOf(input)}`
      : `operator ${action}${sliceId ? ` for ${sliceId}` : ""} refused: ${result.error ?? "unknown error"}`,
    eventKind: "operator_action",
    ...(sliceId ? { sliceId } : {}),
    attributes: { ...(input.profile ? { "march.profile": input.profile } : {}), "march.operator.action": action },
  });
  return result;
}

/** Look up a profile's runtime + a slice in its warm state, or a 404 refusal. */
function sliceTarget(
  input: { profile: string; sliceId: string },
): { ok: true; rt: ProfileRuntime; slice: any } | { ok: false; result: OperatorActionResult } {
  const rt = runtimes.get(input.profile);
  if (!rt) {
    return { ok: false, result: { ok: false, status: 404, error: `unknown profile "${input.profile}".`, profiles: [...runtimes.keys()] } };
  }
  const slices = rt.workingState?.slices;
  // Own entries only: `__proto__` / `constructor` must not resolve to an inherited object.
  const slice = slices && Object.hasOwn(slices, input.sliceId) ? slices[input.sliceId] : undefined;
  if (!slice || typeof slice !== "object") {
    return { ok: false, result: { ok: false, status: 404, profile: input.profile, sliceId: input.sliceId, error: `unknown slice "${input.sliceId}".` } };
  }
  return { ok: true, rt, slice };
}

/** Append an attributed request event, mapping a Herald failure to a 502 refusal. */
async function appendOperatorRequest(
  input: OperatorFields & { profile: string; sliceId?: string },
  event: Parameters<LegateHerald["append"]>[1],
  what: string,
): Promise<OperatorActionResult | null> {
  try {
    await legateHerald().append(input.profile, event, attributionOf(input));
    return null;
  } catch (err: any) {
    return {
      ok: false,
      status: 502,
      profile: input.profile,
      ...(input.sliceId ? { sliceId: input.sliceId } : {}),
      error: `failed to record the ${what} request in Herald: ${err?.message ?? String(err)}`,
    };
  }
}

/**
 * The registered profiles a profile-level lever targets: the named one (404 if it
 * is not registered), else every registered profile. The registry — not the warm
 * runtimes map — is the source of truth, so a lever works before the first tick.
 */
async function leverProfiles(input: ProfileLeverInput): Promise<{ ok: true; profiles: string[] } | { ok: false; result: ProfileLeverResult }> {
  let registered: string[];
  try {
    registered = (await profileClient.list()).map((p) => p.profile);
  } catch (err: any) {
    return { ok: false, result: { ok: false, status: 502, error: `failed to list profiles from Herald: ${err?.message ?? String(err)}` } };
  }
  if (input.profile) {
    if (!registered.includes(input.profile)) {
      return { ok: false, result: { ok: false, status: 404, error: `unknown profile "${input.profile}".`, profiles: registered } };
    }
    return { ok: true, profiles: [input.profile] };
  }
  if (registered.length === 0) return { ok: false, result: { ok: false, status: 404, error: "no profiles are registered." } };
  return { ok: true, profiles: registered };
}

/**
 * Append one attributed profile-level event per target profile. Every target is
 * attempted — one profile's Herald failure must not leave the rest unrecorded —
 * and a partial failure reports which profiles were recorded (`targets`) and
 * which were not (`failed`). A single-profile failure keeps its own error.
 */
async function appendProfileLever(
  input: ProfileLeverInput,
  targets: string[],
  event: Parameters<LegateHerald["append"]>[1],
  what: string,
): Promise<ProfileLeverResult | null> {
  const recorded: string[] = [];
  const failures: { profile: string; result: OperatorActionResult }[] = [];
  for (const profile of targets) {
    const failed = await appendOperatorRequest({ ...input, profile }, event, what);
    if (failed) failures.push({ profile, result: failed });
    else recorded.push(profile);
  }
  if (failures.length === 0) return null;
  if (targets.length === 1) return failures[0].result;
  return {
    ok: false,
    status: 502,
    targets: recorded,
    failed: failures.map((f) => f.profile),
    error:
      `${what} recorded for ${recorded.length ? recorded.join(", ") : "no profile"}; failed for ` +
      failures.map((f) => `${f.profile} (${f.result.error ?? "unknown error"})`).join(", "),
  };
}

/**
 * Operator TICK NOW (#593): run a tick immediately instead of waiting for the
 * interval. Refused (409) while a tick is already in flight — that tick picks up
 * any pending request anyway. Records `legate.tick.requested` per target profile.
 */
export async function requestTick(input: ProfileLeverInput): Promise<ProfileLeverResult> {
  if (scheduler().ticking) {
    return finishOperatorAction("tick", input, { ok: false, status: 409, started: false, error: "a tick is already in progress." });
  }
  const targets = await leverProfiles(input);
  if (!targets.ok) return finishOperatorAction("tick", input, targets.result);
  const reason = input.reason ? { reason: input.reason } : {};
  const failed = await appendProfileLever(input, targets.profiles, { type: "legate.tick.requested", ...reason }, "tick");
  if (failed) return finishOperatorAction("tick", input, failed);
  // A tick may have started while the request was being recorded. The
  // scheduler's guard is synchronous, so `ticking` right before runOnce is its
  // admission result; a skipped tick is reported as such (the in-flight tick or
  // the next one picks the request up).
  const started = !scheduler().ticking;
  void scheduler().runOnce();
  return finishOperatorAction("tick", input, {
    ok: true,
    requested: true,
    started,
    targets: targets.profiles,
    ...(started ? {} : { note: "a tick was already in progress; the request is recorded and the next tick runs on schedule." }),
  });
}

/**
 * Operator PAUSE / RESUME dispatch (#593). Appends `dispatch.paused` /
 * `dispatch.resumed` per target profile; the fold's durable `dispatchPaused`
 * makes the dispatch handler launch nothing new from the next tick on.
 */
export async function setDispatchPaused(input: ProfileLeverInput & { paused: boolean }): Promise<ProfileLeverResult> {
  const action = input.paused ? "pause" : "resume";
  const targets = await leverProfiles(input);
  if (!targets.ok) return finishOperatorAction(action, input, targets.result);
  const reason = input.reason ? { reason: input.reason } : {};
  const failed = await appendProfileLever(
    input,
    targets.profiles,
    { type: input.paused ? "dispatch.paused" : "dispatch.resumed", ...reason },
    action,
  );
  if (failed) return finishOperatorAction(action, input, failed);
  return finishOperatorAction(action, input, { ok: true, requested: true, targets: targets.profiles });
}

/** The slice's PR number + state: Herald's observation first (fresher), else the warm record. */
function observedPr(profile: string, sliceId: string, slice: any): { number: number | null; state: string | null } {
  const observed = legateHerald().snapshotFor(profile)?.slices?.[sliceId]?.pr as any;
  const pr = observed && !observed.skipped && observed.number ? observed : slice?.pr;
  const n = pr?.number;
  return {
    number: typeof n === "number" && n > 0 ? n : null,
    state: typeof pr?.state === "string" ? pr.state.toUpperCase() : null,
  };
}

/**
 * Operator MERGE NOW (#593): request a squash-merge of the slice's open PR,
 * bypassing the review/CI gates (the merge still pins the head SHA it re-reads).
 * Appends `slice.merge.requested`; the merge-now handler acts on it. A tick is
 * kicked off right away (best-effort) so the merge does not wait for the interval.
 */
export async function requestMerge(input: SliceLeverInput): Promise<OperatorActionResult> {
  const target = sliceTarget(input);
  if (!target.ok) return finishOperatorAction("merge", input, target.result);
  const pr = observedPr(input.profile, input.sliceId, target.slice);
  const refuse = (status: number, error: string) =>
    finishOperatorAction("merge", input, { ok: false, status, profile: input.profile, sliceId: input.sliceId, error });
  if (pr.number === null) return refuse(409, `slice "${input.sliceId}" has no PR to merge.`);
  if (pr.state === "MERGED" || target.slice.stage === "merged") return refuse(409, `slice "${input.sliceId}" PR #${pr.number} is already merged.`);
  if (pr.state === "CLOSED") return refuse(409, `slice "${input.sliceId}" PR #${pr.number} is closed.`);
  const reason = input.reason ? { reason: input.reason } : {};
  const failed = await appendOperatorRequest(input, { type: "slice.merge.requested", sliceId: input.sliceId, prNumber: pr.number, ...reason }, "merge");
  if (failed) return finishOperatorAction("merge", input, failed);
  void scheduler().runOnce();
  return finishOperatorAction(
    "merge",
    input,
    { ok: true, profile: input.profile, sliceId: input.sliceId, requested: true, prNumber: pr.number },
    { "march.pr_number": pr.number },
  );
}

/**
 * Operator RELAUNCH (#593): replace the slice's steward — remove a still-live
 * session (keeping its worktree) and attach a fresh one to the preserved PR and
 * branch, bypassing the self-heal backoff. Appends `slice.relaunch.requested`;
 * the relaunch handler acts on it (a tick is kicked off right away). An errored
 * session can also be restarted IN PLACE by castra-recover; this is the lever for
 * a steward that is alive but wedged or misbehaving.
 */
export async function requestRelaunch(input: SliceLeverInput): Promise<OperatorActionResult> {
  const target = sliceTarget(input);
  if (!target.ok) return finishOperatorAction("relaunch", input, target.result);
  const slice = target.slice;
  const pr = observedPr(input.profile, input.sliceId, slice);
  const refuse = (error: string) =>
    finishOperatorAction("relaunch", input, { ok: false, status: 409, profile: input.profile, sliceId: input.sliceId, error });
  if (slice.stage === "merged" || pr.state === "MERGED") return refuse(`slice "${input.sliceId}" is merged — there is no steward to relaunch.`);
  if (slice.stage === "hatchery-pending") return refuse(`slice "${input.sliceId}" has a spawn in progress (hatchery-pending).`);
  // Same PR source as the relaunch handler (the warm `slice.pr`), so an accepted
  // request is never one the handler then refuses for lacking a PR.
  const warmPr = typeof slice.pr?.number === "number" && slice.pr.number > 0 ? slice.pr.number : null;
  if (warmPr === null || typeof slice.branch !== "string" || slice.branch.length === 0) {
    return refuse(`slice "${input.sliceId}" has no PR and branch to re-attach a steward to — use requeue to start it over.`);
  }
  const reason = input.reason ? { reason: input.reason } : {};
  const failed = await appendOperatorRequest(input, { type: "slice.relaunch.requested", sliceId: input.sliceId, ...reason }, "relaunch");
  if (failed) return finishOperatorAction("relaunch", input, failed);
  void scheduler().runOnce();
  return finishOperatorAction("relaunch", input, { ok: true, profile: input.profile, sliceId: input.sliceId, requested: true, prNumber: warmPr });
}

/**
 * Operator RESEND REVIEW THREADS (#593): deliver `/smithy.fix` for chosen
 * unresolved review threads straight into the live steward session. This is the
 * lever the dedup keys otherwise block: babysit never re-sends a thread whose
 * comments are already in the seen-set, nor one the steward answered without
 * fixing (`threadsNeedingResponse` drops a thread whose last word is March's).
 *
 * Synchronous like respond (the operator learns at once whether it reached the
 * steward). On success it records the dispatch exactly like babysit's review-fix
 * — comment ids seen, per-thread round counted, dispatch context marked so the
 * bounded post-dispatch nudge applies — and appends the same attributed
 * `slice.stage.changed {handledFeedback}` so a restart restores it.
 */
export async function resendReviewThreads(input: ResendThreadsInput): Promise<ResendThreadsResult> {
  const target = sliceTarget(input);
  if (!target.ok) return finishOperatorAction("resend_threads", input, target.result);
  const { rt, slice } = target;
  const refuse = (status: number, error: string) =>
    finishOperatorAction("resend_threads", input, { ok: false, status, profile: input.profile, sliceId: input.sliceId, error });
  const observed = legateHerald().snapshotFor(input.profile)?.slices?.[input.sliceId]?.pr;
  const resolved = resolveResendTarget(slice, observed, input.threadIds);
  if (!resolved.ok) return refuse(resolved.status, resolved.error);
  const { pr, prNumber, threads, threadIds, commentIds, sessionId } = resolved;
  const generation = relaunchGeneration(slice);
  try {
    await sendAgentDeckMessage(rt.meta, sessionId, reviewFixMessage(pr, threads), input.sliceId);
  } catch (err: any) {
    return finishOperatorAction(
      "resend_threads",
      input,
      { ok: false, status: 502, profile: input.profile, sliceId: input.sliceId, error: `failed to deliver /smithy.fix to session ${sessionId}: ${err?.message ?? String(err)} — relaunch the steward and retry.` },
      { "march.failure_stage": "delivery" },
    );
  }

  // The tick may have requeued the slice during the send (a new warm entry under
  // the same id) or relaunched its steward (a new worker_session_id in place).
  // Recording now would mark the old comment ids handled for a steward that never
  // got them, so refuse to record.
  if (!resendStillCurrent(rt.workingState?.slices?.[input.sliceId], slice, sessionId, generation)) {
    return finishOperatorAction(
      "resend_threads",
      input,
      {
        ok: false,
        status: 409,
        profile: input.profile,
        sliceId: input.sliceId,
        delivered: true,
        threadIds,
        commentIds,
        error: `delivered to session ${sessionId}, but the slice was requeued or its steward relaunched while sending — not recorded; re-send to reach the new steward.`,
      },
      { "march.failure_stage": "incarnation" },
    );
  }

  // Record it like babysit's review-fix so dedup, the round cap and the bounded
  // post-dispatch nudge all see this dispatch.
  const ts = now();
  const key = ["operator-resend", prNumber, [...commentIds].sort().join(",")].join(":");
  const seen = new Set<string>((slice.review_fix_seen_comment_ids || []).map((id: any) => String(id)));
  for (const id of commentIds) seen.add(id);
  slice.review_fix_seen_comment_ids = [...seen];
  const rounds: Record<string, number> = slice.review_fix_rounds || (slice.review_fix_rounds = {});
  for (const id of threadIds) rounds[id] = (rounds[id] || 0) + 1;
  delete slice.review_fix_escalated_at;
  if (slice.stage === "pr-open") slice.stage = "pr-in-fix";
  slice.last_processor_action = "review-fix";
  slice.last_processor_action_key = key;
  slice.last_processor_action_at = ts;
  slice.last_action = ts;
  slice.last_action_note = `operator re-sent ${threadIds.length} review thread(s) as /smithy.fix`;

  const recorded = await appendOperatorRequest(
    input,
    {
      type: "slice.stage.changed",
      sliceId: input.sliceId,
      stage: String(slice.stage),
      handledFeedback: { kind: "inline", commentIds, dispatchKey: key },
    },
    "resend",
  );
  const base = { profile: input.profile, sliceId: input.sliceId, delivered: true, threadIds, commentIds };
  if (recorded) {
    // Delivered, but the fold did not record it: report the partial outcome.
    return finishOperatorAction("resend_threads", input, { ...base, ok: false, status: 502, error: `delivered, but ${recorded.error}` }, { "march.failure_stage": "record" });
  }
  return finishOperatorAction("resend_threads", input, { ...base, ok: true }, { "march.pr_number": prNumber, "march.threads": threadIds.length });
}

/**
 * Operator RECOVER (#593): request the graduated recovery ladder for a slice —
 * the side-effecting half of `POST /slices/:sliceId/recover`. Appends an
 * attributed `slice.recovery.requested`; the recovery handler walks the ladder
 * from the next tick.
 */
export async function requestRecovery(input: RecoverInput): Promise<OperatorActionResult> {
  const target = sliceTarget(input);
  if (!target.ok) return finishOperatorAction("recover", input, target.result);
  const failed = await appendOperatorRequest(input, { type: "slice.recovery.requested", sliceId: input.sliceId }, "recovery");
  if (failed) return finishOperatorAction("recover", input, failed);
  return finishOperatorAction("recover", input, { ok: true, profile: input.profile, sliceId: input.sliceId, requested: true });
}

function now() {
  return new Date().toISOString();
}

function append(meta: any, file: string, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf-8");
  if (file === meta.processor_events_path) {
    emitActionEventSpan(value);
    emitActionEventLog(value);
    recordActionEventMetrics(value);
  }
}

function appendText(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text + "\n", "utf-8");
  console.log(text);
}

// Heartbeat path: writes to disk for liveness checks but does NOT echo to
// stdout. The conductor tmux session would otherwise drown out real events
// with one heartbeat line per tick.
function appendTextSilent(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text + "\n", "utf-8");
}

async function sendAgentDeckMessage(meta: any, sessionId: string, message: string, traceKey?: string) {
  // Routed through Castra. traceKey (the slice id) forwards as the x-march-slice-id
  // span-correlation header so the babysit /smithy.fix castra.send nests under the
  // slice's trace instead of orphaning a root (#234).
  await castra().sendPrompt({ profile: meta.profile, sessionId, prompt: message, traceKey });
}

/**
 * The legate service's auto-merge action: `gh pr merge --squash --match-head-commit`.
 * `--match-head-commit` pins the merge to the SHA the gate observed, so a worker
 * push between observe and merge fails cleanly (the gate re-evaluates next tick)
 * rather than merging an unreviewed commit. Runs in the profile's repo checkout.
 */
async function squashMergePr(input: { prNumber: number | string; headSha: string; repoPath?: string; sliceId?: string }): Promise<{
  merged: boolean;
}> {
  const args = ["pr", "merge", String(input.prNumber), "--squash", "--match-head-commit", input.headSha];
  await execLegateGh("write", args, input.repoPath, input.sliceId);
  return { merged: true };
}

/**
 * List the repo's open Dependabot PRs with the fields the dependency-merge
 * verdict needs. One `gh pr list` (a single GraphQL call) per invocation; the
 * handler throttles how often it asks. Runs in the profile's repo checkout.
 */
async function listDependabotPrs(repoPath: string): Promise<any[]> {
  const out = await execLegateGh(
    "read",
    [
      "pr", "list", "--author", "app/dependabot", "--state", "open", "--limit", "50",
      "--json", "number,title,url,isDraft,author,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,files,labels",
    ],
    repoPath,
  );
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Author logins of every commit on a PR, for the dependency-merge conflict ladder
 * (a commit not by Dependabot stops Dependabot rebasing the branch itself). One
 * `gh pr view` per call; the handler asks only for a PR newly conflicted at a head.
 */
async function listPrCommitAuthors(repoPath: string, prNumber: number): Promise<string[]> {
  const out = await execLegateGh("read", ["pr", "view", String(prNumber), "--json", "commits"], repoPath);
  const commits = JSON.parse(out)?.commits;
  if (!Array.isArray(commits)) return [];
  return commits.flatMap((c: any) =>
    (Array.isArray(c?.authors) && c.authors.length > 0 ? c.authors : [{}]).map((a: any) => String(a?.login || "")),
  );
}

/** Post a PR conversation comment (e.g. `@dependabot recreate`). */
async function commentOnPrGh(repoPath: string, prNumber: number, body: string, sliceId?: string): Promise<void> {
  await execLegateGh("write", ["pr", "comment", String(prNumber), "--body", body], repoPath, sliceId);
}

async function postCodeRabbitTrigger(repoPath: string, prNumber: number, body: string, sliceId: string): Promise<ReviewPostOutcome> {
  try {
    await execLegateGh("write", [
      "api", "--include", "-X", "POST", `repos/{owner}/{repo}/issues/${prNumber}/comments`, "-f", `body=${body}`,
    ], repoPath, sliceId);
    return { ok: true };
  } catch (error) {
    if (error instanceof LegateGitHubError && error.rateLimited) {
      return { ok: false, kind: "rate_limited", resetAt: error.retryAt };
    }
    return { ok: false, kind: "failed", detail: String(error) };
  }
}

async function findCodeRabbitTrigger(repoPath: string, prNumber: number, head: string, sliceId: string, since = -Infinity): Promise<string | undefined> {
  const out = await execLegateGh("read", [
    "api", "--paginate", "--slurp", `repos/{owner}/{repo}/issues/${prNumber}/comments?per_page=100`,
  ], repoPath, sliceId);
  const pages = JSON.parse(out);
  if (!Array.isArray(pages) || !pages.length || !pages.every(Array.isArray)) {
    throw new Error("Incomplete PR comment history");
  }
  let earliest: string | undefined;
  for (const comment of pages.flat()) {
    if (typeof comment?.body !== "string") throw new Error("Incomplete PR comment history");
    if (markedCodeRabbitHead(comment.body) !== head) continue;
    if (!Number.isFinite(Date.parse(comment.created_at))) throw new Error("Trigger missing GitHub timestamp");
    if (Date.parse(comment.created_at) >= since && (!earliest || Date.parse(comment.created_at) < Date.parse(earliest))) {
      earliest = comment.created_at;
    }
  }
  return earliest;
}

let reviewLimits: ReturnType<typeof reviewRequestLimits> | undefined;

function configuredReviewLimits() {
  let logger: ReturnType<typeof createServiceLogger> | undefined;
  return reviewLimits ??= reviewRequestLimits(process.env, (message) => {
    logger ??= createServiceLogger({
      serviceName: "march-legate",
      logFilePath: resolveServiceLogFilePath("legate.jsonl", "MARCH_LEGATE_LOG_DIR"),
    });
    logger.warn(message);
  });
}

/** Operator requeue (#588): close an open PR with an attribution comment. The
 *  remote branch is deleted separately ({@link deleteRemoteBranchGh}) — `gh pr
 *  close --delete-branch` would also try the local branch, which Brood owns. */
async function closePrGh(repoPath: string, prNumber: number, comment: string, sliceId?: string): Promise<void> {
  await execLegateGh("write", ["pr", "close", String(prNumber), "--comment", comment], repoPath, sliceId);
}

/** Operator requeue (#588): delete a pushed branch on the forge so the fresh
 *  dispatch's orphan-branch check doesn't refuse it. Uses the GitHub API (the
 * scoped gh child), using a read check before issuing a write entitlement.
 *  Resolves `false` when the branch was never pushed. */
async function deleteRemoteBranchGh(repoPath: string, branch: string, sliceId?: string): Promise<boolean> {
  const ref = `repos/{owner}/{repo}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
  try {
    await execLegateGh("read", ["api", ref.replace("/refs/", "/ref/")], repoPath, sliceId);
  } catch (err) {
    if (err instanceof LegateGitHubError && err.status === 404) return false;
    throw err;
  }
  await execLegateGh("write", ["api", "-X", "DELETE", ref], repoPath, sliceId);
  return true;
}

/** Operator merge-now (#593): the PR's live state, head SHA and mergeability,
 *  read fresh from GitHub (the fold can lag) right before the pinned merge. */
async function readLivePrGh(repoPath: string, prNumber: number, sliceId?: string): Promise<{ state: string; headSha: string; mergeable?: string }> {
  const out = await execLegateGh("read", ["pr", "view", String(prNumber), "--json", "state,headRefOid,mergeable"], repoPath, sliceId);
  const pr = JSON.parse(out) as { state?: string; headRefOid?: string; mergeable?: string };
  return { state: pr.state ?? "", headSha: pr.headRefOid ?? "", ...(pr.mergeable ? { mergeable: pr.mergeable } : {}) };
}

/** Repo+label pairs known to exist, so each label is created once per process. */
const ensuredLabels = new Set<string>();

/**
 * Add a label to a PR, creating the label first (idempotently, `--force`) the
 * first time this process uses it in a repo — `gh pr edit --add-label` fails on
 * a label the repo does not have. Colour/description come from {@link LABEL_SPECS}.
 */
async function labelPrGh(repoPath: string, prNumber: number, label: string, sliceId?: string): Promise<void> {
  const key = repoPath + "\0" + label;
  if (!ensuredLabels.has(key)) {
    const spec = LABEL_SPECS[label] ?? { color: "ededed", description: "March legate label" };
    await execLegateGh(
      "write",
      ["label", "create", label, "--force", "--color", spec.color, "--description", spec.description],
      repoPath,
      sliceId,
    );
    ensuredLabels.add(key);
  }
  await execLegateGh("write", ["pr", "edit", String(prNumber), "--add-label", label], repoPath, sliceId);
}

/** Remove a label from a PR. */
async function unlabelPrGh(repoPath: string, prNumber: number, label: string, sliceId?: string): Promise<void> {
  await execLegateGh("write", ["pr", "edit", String(prNumber), "--remove-label", label], repoPath, sliceId);
}

/**
 * List the repo's open PRs with the fields the label reconciler needs. One
 * `gh pr list` (a single GraphQL call) per invocation; the handler throttles.
 */
async function listOpenPrsForLabels(repoPath: string): Promise<any[]> {
  const out = await execLegateGh(
    "read",
    ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefName,author,labels"],
    repoPath,
  );
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Post a reaction to a PR conversation (issue) comment — the babysit `:eyes:`
 * acknowledgement on a dispatched comment-fix. The forge client scopes the
 * endpoint to the profile checkout. Best-effort: babysit treats the persisted comment-id
 * set as authoritative, so a failure here is swallowed by the caller.
 */
async function reactToCommentGh(input: { commentId: string | number; content: string; repoPath?: string; sliceId?: string }): Promise<void> {
  const args = [
    "api",
    "--method",
    "POST",
    `repos/{owner}/{repo}/issues/comments/${input.commentId}/reactions`,
    "-f",
    `content=${input.content}`,
  ];
  await execLegateGh("write", args, input.repoPath, input.sliceId);
}

async function sendDoorbellToLegate(meta: any) {
  try {
    await castra().sendPrompt({
      profile: meta.profile,
      sessionId: `conductor-${meta.paired_legate}`,
      prompt: "[PROCESSOR]",
    });
    return true;
  } catch {
    return false;
  }
}

function requestLegateJudgement(meta: any, input: any) {
  return requestJudgement(input, {
    processorName: meta.processor_name,
    pairedLegate: meta.paired_legate,
    appendRequest: (event: any) => append(meta, meta.processor_requests_path, event),
    appendEvent: (event: any) => append(meta, meta.processor_events_path, event),
    sendDoorbell: () => sendDoorbellToLegate(meta),
    log: (line: string) => appendText(meta.processor_log_path, line),
  });
}

// Append a transition event to Herald for `profile`. Fire-and-forget: a Herald
// write must never break or slow a tick (Herald is the single sequencer and
// re-folds idempotently on its side).
function emitTransition(profile: string, event: any) {
  Promise.resolve()
    .then(() => legateHerald().append(profile, event))
    .catch(() => {});
}

// Cull the steward a failed spawn orphaned in Castra (see
// DispatchIoDeps.cullStewardForSlice). Matches by the sliceId stamped into session
// metadata at launch (#214) — robust to the feature/-prefix the actual git branch
// carries — and falls back to a prefix-normalized branch compare for legacy
// sessions without metadata. Removes the session (pruning its worktree), so the
// orphan a launch-timeout/crash left behind doesn't leak or hold a budget slot.
async function cullStewardForSlice(
  profile: string,
  sliceId: string,
  branch: string | undefined,
): Promise<{ culled: boolean; sessionId?: string }> {
  const sessions = await castra().listSessions(profile);
  const want = (branch ?? "").replace(/^feature\//, "");
  // Remove EVERY session matching this slice, not just the first: repeated
  // spawn failures / launch timeouts can orphan more than one Castra session for
  // the same sliceId/branch, and leaving the extras behind keeps leaking
  // worktrees + holding budget slots. Remove all so the cull is complete.
  const matches = sessions.filter(
    (s) =>
      (s.metadata?.sliceId !== undefined && s.metadata.sliceId === sliceId) ||
      (want.length > 0 && (s.branch ?? "").replace(/^feature\//, "") === want),
  );
  if (matches.length === 0) return { culled: false };
  for (const m of matches) {
    await castra().removeSession({ profile, sessionId: m.sessionId, pruneWorktree: true });
  }
  // Report the first id culled (the action is one-per-slice); all matches removed.
  return { culled: true, sessionId: matches[0].sessionId };
}

// Build the dispatch I/O seam (handlers/dispatch-io.ts) for one profile.
function dispatchIoDeps(meta: any): DispatchIoDeps {
  const hatcheryUrl = resolveHatcheryUrl(env);
  return {
    meta,
    emitTransition: (event: any) => emitTransition(meta.profile, event),
    emit: (event: any) => append(meta, meta.processor_events_path, event),
    log: (line: string) => appendText(meta.processor_log_path, line),
    postSpawn: (request: any) => postSpawn(hatcheryUrl, request),
    getJob: (jobId: string) => getJob(hatcheryUrl, jobId),
    cullStewardForSlice: (sliceId: string, branch: string | undefined) =>
      cullStewardForSlice(meta.profile, sliceId, branch),
  };
}

/**
 * Run the two-stage tick for ONE profile against its isolated working state. The
 * shared Herald stream has already been drained this tick; this reads the
 * profile's folded bucket via `herald.snapshotFor(profile)`.
 */
/** Per-tick agent-health tally a profile contributes to the global circuit-breaker. */
interface AgentHealthTally {
  /** Hard-down spawn failures (codex auth, ...) drained this tick. */
  agentDown: number;
  /** Spawns that completed successfully this tick (the agent is working). */
  healthy: number;
}

async function tickProfile(rt: ProfileRuntime, history: ReviewRequestHistory, spawnBudget?: SpawnBudget): Promise<AgentHealthTally> {
  const meta = rt.meta;
  const startedMs = Date.now();
  const herald = legateHerald();
  // Stage 1 reads the world from the folded Herald inbox, so the legate's sense
  // deps are gh-free (only the local smithy-graph read). All gh sensing lives in
  // Herald via sense-io.ts; the legate no longer imports it.
  const senseDeps = createFoldDeps({ meta, now });

  // Per-profile inbox adapter over the already-drained shared fold (no re-drain).
  const inbox: HeraldInbox = {
    consume: async () => herald.snapshotFor(meta.profile),
    takeRecoveryRequests: () => herald.takeRecoveryRequests(meta.profile),
    takeStewardAttachments: () => herald.takeStewardAttachments(meta.profile),
  };

  const makeContext = (state: any) => ({
    meta,
    ts: state.ts,
    castra: castra(),
    broodTeardown: (sessionId: string, opts?: any) => broodTeardownCli(sessionId, opts),
    broodRegister: (input: any) => broodRegisterCli(input),
    broodRetire: (sessionId: string) => broodRetireCli(sessionId),
    requestJudgement: (input: any) => requestLegateJudgement(meta, input),
    emit: (event: any) => append(meta, meta.processor_events_path, event),
    emitTransition: (event: any) => emitTransition(meta.profile, event),
    log: (line: string) => appendText(meta.processor_log_path, line),
  });

  const babysitDeps = {
    sendMessage: (sessionId: string, message: string, traceKey?: string) =>
      sendAgentDeckMessage(meta, sessionId, message, traceKey),
    requestJudgement: (input: any) => requestLegateJudgement(meta, input),
    mergePr: squashMergePr,
    reactToComment: reactToCommentGh,
  };

  const dependencyMergeDeps = {
    listDependencyPrs: (repoPath: string) => listDependabotPrs(repoPath),
    mergePr: squashMergePr,
    listCommitAuthors: (repoPath: string, prNumber: number) => listPrCommitAuthors(repoPath, prNumber),
    commentOnPr: (repoPath: string, prNumber: number, body: string) => commentOnPrGh(repoPath, prNumber, body),
    labelPr: (repoPath: string, prNumber: number, label: string) => labelPrGh(repoPath, prNumber, label),
  };

  const prLabelsDeps = {
    listOpenPrs: (repoPath: string) => listOpenPrsForLabels(repoPath),
    addLabel: (repoPath: string, prNumber: number, label: string, sliceId?: string) =>
      labelPrGh(repoPath, prNumber, label, sliceId),
    removeLabel: (repoPath: string, prNumber: number, label: string, sliceId?: string) =>
      unlabelPrGh(repoPath, prNumber, label, sliceId),
  };

  const ioDeps = dispatchIoDeps(meta);
  const dispatchDeps = {
    // The default-branch sync is owned by Herald (#300, always on since #601); the
    // legate never fetches so it can't fight it.
    completePending: (rawState: any, ts: string) => completePendingHatcheryDispatches(rawState, ts, ioDeps),
    launchDispatch: (rawState: any, ts: string, item: any, sliceId: string) =>
      launchDispatch(rawState, ts, item, sliceId, ioDeps),
    recoverDispatch: (rawState: any, ts: string, item: any, sliceId: string, attempt: number) =>
      recoverDispatch(rawState, ts, item, sliceId, attempt, ioDeps),
    requestJudgement: (input: any) => requestLegateJudgement(meta, input),
  };

  const sense = async () => {
    const state = await senseFromHerald(senseDeps, inbox, rt.workingState);
    // Hand the profile's live merge policy to the auto-merge gate (babysit).
    state.mergePolicy = rt.mergePolicy;
    return state;
  };

  const out = await coordinatorRunTick({
    sense,
    makeContext,
    babysit: babysitDeps,
    dispatch: dispatchDeps,
    dependencyMerge: dependencyMergeDeps,
    prLabels: prLabelsDeps,
    coderabbitRereview: {
      history,
      limits: configuredReviewLimits(),
      now,
      appendIntent: (record) => herald.append(meta.profile, { type: "review.requested", ...record }),
      findTrigger: findCodeRabbitTrigger,
      commentOnPr: postCodeRabbitTrigger,
      copilot: { backoff: copilotBackoff, request: requestCopilotReview },
    },
    requeue: {
      closePr: closePrGh,
      deleteRemoteBranch: deleteRemoteBranchGh,
    },
    mergeNow: {
      readPr: readLivePrGh,
      mergePr: squashMergePr,
    },
    spawnBudget,
  });

  rt.workingState = out.state.raw;
  rt.lastDispatch = {
    at: out.tick.ts,
    smithyOk: out.tick.dispatchDecisions != null,
    items: out.tick.dispatchDecisions ?? [],
    checkout: out.state.checkout ?? null,
  };

  // Agent-health tally for the circuit-breaker: hard-down spawn failures the
  // dispatch handler flagged this tick, and successful spawn completions
  // (`dispatch-complete`) that prove the agent is working.
  const dispatchRes = out.results?.dispatch;
  const tally: AgentHealthTally = {
    agentDown: dispatchRes?.hardDownFailures ?? 0,
    healthy: Array.isArray(dispatchRes?.actions)
      ? dispatchRes.actions.filter((a: any) => a?.action === "dispatch-complete").length
      : 0,
  };

  // Dwell (time-in-state): stamp stage_entered_at / merge_gate_since on the working
  // slices (same ref as rt.workingState, so it persists across ticks) and fold the
  // max-age view + completed dwells into the dwell metrics. Best-effort.
  try {
    const dwell = stampDwell(out.state.slices, Date.now());
    recordDwell(meta.profile, dwell);
  } catch {
    // Telemetry must never break the loop.
  }

  runHeartbeat(out, {
    meta: {
      processor_name: meta.processor_name,
      paired_legate: meta.paired_legate,
      processor_events_path: meta.processor_events_path,
      processor_log_path: meta.processor_log_path,
    },
    heartbeatEventsPath: meta.loop_heartbeat_events_path || meta.processor_events_path,
    heartbeatLogPath: meta.loop_heartbeat_log_path || meta.processor_log_path,
    append: (file: string, value: any) => append(meta, file, value),
    appendText,
    appendTextSilent,
    setLastHeartbeat: (record: any) => {
      rt.lastHeartbeat = record;
    },
  });

  // Fold this profile's tick into the OTel heartbeat metrics (per-profile label).
  try {
    const activity = buildLoopTickActivity(rt.lastHeartbeat, {
      profile: meta.profile,
      conductor: meta.paired_legate || meta.loop_name,
      tickAtMs: startedMs,
      durationMs: Date.now() - startedMs,
    });
    if (activity) recordLoopHeartbeat(activity);
  } catch {
    // Telemetry must never break the loop.
  }

  return tally;
}

const appendReviewBackoff: ConstructorParameters<typeof ReviewerBackoff>[0] = (profile, record, id) =>
  legateHerald().append(profile, { type: "review.backoff", ...record, id });
const codeRabbitBackoff = new ReviewerBackoff(appendReviewBackoff);
const copilotBackoff = new ReviewerBackoff(appendReviewBackoff, "copilot");

// Drain the shared Herald stream once, then run each profile in isolation.
async function tick() {
  let profiles: ProfileRecord[];
  try {
    profiles = await profileClient.list();
  } catch (err: any) {
    // Registry unreachable — skip this tick rather than wedge; the next tick retries.
    emitLoopLog({
      severity: "ERROR",
      body: "profile_list_failed: " + (err?.message || String(err)),
      eventKind: "processor_error",
    });
    return;
  }

  // Dispatch in priority order (lower `priority` wins, ties by name): the shared
  // spawn budget below is consumed as each profile dispatches in turn, so a P0
  // profile gets first claim on the cap each tick and a P2 profile only spawns
  // from what's left. Unset priority sorts last (DEFAULT_PROFILE_PRIORITY).
  profiles.sort(byDispatchPriority);

  // GC runtimes for profiles that are no longer registered (removed/disabled).
  const active = new Set(profiles.map((p) => p.profile));
  for (const profile of [...runtimes.keys()]) if (!active.has(profile)) runtimes.delete(profile);

  // One drain of the single multiplexed stream feeds every profile's fold.
  let projection;
  try {
    projection = await legateHerald().consume();
  } catch (err: any) {
    emitLoopLog({
      severity: "ERROR",
      body: "herald_drain_failed: " + (err?.message || String(err)),
      eventKind: "processor_error",
    });
    return;
  }

  const profilesByName = new Map(profiles.map((profile) => [profile.profile, profile]));
  // Read the same PR snapshots as senseFromHerald before any profile can post.
  const reviewAt = now();
  for (const backoff of [codeRabbitBackoff, copilotBackoff]) {
    const reviewer = backoff.reviewer;
    const signals = profiles.flatMap((profile) => Object.entries(projection.byProfile[profile.profile]?.slices ?? {})
      .flatMap(([sliceId, slice]) => reviewSignals(profile.profile, profile.repoName, sliceId, slice.pr, reviewer)));
    await backoff.beginTick(projection, signals, Date.parse(reviewAt),
      (intent) => verifyStartupIntent(intent, projection, profilesByName, findCodeRabbitTrigger),
      (target, outcome, detail, rateLimitHit) => {
        const event = {
          ts: reviewAt, kind: "review_request", profile: target.profile, slice_id: target.sliceId,
          pr_number: target.pr, reviewer,
          task_type: taskTypeForSlice(target.sliceId, projection.byProfile[target.profile]?.slices[target.sliceId]) ?? "unknown",
          action: outcome === "backoff" ? "review-request-deferred" : "review-request-failed",
          outcome, detail, rate_limit_hit: rateLimitHit, reason: "account_backoff",
        };
        const profile = profilesByName.get(target.profile);
        if (profile) {
          const { meta } = runtimeFor(profile);
          try {
            append(meta, meta.processor_events_path, event);
            return;
          } catch (error) {
            logTickError(error, target.profile);
          }
        }
        emitActionEventSpan(event);
        emitActionEventLog(event);
        recordActionEventMetrics(event);
      });
  }

  const reviewHistory: ReviewRequestHistory = {
    backoff: codeRabbitBackoff,
    byProfile: Object.assign(Object.create(null), Object.fromEntries(
      Object.entries(projection.byProfile)
        .map(([profile, state]) => [profile, [...(state.reviewRequests ?? [])]]),
    )),
  };

  // Seed the GLOBAL concurrent-spawn budget (#313) ONCE per tick from the live
  // spawns carried in by every profile's working state, then thread the SAME
  // mutable budget through each profile's dispatch so the combined fresh launches
  // this tick stay under the cap.
  //
  // On a warm tick `workingState` already holds the prior tick's slices, so the
  // count is the live set as of tick start. On a COLD start (restart, or a
  // first-seen profile) `workingState` is still null here — but the shared Herald
  // stream was already drained above, so rebuild the slice set from each profile's
  // fold first. Without this, a restart with existing non-terminal slices would
  // seed live=0 and launch a full extra cap on top of the already-running workers,
  // exceeding the global limit the feature enforces. Pre-seeding `workingState`
  // with the same rebuild `senseFromHerald` would do is idempotent: `tickProfile`
  // then reuses it (prevRaw non-null) instead of rebuilding from the same fold.
  let liveAcrossProfiles = 0;
  for (const rec of profiles) {
    const rt = runtimeFor(rec);
    if (rt.workingState == null) {
      rt.workingState = rebuildWorkingState(legateHerald().snapshotFor(rec.profile), rt.meta);
    }
    liveAcrossProfiles += liveSpawnCount(rt.workingState);
  }
  // Effective cap after the agent-health circuit-breaker: full cap when the
  // agent is healthy, collapsed to 0 (or 1 for a probe) when it is hard-down so
  // the loop stops flooding spawns into a failing agent (#codex-down). The
  // breaker returns the FRESH-dispatch allowance; while OPEN that allowance is
  // ADDED to the current live draw so a probe can actually launch even when
  // stewards/spawns are already live (otherwise `remaining = cap - live` would
  // swallow the probe and the breaker could never recover). While CLOSED the
  // allowance IS the total cap, preserving the normal global-cap semantics.
  const freshAllowance = spawnBreaker.beginTick(maxConcurrentSpawns);
  const budgetCap = spawnBreaker.isOpen() ? liveAcrossProfiles + freshAllowance : freshAllowance;
  const spawnBudget = createSpawnBudget(budgetCap, liveAcrossProfiles);

  const agentHealth = { agentDown: 0, healthy: 0 };
  for (const rec of profiles) {
    const rt = runtimeFor(rec);
    try {
      const tally = await tickProfile(rt, reviewHistory, spawnBudget);
      agentHealth.agentDown += tally.agentDown;
      agentHealth.healthy += tally.healthy;
    } catch (err: any) {
      logTickError(err, rec.profile);
    }
  }

  // The shared history includes the durable intents acknowledged during this tick.
  try {
    recordReviewCaps(() => reviewCapSamples(reviewHistory.byProfile, configuredReviewLimits(), now()));
  } catch {
    // Telemetry must never break the loop.
  }

  // Fold this tick's agent-health into the breaker (transitions apply NEXT tick).
  spawnBreaker.endTick(agentHealth);
  const breakerSnap = spawnBreaker.snapshot();
  if (breakerSnap.breakerOpen === 1 && !lastBreakerOpen) {
    emitLoopLog({
      severity: "ERROR",
      body:
        `agent-health circuit-breaker OPEN — ${agentHealth.agentDown} hard-down spawn ` +
        `failure(s) (e.g. codex auth). Pausing fresh dispatch (effective cap 0, probing ` +
        `every few ticks). Re-authenticate the agent, then recover the backlog.`,
      eventKind: "spawn_breaker_open",
    });
  } else if (breakerSnap.breakerOpen === 0 && lastBreakerOpen) {
    emitLoopLog({
      severity: "INFO",
      body: "agent-health circuit-breaker CLOSED — agent recovered; resuming normal dispatch.",
      eventKind: "spawn_breaker_closed",
    });
  }
  lastBreakerOpen = breakerSnap.breakerOpen === 1;

  // Refresh the GLOBAL spawn-budget gauges (#313) once per tick — emitted after
  // the per-profile loop so `deferred` is final. Profile-less: cap + draw are
  // shared, so `spawn.live ≫ spawn.cap` with dispatch starved screams the
  // ghost-stewards-pin-the-cap wedge as one signal.
  try {
    recordSpawnBudget({
      // Report the CONFIGURED cap as `cap` (so spawn.cap stays the operator's
      // setting) and the breaker's collapse separately as `effective_cap`.
      cap: maxConcurrentSpawns,
      live: spawnBudget.live,
      deferred: spawnBudget.deferred,
      effectiveCap: breakerSnap.effectiveCap,
      breakerOpen: breakerSnap.breakerOpen,
    });
  } catch {
    // Telemetry must never break the loop.
  }

  // One global line when the cap throttled this tick — the dispatchable frontier
  // is unchanged (the #289/#290 metric still reports it); these items simply wait
  // for slots to free as PRs merge/close.
  if (spawnBudget.deferred > 0) {
    emitLoopLog({
      severity: "INFO",
      body:
        `spawn cap ${spawnBudget.cap} reached (${spawnBudget.live} live) — deferred ` +
        `${spawnBudget.deferred} dispatchable across profiles`,
      eventKind: "spawn_cap_throttled",
    });
  }
}

function logTickError(err: any, profile?: string) {
  const message = err?.message || String(err);
  const body = profile ? `processor_error[${profile}]: ${message}` : "processor_error: " + message;
  emitLoopLog({ severity: "ERROR", body, eventKind: "processor_error" });
  console.error(`[${now()}] ${body}`);
}

/**
 * Start the periodic loop: log a startup line, replay each profile's recent
 * action events, then hand off to the scheduler (which runs an immediate tick and
 * schedules the interval). Returns a handle to stop the timer for graceful shutdown.
 */
export function startLoopRuntime(): { stop: () => void } {
  console.log(`[${now()}] march-legate starting in terminal-pr-maintenance mode (profile-agnostic)`);
  return scheduler().start();
}
