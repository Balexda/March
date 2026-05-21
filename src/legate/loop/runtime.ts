// @ts-nocheck
/**
 * Legate loop runtime — a near-verbatim lift of the former generated
 * `legate-loop.mjs` (the LEGATE_LOOP_MJS template once in src/legate/init.ts,
 * since deleted in Balexda/March#146). This is now the only loop runtime;
 * `@ts-nocheck` marks it as an intentional mechanical lift whose decomposition +
 * typing is tracked in Balexda/March#144.
 *
 * Changes from the original .mjs (kept minimal and reviewable):
 *   - meta + interval are injected via configureLoopRuntime() instead of being
 *     read relative to import.meta.url (the bundle's url is dist/cli.js).
 *   - per-tick heartbeat metrics (loop-metrics.ts), per-event structured logs
 *     (logs.ts), and dispatch spans (loop-spans.ts) are all emitted via the OTel
 *     SDK; the dispatch spans keep nesting deterministically under the
 *     orchestrator's hatchery.spawn / spawn.* spans via the shared
 *     trace-ids.ts helpers (Balexda/March#145).
 *   - a lastHeartbeat snapshot is exposed for the HTTP /status endpoint.
 */
import fs from "node:fs";
import path from "node:path";
import {
  recordLoopHeartbeat,
  type LoopMetricsSnapshot,
} from "../../observability/loop-metrics.js";
import { emitLoopLog, type LoopLogSeverity } from "../../observability/logs.js";
import { emitLoopSpan } from "../../observability/loop-spans.js";
import {
  getJob,
  HatcheryClientError,
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
import { broodTeardown as broodTeardownCli } from "./clients/brood.js";
import { LegateHerald } from "./clients/herald.js";
// Pure helpers (deduplicated from the lifted runtime — these used to be inline
// copies; the canonical, unit-tested versions live under pure/). #144.
import {
  actionArguments,
  actionCommandLine,
  dispatchBranch,
  dispatchIdentity,
  dispatchSliceId,
  dispatchTitle,
} from "./pure/dispatch-id.js";
import {
  buildDirectStewardMessage,
  buildSmithyRecoverySpawnPrompt,
  buildSmithySpawnPrompt,
} from "./pure/messages.js";
import {
  formatBabysitActionLine,
  formatCleanupFailureLine,
  formatCleanupLine,
  formatProcessorRequestLine,
} from "./pure/format.js";
import { hashText } from "./pure/hash.js";
import {
  bumpRetry,
  parseSessionCollisionError,
  parseSpawnPatchError,
  parseWrongWorktreeRaceError,
  transientRetryCounts,
} from "./pure/recovery.js";

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
function emitTransition(event) {
  Promise.resolve()
    .then(() => legateHerald().append(event))
    .catch(() => {});
}

// Injected at startup by configureLoopRuntime().
let meta: any;
let heartbeatLogPath: string;
let heartbeatEventsPath: string;
let intervalSeconds = 60;

// Latest tick snapshot for the HTTP API + observable metric gauges.
let lastHeartbeat: any = null;
let lastTickAtMs = 0;
let lastTickDurationMs = 0;

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
  return { lastHeartbeat, lastTickAtMs, lastTickDurationMs };
}

/** Run a single tick immediately (used by start + future /tick endpoint). */
export async function runTickOnce(): Promise<void> {
  await safeTick();
}

function now() {
  return new Date().toISOString();
}

function append(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf-8");
  if (file === meta.processor_events_path) {
    maybeEmitLoopSpan(value);
    maybeEmitLoopLog(value);
  }
}

// --- OpenTelemetry (loop-side spans) -------------------------------------
// Dispatch-lifecycle spans are emitted via the OTel SDK tracer (see
// src/observability/loop-spans.ts). Each dispatched unit of work is its own
// trace: trace id = hash(slice id), so these loop spans share a trace with the
// orchestrator's hatchery.spawn / spawn.* spans (which use the same
// deterministic ids). legate.dispatch is the root and claims the deterministic
// span id so the orchestrator spans nest beneath it; babysit/cleanup nest as
// children of that same parent. loop-spans.ts derives those ids from the slice
// id via the shared trace-ids.ts helpers (CLAUDE.md cross-process contract), so
// this layer only classifies events into spans.
function maybeEmitLoopSpan(event) {
  if (!event || typeof event !== "object") return;
  const sliceId = event.slice_id;
  if (!sliceId) return;
  if (event.kind === "dispatch_action" && event.action === "dispatch") {
    emitLoopSpan({ name: "legate.dispatch", traceKey: sliceId, root: true, attributes: { "march.slice_id": sliceId, "march.action": event.action, "march.dispatch_mode": "spawn" } });
  } else if (event.kind === "recovery_dispatch") {
    // Failed-spawn recovery (added with the upstream recovery/direct-steward
    // machinery). Each recovery codex spawn and each no-spawn direct-steward
    // dispatch is its own dispatched unit of work, so it gets its own trace
    // keyed off its recovery-/direct-suffixed slice id. Like a normal dispatch,
    // it is the root span (claims the deterministic span id) so a recovery
    // spawn's hatchery.spawn / spawn.* spans nest beneath it; direct_dispatch
    // has no spawn but stays uniform so the dispatch still shows up as a trace.
    const mode = event.action === "direct_dispatch" ? "direct_steward" : "recovery";
    emitLoopSpan({ name: "legate.dispatch", traceKey: sliceId, root: true, attributes: { "march.slice_id": sliceId, "march.action": event.action || "", "march.dispatch_mode": mode } });
  } else if (event.kind === "dispatch_failure") {
    // launchHatcheryDispatch threw, so the spawn never ran and the orchestrator
    // never emits hatchery.spawn / the spawn metrics. Record the failed launch
    // as an errored root span so the dispatch still surfaces — as a failed trace.
    emitLoopSpan({ name: "legate.dispatch", traceKey: sliceId, root: true, error: true, attributes: { "march.slice_id": sliceId, "march.action": "dispatch", "march.dispatch_mode": "spawn", "march.error": event.error || "dispatch launch failed" } });
  } else if (event.kind === "babysit_action") {
    emitLoopSpan({ name: "legate.babysit", traceKey: sliceId, root: false, attributes: { "march.slice_id": sliceId, "march.action": event.action || "", "march.pr_number": event.pr_number || "" } });
  } else if (event.kind === "cleanup") {
    emitLoopSpan({ name: "legate.cleanup", traceKey: sliceId, root: false, attributes: { "march.slice_id": sliceId, "march.pr_state": event.pr_state || "" } });
  }
}

// Forward each action event written to the action log as a structured log record
// (OTLP -> Loki). Failures map to ERROR; everything else to INFO. Events with a
// slice_id are trace-correlated to their dispatch in Grafana (see logs.ts). The
// per-tick heartbeat is intentionally NOT logged here — it is captured by the
// loop metrics instead — and lands on heartbeatEventsPath, not this path.
function maybeEmitLoopLog(event) {
  if (!event || typeof event !== "object" || !event.kind) return;
  const kind = String(event.kind);
  const severity =
    kind.endsWith("_failure") || kind === "sync_warning" ? "ERROR" : "INFO";
  const detail =
    event.detail || event.error || event.action || event.title || "";
  emitLoopLog({
    severity,
    body: detail ? kind + ": " + detail : kind,
    eventKind: kind,
    sliceId: event.slice_id || undefined,
    attributes: {
      ...(event.action ? { "march.action": String(event.action) } : {}),
      ...(event.pr_number != null
        ? { "march.pr_number": String(event.pr_number) }
        : {}),
      ...(event.session_id ? { "march.session_id": String(event.session_id) } : {}),
    },
  });
}

function appendText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text + "\n", "utf-8");
  console.log(text);
}

// Heartbeat path: writes to disk for liveness checks but does NOT echo to
// stdout. The conductor tmux session would otherwise drown out real events
// with one heartbeat line per tick.
function appendTextSilent(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text + "\n", "utf-8");
}

function printText(text) {
  console.log(text);
}

function replayRecentActionEvents(limit = 10) {
  let raw;
  try {
    raw = fs.readFileSync(meta.processor_events_path, "utf-8");
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  const events = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event?.kind === "cleanup" || event?.kind === "cleanup_failure" || event?.kind === "babysit_action" || event?.kind === "dispatch_action" || event?.kind === "recovery_dispatch" || event?.kind === "processor_request")
    .slice(-limit);
  if (events.length === 0) return;
  printText(`[${now()}] replaying ${events.length} recent processor action event(s) to stdout`);
  for (const event of events) {
    if (event.kind === "cleanup") {
      printText(formatCleanupLine(event, "recent action: "));
    } else if (event.kind === "cleanup_failure") {
      printText(formatCleanupFailureLine(event, "recent action: "));
    } else if (event.kind === "babysit_action") {
      printText(formatBabysitActionLine(event, "recent action: "));
    } else if (event.kind === "dispatch_action") {
      printText("[" + event.ts + "] recent action: dispatch " + event.slice_id + ": " + event.detail);
    } else if (event.kind === "recovery_dispatch") {
      printText("[" + event.ts + "] recent action: recovery-dispatch " + event.slice_id + ": " + event.detail);
    } else {
      printText(formatProcessorRequestLine(event, "recent action: "));
    }
  }
}

async function sendAgentDeckMessage(sessionId, message, _wait = false) {
  // Routed through Castra. Castra's send is fire-and-forget (202); the former
  // --wait/--timeout has no equivalent, which is fine — every loop caller used
  // the no-wait path.
  await castra().sendPrompt({ profile: meta.profile, sessionId, prompt: message });
  return "";
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

async function requestLegateJudgement(input) {
  if (input.slice && input.requestKey && input.slice.last_processor_request_key === input.requestKey) {
    return null;
  }
  const event = {
    schema_version: 1,
    ts: input.ts,
    processor: meta.processor_name,
    paired_legate: meta.paired_legate,
    kind: "processor_request",
    slice_id: input.sliceId,
    session_id: input.sessionId || null,
    pr_number: input.pr?.number ?? input.prNumber ?? null,
    reason: input.reason,
    detail: input.detail,
  };
  append(meta.processor_requests_path, event);
  append(meta.processor_events_path, event);
  const delivered = await sendDoorbellToLegate();
  appendText(meta.processor_log_path, `${formatProcessorRequestLine(event)}${delivered ? "" : " (doorbell delivery failed)"}`);
  if (input.slice && input.requestKey) {
    input.slice.last_processor_request_key = input.requestKey;
    input.slice.last_processor_request_at = input.ts;
  }
  return event;
}

// Cap on codex-spawn recovery dispatches per original slice before the loop
// stops fighting the spawn path. Two attempts is enough to distinguish a
// fluky worker (first attempt missed the checkbox) from a systemic codex
// problem (truncated patches, the prompt not taking). After this we fall
// back to a direct, no-spawn steward dispatch (see handleRecoveryDispatch) —
// the old mini-legate style of handing the /smithy.<verb> command straight
// to a Claude steward that does the whole job itself.
const MAX_RECOVERY_ATTEMPTS = 2;

// Launch a codex spawn through the Hatchery SERVICE (#144 phase 2b). POSTs the
// spawn request via the async Hatchery client and returns the server job id;
// completePendingHatcheryDispatches polls that id with getJob() across ticks
// until the job reaches a terminal state. This replaced the former detached
// `node -e` runner + on-disk result-file IPC — there is no subprocess and no
// result/request/log files; the loop talks to the service directly over HTTP.
//
// POST /spawns returns 202 immediately (the server runs the spawn in the
// background), so this stays non-blocking for the tick. repoPath must be valid
// INSIDE the hatchery container — it bind-mounts the repo + worktree-parent at
// the identical absolute path. Telemetry is owned by the service; the dispatch
// trace is correlated server-side via sliceId (the same deterministic-id scheme).
async function launchHatcheryDispatch(item, opts) {
  const repoPath = meta.repo?.path;
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new Error("repo path is missing");
  }
  const dispatchIdent = dispatchIdentity(item);
  const branch = opts?.branchOverride || dispatchBranch(item);
  const title = opts?.titleOverride || dispatchTitle(item);
  const prompt = opts?.promptOverride || buildSmithySpawnPrompt(item);
  const requestSliceId = opts?.requestSliceIdOverride || dispatchSliceId(item);
  const spawnRequest = {
    prompt,
    backend: "codex",
    repoPath,
    agentDeckProfile: meta.profile,
    managerGroup: meta.worker_group,
    title,
    branch,
    profile: meta.profile,
    taskType: dispatchIdent.verb,
    taskName: dispatchIdent.stem,
    sliceId: requestSliceId,
  };
  const created = await postSpawn(resolveHatcheryUrl(process.env), spawnRequest);
  return { jobId: created.id };
}

// Direct-steward dispatch: the no-spawn fallback. Launches a plain Claude
// steward on a fresh worktree+branch and hands it the /smithy.<verb> command
// as the initial message. Reliable but slower/less parallel than codex spawn.
// Returns {launched, sliceId, sessionId, error}. Mutates state.slices on
// success so babysit/cleanup track the steward like any other.
// `opts.branchBase` / `opts.title` let a caller that only holds a slice (not the
// original smithy item) supply the identity directly — the spawn-error fallback
// passes slice.branch / slice.worker_title, which equal dispatchBranch(item) /
// dispatchTitle(item) from the original dispatch, so the -direct branch stays
// tied to the slice's semantic identity.
async function launchDirectStewardDispatch(state, ts, item, sliceId, mergedArchive, opts) {
  const repoPath = state?.repo?.path || meta.repo?.path;
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    return { launched: false, error: "repo path is missing" };
  }
  const branchBase = (opts && typeof opts.branchBase === "string" && opts.branchBase) ? opts.branchBase : dispatchBranch(item);
  const titleBase = (opts && typeof opts.title === "string" && opts.title) ? opts.title : dispatchTitle(item);
  const bareBranch = branchBase + "-direct";
  const directSliceId = sliceId + "-direct";
  const title = "direct: " + titleBase;
  const message = buildDirectStewardMessage(item, mergedArchive);

  // Launch via Castra: it runs agent-deck launch, identifies the new session
  // (with the worktree-race conflict guard), and sets auto-mode server-side, then
  // returns the session. A 409 (conflict) surfaces as a launch error so the slice
  // re-dispatches next tick — same as the old client-side race handling.
  let launchedSession = null;
  try {
    launchedSession = await castra().launchSession({
      profile: meta.profile,
      repoPath,
      branch: bareBranch,
      title,
      group: meta.worker_group,
      model: "opus",
      traceKey: directSliceId,
    });
  } catch (err) {
    return { launched: false, sliceId: directSliceId, error: "castra launch failed: " + (err?.message || String(err)).slice(0, 200) };
  }
  const newSessionId = launchedSession?.sessionId || null;
  if (!newSessionId) {
    return { launched: false, sliceId: directSliceId, error: "castra launch returned no identifiable new session" };
  }
  // Deliver the initial /smithy.<verb> instruction (Castra launch has no message
  // param, so send it as a follow-up).
  try {
    await castra().sendPrompt({ profile: meta.profile, sessionId: newSessionId, prompt: message, traceKey: directSliceId });
  } catch {
    // Best-effort; babysit will re-nudge if the steward never starts.
  }
  const action = item.next_action || {};
  // Castra owns the checkout (#144 phase 2c): take the worktree path + real
  // branch from the validated launch response instead of reconstructing the
  // WorkTrees/feature-* layout here. Mirrors the Hatchery completion path, which
  // also reads worktreePath/branch off the spawn result and tolerates null.
  state.slices[directSliceId] = {
    kind: "smithy",
    worker_session_id: newSessionId,
    worker_title: title,
    branch: bareBranch,
    actual_branch: launchedSession.branch || null,
    worktree_path: launchedSession.worktreePath || null,
    stage: "implementing",
    implementing_started_at: ts,
    pr: null,
    command: action.command,
    arguments: actionArguments(action),
    artifact_path: item.path || null,
    dispatch_mode: "direct-steward",
    original_slice_id: sliceId,
    prior_pr_number: mergedArchive?.pr?.number || null,
    prior_pr_url: mergedArchive?.pr?.url || null,
    last_action: ts,
    last_action_note: "direct steward dispatch (no spawn) for " + actionCommandLine(action),
  };
  return { launched: true, sliceId: directSliceId, sessionId: newSessionId };
}

// If the hatchery runner dies before writing its result file, the slice would
// otherwise sit in hatchery-pending forever. After this many ms with no result,
// escalate so an operator can investigate. 15 minutes is generous — a healthy
// codex spawn completes within a couple of minutes.
const HATCHERY_PENDING_TIMEOUT_MS = 15 * 60 * 1000;

// Race-victim recovery: the wrong-worktree refusal is by design transient
// (the race resolves once concurrent launches finish), so escalating would
// strand the slice on operator review for a problem that fixes itself.
// Auto-release by deleting the slice, bump a per-slice counter, and only
// fall through to escalation if the same slice keeps losing the race.
// Retry limit is 3: each retry costs one tick (60s) + codex spawn time, so
// if the race won't resolve in 3 tries the operator needs to know.
function tryRecoverWrongWorktreeRace(state, slice, sliceId, errorText) {
  if (!parseWrongWorktreeRaceError(errorText)) return null;
  const limit = 3;
  const { exhausted, count } = bumpRetry(transientRetryCounts(state), sliceId, limit);
  if (exhausted) {
    return {
      recovered: false,
      verdict: "wrong-worktree-race-persistent",
      detail: "wrong-worktree race recurred " + count + " times for this slice; auto-release exhausted, escalating for operator review",
    };
  }
  emitTransition({ type: "retry.counted", key: sliceId, count });
  delete state.slices[sliceId];
  return {
    recovered: true,
    verdict: "wrong-worktree-race",
    detail: "agent-deck launch race detected (attempt " + count + "/" + limit + "); slice released for re-dispatch on next tick",
  };
}

// Session-collision recovery: the steward launch failed because an agent-deck
// session with this slice's title already exists — a ghost left by a previous
// launch that died after creating the session (Brood never registered it, so
// ghost-cleanup defers under #155 and the collision blocks every re-dispatch).
// Reclaim it: remove the ghost via Castra (the loop's own client; the deliberate
// exception to "defer to Brood" — the id is named in the error and is provably
// the thing blocking this exact slice) + prune its worktree, then release the
// slice for a clean re-dispatch.
async function tryRecoverSessionCollision(state, slice, sliceId, errorText) {
  const sessionId = parseSessionCollisionError(errorText);
  if (!sessionId) return null;
  try {
    await castra().removeSession({ profile: meta.profile, sessionId, pruneWorktree: true });
  } catch (err) {
    return { recovered: false, verdict: "session-collision-remove-failed", detail: "ghost session " + sessionId + " remove failed: " + (err?.message || String(err)).slice(0, 200) };
  }
  delete state.slices[sliceId];
  return { recovered: true, verdict: "session-collision", detail: "removed colliding ghost session " + sessionId + " (worktree pruned); slice released for re-dispatch" };
}

// Codex spawn-error recovery: re-running codex on a patch-apply failure
// (parseSpawnPatchError) typically produces a different (often correct) output,
// so retry with a per-slice counter and escalate only if it persists.
function tryRecoverSpawnPatchError(state, slice, sliceId, errorText) {
  if (!parseSpawnPatchError(errorText)) return null;
  // Codex patch errors are deeply non-deterministic — same prompt, different
  // output each run. Give it a generous budget before declaring the artifact
  // genuinely undispatchable. The cost of each retry is one codex container
  // (~2-3 min), and we'd rather burn an hour of compute than strand a slice
  // that would have succeeded on attempt 7.
  const limit = 10;
  const key = "spawn-error:" + sliceId;
  const { exhausted, count } = bumpRetry(transientRetryCounts(state), key, limit);
  if (exhausted) {
    return {
      recovered: false,
      verdict: "spawn-error-persistent",
      detail: "codex spawn produced an unapplicable patch " + count + " times for this slice; auto-release exhausted, escalating for operator review",
    };
  }
  emitTransition({ type: "retry.counted", key, count });
  delete state.slices[sliceId];
  return {
    recovered: true,
    verdict: "spawn-error-retry",
    detail: "codex spawn patch error (attempt " + count + "/" + limit + "); slice released for re-dispatch on next tick",
  };
}

async function completePendingHatcheryDispatches(state, ts) {
  const actions = [];
  const failures = [];
  const notifications = [];
  let mutated = false;
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const nowMs = Date.parse(ts);
  const queueDispatchEscalation = (slice, sliceId, reason, error) => {
    // Build a stable requestKey so requestLegateJudgement only fires once per
    // distinct failure mode. Without notification the agent never wakes and
    // the operator sees "loop is silent" while escalated slices pile up
    // unobserved.
    const key = "hatchery-failure:" + sliceId + ":" + reason + ":" + hashText(String(error || "")).slice(0, 12);
    notifications.push({
      slice, sliceId, requestKey: key,
      reason: "hatchery_dispatch_failed",
      detail: "Hatchery dispatch for " + actionCommandLine({ command: slice.command, arguments: slice.arguments || [] }) + " escalated: " + reason + ".\n\nError:\n" + String(error || "(no detail)").trim() + "\n\nSlice has been marked escalated (slice.escalated transition event). The loop no longer auto-recovers branch/worktree collisions (Brood owns worktree+branch teardown by exact path, #155): for a 'branch already exists' / diverged-branch error, load legate.unwedge and inspect the stale branch + worktree, then request Brood teardown of the orphan before re-dispatch. Otherwise run legate.error for worker-side recovery.",
    });
  };
  const escalateStale = (slice, sliceId, reason) => {
    const queuedMs = Date.parse(slice.last_action || "");
    if (!Number.isFinite(queuedMs) || !Number.isFinite(nowMs)) return false;
    if (nowMs - queuedMs <= HATCHERY_PENDING_TIMEOUT_MS) return false;
    const ageMin = Math.round((nowMs - queuedMs) / 60000);
    // The Hatchery job never reached a terminal state within the timeout —
    // the spawn service lost the job (a restart mid-spawn) or is wedged. This
    // is usually transient, so auto-clear the slice and let it re-dispatch,
    // capped by a per-slice retry counter; only a repeat offender escalates.
    const limit = 3;
    const key = "hatchery-stale:" + sliceId;
    const { exhausted, count } = bumpRetry(transientRetryCounts(state), key, limit);
    if (!exhausted) {
      emitTransition({ type: "retry.counted", key, count });
      actions.push({
        action: "auto-recovered",
        sliceId,
        sessionId: null,
        detail: "hatchery job " + reason + " after " + ageMin + " min (attempt " + count + "/" + limit + "); slice released for re-dispatch",
      });
      delete state.slices[sliceId];
      return true;
    }
    const note = "NEED: Hatchery job " + reason + " after " + ageMin + " min and " + limit + " auto-retry attempts; the spawn service is not completing the job — manual investigation required";
    slice.stage = "escalated";
    emitTransition({ type: "slice.escalated", sliceId, reason: "hatchery-stale-persistent" });
    slice.last_action = ts;
    slice.last_action_note = note;
    failures.push({ slice_id: sliceId, command: actionCommandLine({ command: slice.command, arguments: slice.arguments || [] }), error: note });
    queueDispatchEscalation(slice, sliceId, "hatchery-stale-persistent", note);
    return true;
  };
  const hatcheryBaseUrl = resolveHatcheryUrl(process.env);
  for (const [sliceId, slice] of Object.entries(slices)) {
    if (!slice || typeof slice !== "object" || slice.stage !== "hatchery-pending") continue;
    const jobId = slice.hatchery?.job_id;
    if (typeof jobId !== "string" || jobId.length === 0) continue;
    let job;
    try {
      // Poll the Hatchery job over HTTP (#144 phase 2b) — the former on-disk
      // result file is gone; the service is the source of truth for the spawn.
      job = await getJob(hatcheryBaseUrl, jobId);
    } catch (err) {
      // The service is unreachable, or no longer knows this job (a restart
      // dropped it). Treat like a stale job: a transient blip before the
      // timeout just waits; past it the slice is released / escalated.
      const reason = err instanceof HatcheryClientError ? "is unreachable" : "lookup failed";
      if (escalateStale(slice, sliceId, reason)) mutated = true;
      continue;
    }
    if (job.status !== "succeeded" && job.status !== "failed") {
      // Still pending/running — wait for it. If it never reaches a terminal
      // state within the timeout, escalateStale treats it as a wedged job.
      if (escalateStale(slice, sliceId, "did not reach a terminal state")) mutated = true;
      continue;
    }
    // Map the terminal job to the result shape the completion logic below reads:
    // the inner HatcherySpawnResult on success, an { error } on failure.
    const result = job.status === "failed"
      ? { error: job.error?.message || "hatchery spawn failed" }
      : (job.result || {});
    if (result.error) {
      const errorText = String(result.error).trim();
      // Branch/worktree-collision recovery (auto-delete, open-PR adoption,
      // stranded-leftover cleanup) was removed in #144 phase 2 — the legate no
      // longer reads or mutates git branches/worktrees directly (Brood owns that,
      // #155). Such collisions now escalate to the operator below. The two
      // recoveries kept here act only through services / in-memory state:
      // ghost-session reclamation goes through Castra, and wrong-worktree-race /
      // spawn-patch retries are pure retry-counter releases.
      //
      // Ghost-session collision (agent-deck "session already exists"): reclaim
      // the named ghost via Castra so the slice can re-dispatch with a fresh steward.
      const sessionRecovery = await tryRecoverSessionCollision(state, slice, sliceId, errorText);
      if (sessionRecovery && sessionRecovery.recovered) {
        actions.push({
          action: "auto-recovered",
          sliceId,
          sessionId: null,
          detail: sessionRecovery.verdict + " auto-recovered: " + sessionRecovery.detail,
        });
        mutated = true;
        continue;
      }
      // Branch/worktree-collision auto-recovery was removed in #144 phase 2: the
      // legate no longer does its own git/gh worktree+branch forensics or surgery
      // (that is Brood's exact-path teardown authority, #155). A "branch already
      // exists" / diverged-leftover collision now falls straight through to the
      // operator escalation below instead of being auto-deleted.
      //
      // Wrong-worktree launch-race recovery (state-only; no git surgery): the
      // upstream agent-deck launch race auto-releases the slice for re-dispatch.
      const raceRecovery = tryRecoverWrongWorktreeRace(state, slice, sliceId, errorText);
      if (raceRecovery && raceRecovery.recovered) {
        actions.push({
          action: "auto-recovered",
          sliceId,
          sessionId: null,
          detail: raceRecovery.verdict + ": " + raceRecovery.detail,
        });
        mutated = true;
        continue;
      }
      // Spawn-error recovery: corrupt-patch and "already exists in index"
      // failures originate in codex's output and are typically transient
      // (re-running produces different output). Retry up to 10 times via
      // the same transient_retry_counts machinery, then fall back to a
      // no-spawn direct steward dispatch (below) instead of escalating.
      const spawnRecovery = raceRecovery ? null : tryRecoverSpawnPatchError(state, slice, sliceId, errorText);
      if (spawnRecovery && spawnRecovery.recovered) {
        actions.push({
          action: "auto-recovered",
          sliceId,
          sessionId: null,
          detail: spawnRecovery.verdict + ": " + spawnRecovery.detail,
        });
        mutated = true;
        continue;
      }
      // Spawn-error fallback (issue #139): codex has now failed to produce an
      // applicable patch the full retry budget (verdict spawn-error-persistent)
      // — for some large-diff artifacts the per-attempt success rate is near
      // zero, so more retries never land. Rather than escalate to the operator,
      // fall back ONCE to the no-spawn direct steward dispatch — hand the
      // /smithy.<verb> command straight to a Claude steward that implements
      // end-to-end and opens the PR (a larger output window, no patch to apply).
      // This is the same fallback handleRecoveryDispatch uses after
      // MAX_RECOVERY_ATTEMPTS; the shared state.direct_dispatch_done guard
      // (keyed on the original slice id) ensures we never double-fire it.
      if (spawnRecovery && !spawnRecovery.recovered && spawnRecovery.verdict === "spawn-error-persistent") {
        state.direct_dispatch_done = state.direct_dispatch_done && typeof state.direct_dispatch_done === "object"
          ? state.direct_dispatch_done
          : {};
        const baseSliceId = slice.original_slice_id || sliceId;
        const directItem = {
          next_action: { command: slice.command, arguments: slice.arguments || [] },
          path: slice.artifact_path || null,
          title: slice.worker_title || null,
        };
        const commandLine = actionCommandLine({ command: slice.command, arguments: slice.arguments || [] });
        if (!state.direct_dispatch_done[baseSliceId]) {
          const direct = await launchDirectStewardDispatch(state, ts, directItem, baseSliceId, null, {
            branchBase: slice.branch || null,
            title: slice.worker_title || null,
          });
          if (direct.launched) {
            state.direct_dispatch_done[baseSliceId] = ts;
            delete state.slices[sliceId];
            actions.push({
              action: "direct_dispatch",
              sliceId: direct.sliceId,
              sessionId: direct.sessionId || null,
              detail: "codex spawn produced an unapplicable patch for " + sliceId
                + " (spawn-error budget exhausted); fell back to a no-spawn direct steward dispatch of " + commandLine,
            });
            mutated = true;
            continue;
          }
          // Fallback couldn't launch — escalate with both failure modes so the
          // operator sees the spawn-error history and the launch error.
          slice.stage = "escalated";
          slice.last_action = ts;
          slice.last_action_note = "NEED: codex spawn-error-persistent for " + commandLine
            + " AND the no-spawn direct steward fallback failed to launch: " + (direct.error || "(unknown)");
          failures.push({ slice_id: sliceId, command: commandLine, error: slice.last_action_note });
          queueDispatchEscalation(slice, sliceId, "spawn-error-persistent-direct-failed", spawnRecovery.detail + " | direct fallback error: " + (direct.error || "(unknown)"));
          mutated = true;
          continue;
        }
        // A direct steward was already dispatched for this artifact and codex is
        // STILL failing — no fallback left, escalate for a human.
        slice.stage = "escalated";
        slice.last_action = ts;
        slice.last_action_note = "NEED: codex spawn-error-persistent for " + commandLine
          + " and a no-spawn direct steward fallback was already attempted for " + baseSliceId
          + "; manual intervention required";
        failures.push({ slice_id: sliceId, command: commandLine, error: slice.last_action_note });
        queueDispatchEscalation(slice, sliceId, "spawn-error-persistent-exhausted", spawnRecovery.detail);
        mutated = true;
        continue;
      }
      const effectiveRecovery = raceRecovery || spawnRecovery || sessionRecovery;
      const detail = effectiveRecovery ? errorText + "\n\nLoop verdict: " + effectiveRecovery.detail : errorText;
      slice.stage = "escalated";
      slice.last_action = ts;
      slice.last_action_note = "NEED: Hatchery dispatch failed: " + detail;
      failures.push({ slice_id: sliceId, command: actionCommandLine({ command: slice.command, arguments: slice.arguments || [] }), error: detail });
      const reasonTag = sessionRecovery
        ? sessionRecovery.verdict
        : (raceRecovery ? raceRecovery.verdict : (spawnRecovery ? spawnRecovery.verdict : "spawn-error"));
      emitTransition({ type: "slice.escalated", sliceId, reason: reasonTag });
      queueDispatchEscalation(slice, sliceId, reasonTag, detail);
      mutated = true;
      continue;
    }
    const manager = result.managerSession || {};
    const artifacts = result.artifacts || {};
    stageDispatchMessage(sliceId, result);
    slice.worker_session_id = manager.sessionId || null;
    slice.worker_title = manager.title || slice.worker_title;
    slice.branch = result.branch || manager.branch || slice.branch;
    slice.worktree_path = manager.worktreePath || null;
    slice.stage = "implementing";
    emitTransition({ type: "slice.stage.changed", sliceId, stage: "implementing" });
    slice.hatchery = {
      ...(slice.hatchery || {}),
      spawn_id: result.spawnId,
      backend: result.backend || "codex",
      artifacts_dir: artifacts.dir || null,
      patch_path: artifacts.patchPath || null,
      spawn_output_path: artifacts.spawnOutputPath || null,
      metadata_path: artifacts.metadataPath || null,
    };
    slice.last_action = ts;
    slice.last_action_note = "Hatchery codex spawn completed and handed off to manager";
    // Stable handoff timestamp so stranded-steward detection can measure
    // elapsed time without being reset by subsequent last_action updates.
    slice.implementing_started_at = ts;
    // Clear ALL transient retry counters for this slice — wrong-worktree
    // race (keyed plain), spawn-error, stranded-leftover, runner-silent
    // (each keyed as "<error>:<sliceId>"). The slice has cleanly transitioned
    // to implementing, so any prior transient failures are no longer relevant.
    if (state.transient_retry_counts && typeof state.transient_retry_counts === "object") {
      delete state.transient_retry_counts[sliceId];
      for (const k of Object.keys(state.transient_retry_counts)) {
        if (k.endsWith(":" + sliceId)) delete state.transient_retry_counts[k];
      }
    }
    actions.push({
      action: "dispatch-complete",
      sliceId,
      sessionId: manager.sessionId || null,
      detail: "Hatchery codex spawn completed for " + actionCommandLine({ command: slice.command, arguments: slice.arguments || [] }),
    });
    mutated = true;
  }
  return { actions, failures, mutated, notifications };
}

function stageDispatchMessage(sliceId, result) {
  const base = meta.legate_conductor_dir;
  if (typeof base !== "string" || base.length === 0) return null;
  const target = path.join(base, "dispatch-msg-" + sliceId + ".md");
  const managerPromptPath = result?.artifacts?.managerPromptPath;
  let body = "";
  if (typeof managerPromptPath === "string" && managerPromptPath.length > 0) {
    try {
      body = fs.readFileSync(managerPromptPath, "utf-8");
    } catch {
      body = "";
    }
  }
  if (!body) body = "Continue the Hatchery manager handoff for slice " + sliceId + ". The Hatchery patch has already been applied and staged in this worktree if the handoff completed. Inspect git status and the staged diff, verify, commit, push, and open the PR.";
  fs.writeFileSync(target, body.trimEnd() + "\n", "utf-8");
  return target;
}

// Detect-and-act for the partial-merge dedup wedge. Caller has confirmed
// (a) smithy still reports item as ready, (b) a MERGED archive entry
// collides with the would-be slice id, (c) no live recovery is already in
// flight. We mint a recovery-N slice id and branch, persist the attempt
// counter, build a recovery-flavored spawn prompt, and launch hatchery the
// same way runDispatch does for a normal slice. After MAX_RECOVERY_ATTEMPTS
// we stop dispatching and instead nudge the legate agent — at that point a
// human needs to look (spec is wrong, prompt is failing, or the work is
// genuinely impossible).
async function handleRecoveryDispatch(state, ts, item, sliceId, mergedArchive) {
  const actions = [];
  const failures = [];
  const notifications = [];
  state.recovery_attempts = state.recovery_attempts && typeof state.recovery_attempts === "object"
    ? state.recovery_attempts
    : {};
  state.direct_dispatch_done = state.direct_dispatch_done && typeof state.direct_dispatch_done === "object"
    ? state.direct_dispatch_done
    : {};

  const priorAttempts = Number(state.recovery_attempts[sliceId]) || 0;
  const attempt = priorAttempts + 1;
  const recoverySliceId = sliceId + "-recovery-" + attempt;

  if (attempt > MAX_RECOVERY_ATTEMPTS) {
    // The codex spawn path has failed MAX_RECOVERY_ATTEMPTS times for this
    // slice. Fall back ONCE to a direct, no-spawn steward dispatch — hand the
    // /smithy.<verb> command straight to a Claude steward (old mini-legate
    // style). It's slower but doesn't depend on codex producing an applicable
    // patch, which is the thing that keeps failing.
    if (!state.direct_dispatch_done[sliceId]) {
      const direct = await launchDirectStewardDispatch(state, ts, item, sliceId, mergedArchive);
      if (direct.launched) {
        state.direct_dispatch_done[sliceId] = ts;
        actions.push({
          action: "direct_dispatch",
          sliceId: direct.sliceId,
          sessionId: direct.sessionId || null,
          detail: "codex spawn failed " + priorAttempts + "x; fell back to a no-spawn direct steward dispatch of "
            + actionCommandLine(item.next_action)
            + (mergedArchive?.pr?.number ? " (prior partial PR #" + mergedArchive.pr.number + ")" : ""),
        });
        emitTransition({ type: "slice.recovery.dispatched", sliceId: direct.sliceId });
      } else {
        failures.push({ slice_id: sliceId, command: actionCommandLine(item.next_action), error: direct.error || "direct dispatch failed" });
        notifications.push({
          slice: mergedArchive, sliceId,
          requestKey: "direct-dispatch-failed:" + sliceId + ":" + hashText(String(direct.error || "")).slice(0, 12),
          reason: "direct_dispatch_failed",
          detail: "Codex spawn failed " + priorAttempts + "x for " + sliceId + " and the no-spawn direct steward fallback ALSO failed to launch: "
            + (direct.error || "(unknown)") + ". Manual intervention required.",
        });
      }
      return { actions, failures, notifications };
    }
    // Direct dispatch was already attempted and we're STILL being asked to
    // recover this slice (its direct PR merged without finishing, or smithy
    // still reports it ready). No fallback left — escalate for a human.
    notifications.push({
      slice: mergedArchive, sliceId,
      requestKey: "recovery-exhausted:" + sliceId + ":post-direct",
      reason: "recovery_dispatch_exhausted",
      detail: "Recovery for " + sliceId + " is exhausted: " + MAX_RECOVERY_ATTEMPTS + " codex spawn attempts AND a "
        + "no-spawn direct steward dispatch all failed to complete the work (smithy still reports "
        + (item.path || "the artifact") + " as ready). The spec may be wrong or the work genuinely blocked — "
        + "inspect the prior PRs and the artifact, then clear state.recovery_attempts[\"" + sliceId + "\"] "
        + "and state.direct_dispatch_done[\"" + sliceId + "\"] to retry.",
    });
    return { actions, failures, notifications };
  }

  try {
    // syncDefaultBranch already ran at the top of runDispatch; no need
    // to re-fetch per recovery dispatch.
    const action = item.next_action || {};
    const recoveryBranch = dispatchBranch(item) + "-recovery-" + attempt;
    const recoveryTitle = "recovery(" + attempt + "): " + dispatchTitle(item);
    state.slices[recoverySliceId] = {
      kind: "smithy",
      worker_session_id: null,
      worker_title: recoveryTitle,
      branch: recoveryBranch,
      actual_branch: null,
      worktree_path: null,
      stage: "hatchery-pending",
      pr: null,
      command: action.command,
      arguments: actionArguments(action),
      artifact_path: item.path || null,
      hatchery: {
        backend: "codex",
      },
      original_slice_id: sliceId,
      recovery_attempt: attempt,
      prior_pr_number: mergedArchive?.pr?.number || null,
      prior_pr_url: mergedArchive?.pr?.url || null,
      prior_branch: mergedArchive?.branch || mergedArchive?.actual_branch || null,
      last_action: ts,
      last_action_note: "Queued Hatchery recovery codex spawn (attempt " + attempt + ") for " + actionCommandLine(action),
    };
    state.recovery_attempts[sliceId] = attempt;
    const launched = await launchHatcheryDispatch(item, {
      branchOverride: recoveryBranch,
      titleOverride: recoveryTitle,
      promptOverride: buildSmithyRecoverySpawnPrompt(item, mergedArchive, attempt),
      requestSliceIdOverride: recoverySliceId,
    });
    state.slices[recoverySliceId].hatchery.job_id = launched.jobId;
    actions.push({
      action: "recovery_dispatch",
      sliceId: recoverySliceId,
      sessionId: null,
      detail: "queued Hatchery recovery codex spawn job " + launched.jobId
        + " (attempt " + attempt + " of " + MAX_RECOVERY_ATTEMPTS + ") "
        + "for " + actionCommandLine(action)
        + (mergedArchive?.pr?.number ? "; prior PR #" + mergedArchive.pr.number : ""),
    });
    emitTransition({ type: "slice.recovery.dispatched", sliceId: recoverySliceId, branch: recoveryBranch });
  } catch (err) {
    const error = err?.message || String(err);
    const existing = state.slices?.[recoverySliceId];
    if (existing && existing.stage === "hatchery-pending") {
      existing.stage = "escalated";
      existing.last_action = ts;
      existing.last_action_note = "NEED: Hatchery recovery dispatch launch failed: " + error;
      emitTransition({ type: "slice.escalated", sliceId: recoverySliceId, reason: "hatchery_recovery_dispatch_failed" });
      notifications.push({
        slice: existing, sliceId: recoverySliceId,
        requestKey: "hatchery-failure:" + recoverySliceId + ":launch-throw:" + hashText(error).slice(0, 12),
        reason: "hatchery_recovery_dispatch_failed",
        detail: "Hatchery recovery dispatch launch threw for " + actionCommandLine(item.next_action)
          + " (recovery attempt " + attempt + ").\n\nError:\n" + error
          + "\n\nSlice is escalated. legate.unwedge / legate.error as appropriate.",
      });
    }
    failures.push({
      slice_id: recoverySliceId,
      command: actionCommandLine(item.next_action),
      error,
    });
  }
  return { actions, failures, notifications };
}

// Fresh-dispatch launch for one ready item: create the hatchery-pending slice,
// fire the codex spawn, and return the action (or escalate + a notification on a
// launch throw). The dispatch handler's apply() calls this via DispatchDeps.
async function launchDispatch(state, ts, item, sliceId) {
  const actions = [];
  const failures = [];
  const notifications = [];
  try {
    const action = item.next_action || {};
    state.slices[sliceId] = {
      kind: "smithy",
      worker_session_id: null,
      worker_title: dispatchTitle(item),
      branch: dispatchBranch(item),
      actual_branch: null,
      worktree_path: null,
      stage: "hatchery-pending",
      pr: null,
      command: action.command,
      arguments: actionArguments(action),
      artifact_path: item.path || null,
      hatchery: {
        backend: "codex",
      },
      last_action: ts,
      last_action_note: "Queued Hatchery codex spawn for " + actionCommandLine(action),
    };
    const launched = await launchHatcheryDispatch(item);
    state.slices[sliceId].hatchery.job_id = launched.jobId;
    actions.push({
      action: "dispatch",
      sliceId,
      sessionId: null,
      detail: "queued Hatchery codex spawn job " + launched.jobId + " for " + actionCommandLine(action),
    });
    emitTransition({ type: "slice.dispatched", sliceId, branch: dispatchBranch(item) });
  } catch (err) {
    const error = err?.message || String(err);
    const existing = state.slices?.[sliceId];
    if (existing && existing.stage === "hatchery-pending") {
      existing.stage = "escalated";
      existing.last_action = ts;
      existing.last_action_note = "NEED: Hatchery dispatch launch failed: " + error;
      emitTransition({ type: "slice.escalated", sliceId, reason: "hatchery_dispatch_failed" });
      notifications.push({
        slice: existing, sliceId,
        requestKey: "hatchery-failure:" + sliceId + ":launch-throw:" + hashText(error).slice(0, 12),
        reason: "hatchery_dispatch_failed",
        detail: "Hatchery dispatch launch threw for " + actionCommandLine(item.next_action) + ".\n\nError:\n" + error + "\n\nSlice is escalated. For 'branch already exists' surface this via legate.unwedge; otherwise legate.error.",
      });
    }
    failures.push({ slice_id: sliceId, command: actionCommandLine(item.next_action), error });
    append(meta.processor_events_path, {
      schema_version: 1,
      ts,
      processor: meta.processor_name,
      paired_legate: meta.paired_legate,
      kind: "dispatch_failure",
      slice_id: sliceId,
      command: actionCommandLine(item.next_action),
      error,
    });
    appendText(meta.processor_log_path, "[" + ts + "] dispatch failed " + sliceId + ": " + error);
  }
  return { actions, failures, mutated: true, notifications };
}

// `march` CLI runner for the Brood seam, honoring meta.march_cli_path (the
// container's baked-in path) and capturing exit + streams for broodTeardown.
// Two-stage tick: Stage 1 senseFromHerald drains the inbox + folds the working
// state; the coordinator runs
// the ordered handlers (cleanup → ghost-cleanup → relaunch → babysit → dispatch)
// as pure assess + effecting apply; the heartbeat writes the record + events and
// snapshots it for /status. All I/O is wired to the proven async seams in this
// file (Castra fetch, gh/git/smithy execFile, the Brood HTTP client).
async function tick() {
  // Stage 1 reads are the shared observation I/O (src/observe/sense-io.ts).
  const senseDeps = senseIo().toSenseDeps();
  const herald = legateHerald();

  const makeContext = (state) => ({
    meta,
    ts: state.ts,
    castra: castra(),
    // Brood is a service; broodTeardown hits it over HTTP via the async
    // BroodClient (MARCH_BROOD_URL). No CLI shelling.
    broodTeardown: (sessionId, opts) => broodTeardownCli(sessionId, opts),
    emit: (event) => append(meta.processor_events_path, event),
    // Herald transition events (#176): the sole durable record of a transition
    // now that state.json is retired. The in-memory working state is mutated by
    // the handlers directly and reconstructed from these events on cold start.
    emitTransition: (event) => emitTransition(event),
    log: (line) => appendText(meta.processor_log_path, line),
  });

  const babysitDeps = {
    sendMessage: (sessionId, message) => sendAgentDeckMessage(sessionId, message, false),
    requestJudgement: (input) => requestLegateJudgement(input),
  };

  const dispatchDeps = {
    // The default-branch sync is owned by Herald (MARCH_HERALD_SYNC); the legate
    // never fetches so it can't fight it.
    syncDefaultBranch: async () => {},
    completePending: (rawState, ts) => completePendingHatcheryDispatches(rawState, ts),
    launchDispatch: (rawState, ts, item, sliceId) => launchDispatch(rawState, ts, item, sliceId),
    recoveryDispatch: (rawState, ts, item, sliceId, mergedArchive) =>
      handleRecoveryDispatch(rawState, ts, item, sliceId, mergedArchive),
    requestJudgement: (input) => requestLegateJudgement(input),
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
    setLastHeartbeat: (record) => {
      lastHeartbeat = record;
    },
  });
}

function logTickError(err) {
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
function flushHeartbeatMetrics(durationMs: number) {
  const record: any = lastHeartbeat;
  if (!record) return;
  const workersByState: Record<string, number> = {};
  if (record.workers && typeof record.workers === "object") {
    for (const [state, count] of Object.entries(record.workers)) {
      if (typeof count === "number") workersByState[state] = count;
    }
  }
  const snapshot: LoopMetricsSnapshot = {
    profile: meta.profile || "unknown",
    conductor: meta.paired_legate || meta.loop_name || "unknown",
    up: 1,
    lastTickAtMs,
    queueDispatchable: record.dispatchable_count ?? 0,
    queueBlocked: record.blocked_count ?? 0,
    queueTotal: record.pending_total ?? 0,
    workersByState,
  };
  recordLoopHeartbeat({
    snapshot,
    tickDurationSeconds: durationMs / 1000,
    dispatchActions: record.dispatch_action_count ?? 0,
    dispatchFailures: record.dispatch_failure_count ?? 0,
    cleanups: record.cleanup_count ?? 0,
    ghostCleanups: record.ghost_cleanup_count ?? 0,
    relaunches: record.relaunch_count ?? 0,
    babysitActions: record.babysit_action_count ?? 0,
  });
}

// Re-entrancy guard: a tick is now async and can outlast the interval (slow
// gh/git/castra). Overlapping ticks would double-dispatch, so skip a fire while
// the previous tick is still in flight.
let _ticking = false;

async function safeTick() {
  if (_ticking) return;
  _ticking = true;
  const startedAt = Date.now();
  try {
    await tick();
  } catch (err) {
    logTickError(err);
  } finally {
    _ticking = false;
  }
  lastTickAtMs = Date.now();
  lastTickDurationMs = lastTickAtMs - startedAt;
  try {
    flushHeartbeatMetrics(lastTickDurationMs);
  } catch {
    // Telemetry must never break the loop.
  }
}

/**
 * Start the periodic loop. Mirrors the original .mjs bootstrap: log a startup
 * line, replay recent action events, run an immediate tick, then schedule the
 * interval. Returns a handle to stop the timer for graceful shutdown.
 */
export function startLoopRuntime(): { stop: () => void } {
  appendText(
    meta.processor_log_path,
    `[${now()}] legate-loop starting in terminal-pr-maintenance mode for ${meta.paired_legate}`,
  );
  replayRecentActionEvents();
  void safeTick();
  const timer = setInterval(() => void safeTick(), Math.max(10, intervalSeconds) * 1000);
  return {
    stop: () => clearInterval(timer),
  };
}


