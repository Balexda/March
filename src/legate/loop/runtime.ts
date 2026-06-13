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
import { recordLoopHeartbeat } from "../../observability/loop-metrics.js";
import { emitLoopLog } from "../../observability/logs.js";
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
import { execText } from "./clients/exec.js";
import { runTick as coordinatorRunTick } from "./coordinator.js";
import { resolveMaxConcurrentSpawns } from "./meta.js";
import { createSpawnBudget, liveSpawnCount, type SpawnBudget } from "./pure/slice.js";
import { runHeartbeat } from "./heartbeat.js";
import { broodRegister as broodRegisterCli, broodRetire as broodRetireCli, broodTeardown as broodTeardownCli } from "./clients/brood.js";
import { LegateHerald } from "./clients/herald.js";
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
import { buildLoopTickActivity, emitActionEventLog, emitActionEventSpan } from "./loop-telemetry.js";
// Cadence layer (#144): the re-entrancy guard + interval + tick timing. runtime
// supplies the tick body, error handler, and metrics flush.
import { createScheduler, type LoopScheduler } from "./scheduler.js";

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
  /** Per-profile latest heartbeat record. */
  readonly byProfile: Record<string, { lastHeartbeat: any }>;
  readonly profiles: string[];
  readonly lastTickAtMs: number;
  readonly lastTickDurationMs: number;
  /** Back-compat: an arbitrary profile's heartbeat (first registered). */
  readonly lastHeartbeat: any;
}

/** Latest tick snapshot, consumed by the HTTP /status endpoint. */
export function getLoopSnapshot(): LoopSnapshot {
  const byProfile: Record<string, { lastHeartbeat: any }> = {};
  for (const [profile, rt] of runtimes) byProfile[profile] = { lastHeartbeat: rt.lastHeartbeat };
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

function now() {
  return new Date().toISOString();
}

function append(meta: any, file: string, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf-8");
  if (file === meta.processor_events_path) {
    emitActionEventSpan(value);
    emitActionEventLog(value);
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
async function squashMergePr(input: { prNumber: number | string; headSha: string; repoPath?: string }): Promise<{
  merged: boolean;
  mergeSha?: string;
  error?: string;
}> {
  const args = ["pr", "merge", String(input.prNumber), "--squash", "--match-head-commit", input.headSha];
  const options: { cwd?: string } = {};
  if (input.repoPath) options.cwd = input.repoPath;
  try {
    await execText("gh", args, options);
    return { merged: true };
  } catch (err: any) {
    return { merged: false, error: err?.message || String(err) };
  }
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
  const match = sessions.find(
    (s) =>
      (s.metadata?.sliceId !== undefined && s.metadata.sliceId === sliceId) ||
      (want.length > 0 && (s.branch ?? "").replace(/^feature\//, "") === want),
  );
  if (!match) return { culled: false };
  await castra().removeSession({ profile, sessionId: match.sessionId, pruneWorktree: true });
  return { culled: true, sessionId: match.sessionId };
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
async function tickProfile(rt: ProfileRuntime, spawnBudget?: SpawnBudget): Promise<void> {
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
    mergePr: (input: { prNumber: number | string; headSha: string; repoPath?: string }) =>
      squashMergePr(input),
  };

  const ioDeps = dispatchIoDeps(meta);
  const dispatchDeps = {
    // The default-branch sync is owned by Herald (MARCH_HERALD_SYNC, #300); the
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
    spawnBudget,
  });

  rt.workingState = out.state.raw;

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
}

// Multi-profile tick: list the registered profiles, drain the shared Herald
// stream ONCE, then run each profile's two-stage tick isolated in try/catch.
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
  try {
    await legateHerald().consume();
  } catch (err: any) {
    emitLoopLog({
      severity: "ERROR",
      body: "herald_drain_failed: " + (err?.message || String(err)),
      eventKind: "processor_error",
    });
    return;
  }

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
  const spawnBudget = createSpawnBudget(maxConcurrentSpawns, liveAcrossProfiles);

  for (const rec of profiles) {
    const rt = runtimeFor(rec);
    try {
      await tickProfile(rt, spawnBudget);
    } catch (err: any) {
      logTickError(err, rec.profile);
    }
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
