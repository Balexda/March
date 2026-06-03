/**
 * Legate loop runtime — the wiring layer of the containerized legate loop. It
 * binds the two-stage tick (sense → coordinator → heartbeat) to the proven async
 * I/O seams: Castra (sessions), the Hatchery service client (codex spawns),
 * Brood (teardown), and Herald (event log + transition writes). The decision and
 * effecting logic lives in the tested modules under pure/ / state/ / handlers/;
 * what remains here is composition: build the deps, run the coordinator, schedule
 * the interval.
 *
 * The dispatch path (ask Hatchery to spawn, poll a job to completion, escalate a
 * failure) lives in handlers/dispatch-ops.ts behind handlers/dispatch-io.ts; the
 * loop's old recovery surgery (codex retries, ghost-session reclamation, no-spawn
 * direct-steward fallback) was deleted in #144 — the legate asks services to act
 * and records the transition; it does not recover on their behalf.
 *
 * Originally a near-verbatim lift of the generated `legate-loop.mjs` (the
 * LEGATE_LOOP_MJS template once in src/legate/init.ts, deleted in #146); the
 * decomposition + typing tracked in #144 removed the `@ts-nocheck` pragma. The
 * duck-typed slice/item/working-state seams are annotated `any`, matching the
 * deliberate `Record<string, any>` shapes in state/types.ts and the handlers.
 */
import fs from "node:fs";
import path from "node:path";
import { recordLoopHeartbeat } from "../../observability/loop-metrics.js";
import { emitLoopLog } from "../../observability/logs.js";
import {
  getJob,
  postSpawn,
  resolveHatcheryUrl,
} from "../../hatchery/service/client.js";
import { CastraClient } from "../../castra/client.js";
import type { LoopMeta } from "./meta.js";
// Decomposed two-stage loop: Stage 1 sense → coordinator (ordered handlers) →
// heartbeat. runtime now only wires these to the proven I/O seams below.
import { senseFromHerald } from "./state/sense.js";
import { createSenseIo, type SenseIo } from "../../observe/sense-io.js";
import { runTick as coordinatorRunTick } from "./coordinator.js";
import { runHeartbeat } from "./heartbeat.js";
import { broodRegister as broodRegisterCli, broodTeardown as broodTeardownCli } from "./clients/brood.js";
import { LegateHerald } from "./clients/herald.js";
// Dispatch ops (ask Hatchery to spawn / poll a job to completion). The legate's
// effecting dispatch logic, behind the DispatchIoDeps seam built below. #144.
import type { DispatchIoDeps } from "./handlers/dispatch-io.js";
import {
  completePendingHatcheryDispatches,
  launchDispatch,
  recoverDispatch,
} from "./handlers/dispatch-ops.js";
// Startup replay formatting (#144): parse + filter + format the recent action
// events; runtime keeps the file read + header + printing.
import { recentActionEventLines } from "./pure/replay.js";
// Legate-judgement requests (#144): event build + dedup + doorbell, behind
// injected I/O; runtime supplies the concrete sinks.
import { requestJudgement } from "./judgement.js";
// Loop domain → OTel payload mapping (#144): action events → spans/logs, and the
// heartbeat record → the loop-metrics activity. The OTel SDK wiring lives behind.
import { buildLoopTickActivity, emitActionEventLog, emitActionEventSpan } from "./loop-telemetry.js";
// Cadence layer (#144): the re-entrancy guard + interval + tick timing. runtime
// supplies the tick body, error handler, and metrics flush.
import { createScheduler, type LoopScheduler } from "./scheduler.js";

// Lazily-built async Castra client (constructed on first use so it reads the
// CASTRA_URL/token env the container passes in). The loop reaches every
// interactive session through Castra rather than agent-deck directly; all its
// methods are async (fetch), so every call site below awaits.
let _castra: CastraClient | undefined;
function castra(): CastraClient {
  return (_castra ??= new CastraClient());
}

// Shared system-observation I/O (gh/git/smithy/Castra reads). Lifted into
// src/observe/sense-io.ts so the legate loop and the Herald service share one
// tested implementation; built lazily so it reads the configured meta + env.
let _senseIo: SenseIo | undefined;
function senseIo(): SenseIo {
  return (_senseIo ??= createSenseIo({
    meta,
    castra: castra(),
    now,
    warn: (message: string) => appendText(meta.processor_log_path, "[" + now() + "] " + message),
  }));
}

// Herald inbox/write client (#175, #176). Built lazily on first use. Since
// state.json was retired (#176) the legate is unconditionally Herald-backed:
// Stage 1 drains the inbox and the working state is the event-log fold, so the
// client always exists (it resolves MARCH_HERALD_URL, defaulting to the
// deterministic local Herald port).
let _herald: LegateHerald | undefined;
function legateHerald(): LegateHerald {
  return (_herald ??= new LegateHerald({ conductorDir: meta.legate_conductor_dir, env: process.env }));
}

// In-memory working state (the former state.json `raw`): slices, archived_slices,
// repo, transient retry counters. Threaded across ticks — the Stage-2 handlers
// mutate it in place — and rebuilt from the Herald fold on cold start (#176). Its
// durable backing is the event log: every mutation that matters is mirrored by an
// emitTransition, so a restart reconstructs it from snapshot + trailing events.
let workingState: any = null;

// Append a transition event to Herald. Since state.json was retired (#176) this
// is the SOLE durable record of a legate transition. Fire-and-forget: a Herald
// write must never break or slow a tick (Herald is the single sequencer and
// re-folds idempotently on its side).
function emitTransition(event: any) {
  Promise.resolve()
    .then(() => legateHerald().append(event))
    .catch(() => {});
}

// Injected at startup by configureLoopRuntime().
let meta: any;
let heartbeatLogPath: string;
let heartbeatEventsPath: string;
let intervalSeconds = 60;

// Latest tick snapshot for the HTTP API + observable metric gauges. Tick timing
// (lastTickAtMs / lastTickDurationMs) is owned by the scheduler.
let lastHeartbeat: any = null;

// The cadence driver, built lazily on first start/tick (after configureLoopRuntime
// has set the interval). Owns the re-entrancy guard, the interval, and tick timing.
let _scheduler: LoopScheduler | undefined;
function scheduler(): LoopScheduler {
  return (_scheduler ??= createScheduler({
    tick,
    onTickError: logTickError,
    onTickComplete: (durationMs: number, tickAtMs: number) => {
      try {
        flushHeartbeatMetrics(durationMs, tickAtMs);
      } catch {
        // Telemetry must never break the loop.
      }
    },
    intervalSeconds,
  }));
}

/** Wire the runtime to a loaded meta + tick interval. Call once before start. */
export function configureLoopRuntime(
  loadedMeta: LoopMeta,
  opts: { intervalSeconds: number },
): void {
  meta = loadedMeta;
  heartbeatLogPath = meta.loop_heartbeat_log_path || meta.processor_log_path;
  heartbeatEventsPath = meta.loop_heartbeat_events_path || meta.processor_events_path;
  intervalSeconds = opts.intervalSeconds;
}

export interface LoopSnapshot {
  readonly lastHeartbeat: any;
  readonly lastTickAtMs: number;
  readonly lastTickDurationMs: number;
}

/** Latest tick snapshot, consumed by the HTTP /status endpoint. */
export function getLoopSnapshot(): LoopSnapshot {
  return {
    lastHeartbeat,
    lastTickAtMs: _scheduler?.lastTickAtMs ?? 0,
    lastTickDurationMs: _scheduler?.lastTickDurationMs ?? 0,
  };
}

/** Run a single tick immediately (used by start + future /tick endpoint). */
export async function runTickOnce(): Promise<void> {
  await scheduler().runOnce();
}

function now() {
  return new Date().toISOString();
}

function append(file: string, value: any) {
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

function printText(text: string) {
  console.log(text);
}

function replayRecentActionEvents(limit = 10) {
  let raw;
  try {
    raw = fs.readFileSync(meta.processor_events_path, "utf-8");
  } catch (err: any) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  const lines = recentActionEventLines(raw, limit);
  if (lines.length === 0) return;
  printText(`[${now()}] replaying ${lines.length} recent processor action event(s) to stdout`);
  for (const line of lines) printText(line);
}

async function sendAgentDeckMessage(sessionId: string, message: string, traceKey?: string) {
  // Routed through Castra. Castra's send is fire-and-forget (202); the former
  // --wait/--timeout has no equivalent, which is fine — every loop caller used
  // the no-wait path. traceKey (the slice id) forwards as the x-march-slice-id
  // span-correlation header so the babysit /smithy.fix castra.send nests under the
  // slice's trace instead of orphaning a root (#234) — the same correlation the
  // dispatch path's castra.launch/send already carries.
  await castra().sendPrompt({ profile: meta.profile, sessionId, prompt: message, traceKey });
}

async function sendDoorbellToLegate() {
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

function requestLegateJudgement(input: any) {
  return requestJudgement(input, {
    processorName: meta.processor_name,
    pairedLegate: meta.paired_legate,
    appendRequest: (event: any) => append(meta.processor_requests_path, event),
    appendEvent: (event: any) => append(meta.processor_events_path, event),
    sendDoorbell: sendDoorbellToLegate,
    log: (line: string) => appendText(meta.processor_log_path, line),
  });
}

// Build the dispatch I/O seam (handlers/dispatch-io.ts). The Hatchery client is
// bound to the resolved base URL here; the action-log + Herald writes reuse the
// runtime's append/emitTransition so the OTel span/log side-effects still fire.
function dispatchIoDeps(): DispatchIoDeps {
  const hatcheryUrl = resolveHatcheryUrl(process.env);
  return {
    meta,
    emitTransition: (event: any) => emitTransition(event),
    emit: (event: any) => append(meta.processor_events_path, event),
    log: (line: string) => appendText(meta.processor_log_path, line),
    postSpawn: (request: any) => postSpawn(hatcheryUrl, request),
    getJob: (jobId: string) => getJob(hatcheryUrl, jobId),
    // #173: the slice's open-PR discovery for the branch-collision adopt path,
    // wired from the shared sense I/O singleton (branch-variant matched, identical
    // to Herald/babysit). Empty sessionId falls back to `gh pr list` branch match.
    discoverPr: (slice: any, state: any, sessionId?: string) =>
      senseIo().discoverPrForSlice(slice, state, sessionId ?? ""),
  };
}

// Two-stage tick: Stage 1 senseFromHerald drains the inbox + folds the working
// state; the coordinator runs the ordered handlers (cleanup → ghost-cleanup →
// relaunch → babysit → dispatch) as pure assess + effecting apply; the heartbeat
// writes the record + events and snapshots it for /status. All I/O is wired to
// the proven async seams in this file (Castra fetch, the Hatchery + Brood HTTP
// clients, Herald).
async function tick() {
  // Stage 1 reads are the shared observation I/O (src/observe/sense-io.ts).
  const senseDeps = senseIo().toSenseDeps();
  const herald = legateHerald();

  const makeContext = (state: any) => ({
    meta,
    ts: state.ts,
    castra: castra(),
    // Brood is a service; broodTeardown hits it over HTTP via the async
    // BroodClient (MARCH_BROOD_URL). No CLI shelling.
    broodTeardown: (sessionId: string, opts?: any) => broodTeardownCli(sessionId, opts),
    // Reconcile an orphaned/untracked steward back into Brood's registry (#225)
    // so its teardown runs through Brood's exact-path reclamation (#155).
    broodRegister: (input: any) => broodRegisterCli(input),
    // Operator escalation (rings the doorbell + records a processor_request),
    // used by cleanup to stop deferring a stuck teardown forever (#225).
    requestJudgement: (input: any) => requestLegateJudgement(input),
    emit: (event: any) => append(meta.processor_events_path, event),
    // Herald transition events (#176): the sole durable record of a transition
    // now that state.json is retired. The in-memory working state is mutated by
    // the handlers directly and reconstructed from these events on cold start.
    emitTransition: (event: any) => emitTransition(event),
    log: (line: string) => appendText(meta.processor_log_path, line),
  });

  const babysitDeps = {
    sendMessage: (sessionId: string, message: string, traceKey?: string) => sendAgentDeckMessage(sessionId, message, traceKey),
    requestJudgement: (input: any) => requestLegateJudgement(input),
  };

  const ioDeps = dispatchIoDeps();
  const dispatchDeps = {
    // The default-branch sync is owned by Herald (MARCH_HERALD_SYNC); the legate
    // never fetches so it can't fight it.
    syncDefaultBranch: async () => {},
    completePending: (rawState: any, ts: string) => completePendingHatcheryDispatches(rawState, ts, ioDeps),
    launchDispatch: (rawState: any, ts: string, item: any, sliceId: string) => launchDispatch(rawState, ts, item, sliceId, ioDeps),
    recoverDispatch: (rawState: any, ts: string, item: any, sliceId: string, attempt: number) => recoverDispatch(rawState, ts, item, sliceId, attempt, ioDeps),
    requestJudgement: (input: any) => requestLegateJudgement(input),
  };

  // Stage 1 (#176): drain + fold the Herald inbox into the LoopState. The working
  // state `raw` is the in-memory `workingState` threaded across ticks (null on
  // cold start, when senseFromHerald rebuilds it from the fold).
  const sense = () => senseFromHerald(senseDeps, herald, workingState);

  const out = await coordinatorRunTick({
    sense,
    makeContext,
    babysit: babysitDeps,
    dispatch: dispatchDeps,
  });

  // Keep the working state across ticks: the handlers mutated out.state.raw in
  // place; on cold start senseFromHerald rebuilt it, so capture the reference.
  workingState = out.state.raw;

  runHeartbeat(out, {
    meta: {
      processor_name: meta.processor_name,
      paired_legate: meta.paired_legate,
      processor_events_path: meta.processor_events_path,
      processor_log_path: meta.processor_log_path,
    },
    heartbeatEventsPath,
    heartbeatLogPath,
    append,
    appendText,
    appendTextSilent,
    setLastHeartbeat: (record: any) => {
      lastHeartbeat = record;
    },
  });
}

function logTickError(err: any) {
  const message = err?.message || String(err);
  emitLoopLog({ severity: "ERROR", body: "processor_error: " + message, eventKind: "processor_error" });
  try {
    appendText(meta.processor_log_path, `[${now()}] processor_error=${message}`);
  } catch {
    console.error(`[${now()}] processor_error=${message}`);
  }
}

// Fold the just-completed tick into the OTel heartbeat metrics. Reads the record
// captured on lastHeartbeat (so the gauges + counters stay in sync with what was
// written to disk). No-op when telemetry is disabled (handled in loop-metrics).
function flushHeartbeatMetrics(durationMs: number, tickAtMs: number) {
  const activity = buildLoopTickActivity(lastHeartbeat, {
    profile: meta.profile,
    conductor: meta.paired_legate || meta.loop_name,
    tickAtMs,
    durationMs,
  });
  if (activity) recordLoopHeartbeat(activity);
}

/**
 * Start the periodic loop. Mirrors the original .mjs bootstrap: log a startup
 * line, replay recent action events, then hand off to the scheduler (which runs
 * an immediate tick and schedules the interval). Returns a handle to stop the
 * timer for graceful shutdown.
 */
export function startLoopRuntime(): { stop: () => void } {
  appendText(
    meta.processor_log_path,
    `[${now()}] legate-loop starting in terminal-pr-maintenance mode for ${meta.paired_legate}`,
  );
  replayRecentActionEvents();
  return scheduler().start();
}
