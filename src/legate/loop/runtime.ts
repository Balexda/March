// @ts-nocheck
/**
 * Legate loop runtime — a near-verbatim lift of the former generated
 * `legate-loop.mjs` (the LEGATE_LOOP_MJS template in src/legate/init.ts). It is
 * carried as-is so the container service behaves identically to the script it
 * replaces; `@ts-nocheck` marks this as an intentional mechanical lift whose
 * decomposition + typing is tracked in Balexda/March#144.
 *
 * Changes from the original .mjs (kept minimal and reviewable):
 *   - meta + interval are injected via configureLoopRuntime() instead of being
 *     read relative to import.meta.url (the bundle's url is dist/cli.js).
 *   - the deterministic trace/span ids reuse src/observability/trace-ids.ts.
 *   - per-tick heartbeat metrics (loop-metrics.ts) and per-event structured
 *     logs (logs.ts) are emitted via the OTel SDK; dispatch spans keep the
 *     original raw-OTLP path for now (Balexda/March#145).
 *   - a lastHeartbeat snapshot is exposed for the HTTP /status endpoint.
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  spanIdForDispatch,
  traceIdForDispatch,
} from "../../observability/trace-ids.js";
import {
  recordLoopHeartbeat,
  type LoopMetricsSnapshot,
} from "../../observability/loop-metrics.js";
import { emitLoopLog, type LoopLogSeverity } from "../../observability/logs.js";
import type { LoopMeta } from "./meta.js";

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
export function runTickOnce(): void {
  safeTick();
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
// Each dispatched unit of work is its own trace: trace id = hash(slice id), so
// these loop spans share a trace with the orchestrator's hatchery.spawn /
// spawn.* spans (which use the same deterministic ids). legate.dispatch claims
// the deterministic span id so the orchestrator spans nest beneath it.
// Delegate to the shared deterministic id helpers so the loop, the orchestrator,
// and the in-spawn emitter all derive byte-identical ids (CLAUDE.md contract).
function otelTraceId(key) {
  return traceIdForDispatch(key);
}
function otelSpanId(key) {
  return spanIdForDispatch(key);
}
function emitLoopSpan(opts) {
  try {
    if (!meta.otel || !meta.otel.enabled || !opts.traceKey) return;
    const endNanos = BigInt(Date.now()) * 1000000n;
    const startNanos = opts.startMs ? BigInt(Math.trunc(opts.startMs)) * 1000000n : endNanos;
    // Every loop span carries the deployment profile (set at `march legate
    // init`, also what places agent-deck sessions) so test/integ telemetry can
    // be filtered out of a real deployment's traces.
    const attributes = Object.entries({ "march.profile": meta.profile || "unknown", ...(opts.attributes || {}) }).map(([k, v]) => ({ key: k, value: { stringValue: String(v) } }));
    const span = {
      traceId: otelTraceId(opts.traceKey),
      spanId: opts.spanId || crypto.randomBytes(8).toString("hex"),
      name: opts.name,
      kind: 1,
      startTimeUnixNano: startNanos.toString(),
      endTimeUnixNano: endNanos.toString(),
      attributes,
      status: { code: opts.error ? 2 : 1 },
    };
    if (opts.parentSpanId) span.parentSpanId = opts.parentSpanId;
    const payload = { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "march-legate" } }] }, scopeSpans: [{ scope: { name: "march-legate" }, spans: [span] }] }] };
    let endpoint = meta.otel.endpoint || "http://localhost:4318";
    while (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    fetch(endpoint + "/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).catch(() => {}).finally(() => clearTimeout(timer));
  } catch (err) {}
}
function maybeEmitLoopSpan(event) {
  if (!event || typeof event !== "object") return;
  const sliceId = event.slice_id;
  if (!sliceId) return;
  if (event.kind === "dispatch_action" && event.action === "dispatch") {
    emitLoopSpan({ name: "legate.dispatch", traceKey: sliceId, spanId: otelSpanId(sliceId), attributes: { "march.slice_id": sliceId, "march.action": event.action, "march.dispatch_mode": "spawn" } });
  } else if (event.kind === "recovery_dispatch") {
    // Failed-spawn recovery (added with the upstream recovery/direct-steward
    // machinery). Each recovery codex spawn and each no-spawn direct-steward
    // dispatch is its own dispatched unit of work, so it gets its own trace
    // keyed off its recovery-/direct-suffixed slice id. Like a normal dispatch,
    // it claims the deterministic span id (otelSpanId) so a recovery spawn's
    // hatchery.spawn / spawn.* spans nest beneath this root; direct_dispatch has
    // no spawn but stays uniform so the dispatch still shows up as a trace.
    const mode = event.action === "direct_dispatch" ? "direct_steward" : "recovery";
    emitLoopSpan({ name: "legate.dispatch", traceKey: sliceId, spanId: otelSpanId(sliceId), attributes: { "march.slice_id": sliceId, "march.action": event.action || "", "march.dispatch_mode": mode } });
  } else if (event.kind === "dispatch_failure") {
    // launchHatcheryDispatch threw, so the spawn never ran and the orchestrator
    // never emits hatchery.spawn / the spawn metrics. Record the failed launch
    // as an errored root span so the dispatch still surfaces — as a failed trace.
    emitLoopSpan({ name: "legate.dispatch", traceKey: sliceId, spanId: otelSpanId(sliceId), error: true, attributes: { "march.slice_id": sliceId, "march.action": "dispatch", "march.dispatch_mode": "spawn", "march.error": event.error || "dispatch launch failed" } });
  } else if (event.kind === "babysit_action") {
    emitLoopSpan({ name: "legate.babysit", traceKey: sliceId, parentSpanId: otelSpanId(sliceId), attributes: { "march.slice_id": sliceId, "march.action": event.action || "", "march.pr_number": event.pr_number || "" } });
  } else if (event.kind === "cleanup") {
    emitLoopSpan({ name: "legate.cleanup", traceKey: sliceId, parentSpanId: otelSpanId(sliceId), attributes: { "march.slice_id": sliceId, "march.pr_state": event.pr_state || "" } });
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

function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function execText(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

// In the container the baked `march` on PATH is authoritative; meta.march_cli_path
// is a host path frozen at init that won't resolve in the container
// (Balexda/March#149). Outside the container, keep using the frozen path.
function inContainer() {
  return process.env.MARCH_LEGATE_CONTAINER === "1";
}

function execMarch(args, options = {}) {
  const cliPath = meta.march_cli_path;
  if (!inContainer() && typeof cliPath === "string" && cliPath.length > 0) {
    return execText(process.execPath, [cliPath, ...args], options);
  }
  return execText("march", args, options);
}

function formatCleanupLine(event, prefix = "") {
  return `[${event.ts}] ${prefix}cleaned up ${event.slice_id} PR #${event.pr_number} ${event.pr_state}: removed session ${event.session_id}, pruned worktree`;
}

function formatCleanupFailureLine(event, prefix = "") {
  return `[${event.ts}] ${prefix}cleanup failed ${event.slice_id || "unknown"}${event.pr_state ? " PR " + event.pr_state : ""}: ${event.error}`;
}

function formatBabysitActionLine(event, prefix = "") {
  return `[${event.ts}] ${prefix}babysit ${event.action} ${event.slice_id} PR #${event.pr_number}: ${event.detail}`;
}

function formatProcessorRequestLine(event, prefix = "") {
  return `[${event.ts}] ${prefix}requested legate judgement for ${event.slice_id || "unknown"}${event.pr_number ? " PR #" + event.pr_number : ""}: ${event.reason}`;
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

function agentDeckList() {
  try {
    const out = execFileSync("agent-deck", ["-p", meta.profile, "list", "-json"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : parsed.sessions || [];
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

function sessionGroup(session) {
  return session.group || session.group_path || "";
}

function isWorkerSession(session) {
  const group = sessionGroup(session);
  return group === meta.worker_group || group.startsWith(meta.worker_group + "/");
}

function sessionMatchesSlice(session, slice) {
  const sessionId = String(slice.worker_session_id || "");
  if (!sessionId) return false;
  return session.id === sessionId || session.title === sessionId || session.name === sessionId;
}

function summarizeWorkers(list) {
  if (!Array.isArray(list)) return { error: list.error || "unavailable" };
  const buckets = { waiting: 0, running: 0, idle: 0, error: 0, stopped: 0, other: 0 };
  for (const session of list) {
    if (!isWorkerSession(session)) continue;
    const status = session.status || "other";
    if (Object.prototype.hasOwnProperty.call(buckets, status)) buckets[status] += 1;
    else buckets.other += 1;
  }
  return buckets;
}

function workerBySessionId(list) {
  const out = new Map();
  if (!Array.isArray(list)) return out;
  for (const session of list) {
    if (!isWorkerSession(session)) continue;
    if (session.id) out.set(String(session.id), session);
    if (session.title) out.set(String(session.title), session);
    if (session.name) out.set(String(session.name), session);
  }
  return out;
}

function prNumber(slice) {
  const n = slice?.pr?.number;
  if (typeof n === "number" && Number.isInteger(n) && n > 0) return String(n);
  if (typeof n === "string" && /^[0-9]+$/.test(n)) return n;
  return null;
}

function repoOwner(state) {
  const owner = state?.repo?.owner_with_name;
  if (typeof owner === "string" && owner.length > 0) return owner;
  const repoPath = state?.repo?.path || meta.repo?.path;
  if (typeof repoPath !== "string" || repoPath.length === 0) return null;
  try {
    const out = execText("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
      cwd: repoPath,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function ghPrArgs(slice, state, fields) {
  const number = prNumber(slice);
  if (!number) return { skipped: true, reason: "missing_pr_number" };
  const args = ["pr", "view", number, "--json", fields];
  const owner = repoOwner(state);
  if (typeof owner === "string" && owner.length > 0) {
    args.push("-R", owner);
  }
  const options = {
  };
  const repoPath = state?.repo?.path || meta.repo?.path;
  if (!owner && typeof repoPath === "string" && repoPath.length > 0) {
    options.cwd = repoPath;
  }
  return { args, options, owner, number };
}

function queryPr(slice, state) {
  const request = ghPrArgs(slice, state, "number,url,state");
  if (request.skipped) return request;
  const out = execText("gh", request.args, request.options);
  return JSON.parse(out);
}

function checksSummary(statusCheckRollup) {
  const checks = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  if (checks.length === 0) return "NONE";
  if (checks.some((check) => ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes(check.conclusion))) {
    return "FAIL";
  }
  if (checks.some((check) => ["IN_PROGRESS", "QUEUED", "PENDING"].includes(check.status))) {
    return "PENDING";
  }
  return "PASS";
}

function failedChecks(statusCheckRollup) {
  const checks = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  return checks
    .filter((check) => ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes(check.conclusion))
    .map((check) => ({
      name: check.name || check.context || "unknown",
      url: check.detailsUrl || check.targetUrl || null,
    }));
}

function queryReviewThreads(owner, prNumberValue) {
  if (!owner) return [];
  const [repoOwnerName, repoName] = owner.split("/");
  if (!repoOwnerName || !repoName) return [];
  const out = execText("gh", [
    "api",
    "graphql",
    "-F",
    `owner=${repoOwnerName}`,
    "-F",
    `name=${repoName}`,
    "-F",
    `pr=${prNumberValue}`,
    "-f",
    `query=query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 50) {
            nodes {
              databaseId
              body
              path
              line
              author { login }
              createdAt
            }
          }
        }
      }
    }
  }
}`,
  ]);
  const parsed = JSON.parse(out);
  const nodes = parsed?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
  return nodes
    .filter((thread) => thread && thread.isResolved === false)
    .map((thread) => {
      const comments = Array.isArray(thread.comments?.nodes)
        ? [...thread.comments.nodes].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        : [];
      const first = comments[0] || {};
      const last = comments[comments.length - 1] || first;
      return {
        id: first.databaseId,
        path: first.path,
        line: first.line,
        author: first.author?.login,
        body_preview: String(first.body || "").slice(0, 140),
        last_author: last.author?.login,
        last_comment_at: last.createdAt,
        comment_count: comments.length,
      };
    });
}

function queryPrForBabysit(slice, state) {
  const request = ghPrArgs(
    slice,
    state,
    "number,url,state,mergeable,reviewDecision,statusCheckRollup,headRefName,title,author",
  );
  if (request.skipped) return request;
  const summary = JSON.parse(execText("gh", request.args, request.options));
  const threads = queryReviewThreads(request.owner || repoOwner(state), summary.number);
  const prAuthor = summary.author?.login || "";
  const annotated = threads.map((thread) => ({
    ...thread,
    needs_response: thread.last_author !== prAuthor,
  }));
  return {
    number: summary.number,
    url: summary.url,
    state: summary.state,
    mergeable: summary.mergeable,
    head_branch: summary.headRefName,
    title: summary.title,
    review_decision: summary.reviewDecision,
    checks: checksSummary(summary.statusCheckRollup),
    failed_checks: failedChecks(summary.statusCheckRollup),
    unresolved_threads: annotated,
    thread_count: annotated.length,
    needs_response_count: annotated.filter((thread) => thread.needs_response).length,
  };
}

function removeDispatchMessage(sliceId) {
  const base = meta.legate_conductor_dir;
  if (typeof base !== "string" || base.length === 0) return false;
  const target = path.join(base, `dispatch-msg-${sliceId}.md`);
  try {
    fs.rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

function removeWorkerSession(sessionId) {
  try {
    execFileSync(
      "agent-deck",
      ["-p", meta.profile, "session", "remove", sessionId, "--prune-worktree", "--force"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { removed: true };
  } catch (err) {
    const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join("\n");
    if (/session [^\s]+ not found|no such session|session [^\s]+ does not exist/i.test(output)) {
      return { removed: false, reason: "session_not_found" };
    }
    return { error: output || String(err) };
  }
}

function archiveSlice(state, sliceId, slice, pr, terminalState, ts) {
  const archived = state.archived_slices && typeof state.archived_slices === "object"
    ? state.archived_slices
    : {};
  state.archived_slices = archived;
  const archivedSlice = {
    pr_number: pr.number ?? slice?.pr?.number ?? null,
    pr_url: pr.url ?? slice?.pr?.url ?? null,
    worker_title: slice.worker_title ?? null,
    branch: slice.branch ?? null,
    actual_branch: slice.actual_branch ?? null,
    command: slice.command ?? null,
    arguments: Array.isArray(slice.arguments)
      ? slice.arguments.map((arg) => String(arg))
      : [],
    artifact_path: slice.artifact_path ?? null,
    terminal_state: terminalState,
  };
  if (terminalState === "MERGED") archivedSlice.merged_at = ts;
  if (terminalState === "CLOSED") archivedSlice.closed_at = ts;
  archived[sliceId] = archivedSlice;
  delete state.slices[sliceId];
}

function cleanupTerminalPrs(state, workerList, ts) {
  const cleanups = [];
  const failures = [];
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  if (!state || !Array.isArray(workerList)) return { cleanups, failures };
  const workers = workerList.filter(isWorkerSession);
  let mutated = false;

  for (const [sliceId, slice] of Object.entries(slices)) {
    if (!slice || typeof slice !== "object") continue;
    const sessionId = String(slice.worker_session_id || "");
    if (!sessionId) continue;
    if (!workers.some((session) => sessionMatchesSlice(session, slice))) continue;

    let pr;
    try {
      pr = queryPr(slice, state);
    } catch (err) {
      failures.push({ slice_id: sliceId, session_id: sessionId, error: err?.message || String(err) });
      continue;
    }
    if (pr?.skipped) continue;
    const terminalState = pr?.state;
    if (terminalState !== "MERGED" && terminalState !== "CLOSED") continue;

    removeDispatchMessage(sliceId);
    const removal = removeWorkerSession(sessionId);
    if (removal.error) {
      slice.last_action = ts;
      slice.last_action_note = `cleanup failed: ${removal.error}`;
      mutated = true;
      failures.push({
        slice_id: sliceId,
        session_id: sessionId,
        pr_number: pr.number ?? slice?.pr?.number ?? null,
        pr_state: terminalState,
        error: removal.error,
      });
      continue;
    }

    archiveSlice(state, sliceId, slice, pr, terminalState, ts);
    mutated = true;
    const cleanup = {
      schema_version: 1,
      ts,
      processor: meta.processor_name,
      paired_legate: meta.paired_legate,
      kind: "cleanup",
      slice_id: sliceId,
      session_id: sessionId,
      pr_number: pr.number ?? slice?.pr?.number ?? null,
      pr_url: pr.url ?? slice?.pr?.url ?? null,
      pr_state: terminalState,
      removed: removal.removed,
      reason: removal.reason ?? null,
    };
    cleanups.push(cleanup);
  }

  if (mutated) writeJson(meta.legate_state_path, state);
  return { cleanups, failures };
}

function actionKey(action, pr, extra = "") {
  const head = pr?.head_branch || "";
  return [action, pr?.number || "", pr?.state || "", pr?.mergeable || "", pr?.checks || "", head, extra].join(":");
}

function workerErrorRequestKey(sessionId, slice, recent) {
  const stage = slice.stage || "unknown";
  const pr = prNumber(slice) || "none";
  const outputHash = hashText(recent.output || recent.error || "");
  return `worker-error:${sessionId}:${stage}:${pr}:${outputHash}`;
}

function markSliceAction(slice, action, key, note, ts) {
  slice.last_processor_action = action;
  slice.last_processor_action_key = key;
  slice.last_processor_action_at = ts;
  slice.last_action = ts;
  slice.last_action_note = note;
}

function alreadyDispatched(slice, key) {
  return slice.last_processor_action_key === key;
}

// Stranded-steward watchdog tuning. A healthy steward typically reaches
// "gh pr create" within 2-5 minutes after dispatch — review + verification +
// commit + push + PR all happen in one claude turn. 10 minutes is generous
// enough to avoid false positives on slow verification suites but tight
// enough that the operator isn't waiting hours on a session that gave up
// post-push. After the first nudge, re-nudge every interval until the slice
// either makes it to "pr-open" or the operator manually intervenes — sonnet
// often completes one stage per turn (commit, push, gh pr create), so a
// single nudge typically only advances the workflow one step.
//
// alertEscalateMs sends ONE [PROCESSOR] notification to the legate-agent at
// the 25-min mark so the operator knows the steward is taking unusually
// long; but the watchdog KEEPS nudging — giving up entirely would strand
// the slice (operator can manually escalate further if intervention is
// actually needed).
function strandedStewardConfig() {
  return {
    initialNudgeMs: 10 * 60 * 1000,
    repeatNudgeMs: 5 * 60 * 1000,
    alertEscalateMs: 25 * 60 * 1000,
    message: [
      "[STRANDED-STEWARD-NUDGE] The deterministic loop sees no PR for this slice yet.",
      "Resume the Hatchery manager workflow where you left off:",
      "- If you haven't committed yet: run the verification, commit, push, then open the PR.",
      "- If you've committed but not pushed: 'git push -u origin <branch>'.",
      "- If you've pushed but not opened the PR: 'gh pr create' with title/body derived from",
      "  the artifact path and original request.",
      "",
      "OVERRIDE: If a repo-local pr-creation skill is gating PR creation on finding a",
      "linked GitHub issue, SKIP the issue search. Hatchery dispatches do NOT have a",
      "tracking issue. Compose the PR body without an issue link and run 'gh pr create'",
      "now. Mention 'No tracking issue (Hatchery autonomous dispatch)' in the body if",
      "the skill template requires an explanation.",
      "",
      "End your turn ONLY after one of:",
      "  (a) reporting 'PR: <url>' on the final line, or",
      "  (b) escalating via 'NEED: <summary> -- <next action>'.",
      "If a previous turn ended after 'git push' without 'gh pr create', that's the stranded-",
      "steward bug the loop is nudging you out of. Run 'gh pr create' now.",
    ].join("\n"),
  };
}

// Returns "nudged" if we sent (or re-sent) a nudge this tick, "alert" if
// this is the first tick past the 25-min budget (one-time operator alert),
// or null if neither condition is met (too early, or alert already fired).
// Keeps nudging on every repeat interval regardless of total elapsed time —
// giving up would strand the slice forever, and the operator can intervene
// manually if the alert fires.
function maybeNudgeStrandedSteward(slice, sliceId, sessionId, ts, sendMessage = sendAgentDeckMessage) {
  if (slice.stage !== "implementing") return null;
  if (!sessionId) return null;
  const cfg = strandedStewardConfig();
  const startedAt = Date.parse(slice.implementing_started_at || slice.last_action || "");
  const nowMs = Date.parse(ts);
  if (!Number.isFinite(startedAt) || !Number.isFinite(nowMs)) return null;
  const elapsed = nowMs - startedAt;
  if (elapsed < cfg.initialNudgeMs) return null;
  const nudgedAt = Date.parse(slice.steward_nudge_sent_at || "");
  // First nudge: at initialNudgeMs.
  if (!Number.isFinite(nudgedAt)) {
    try {
      sendMessage(sessionId, cfg.message, false);
    } catch {
      return null;
    }
    slice.steward_nudge_sent_at = ts;
    slice.steward_nudge_count = 1;
    return "nudged";
  }
  // Past the 25-min budget: send ONE operator alert, then keep nudging.
  // The alert is the operator's signal to manually intervene if desired,
  // but the watchdog keeps doing its job either way.
  let alertFired = false;
  if (elapsed >= cfg.alertEscalateMs && !slice.steward_stranded_escalated_at) {
    slice.steward_stranded_escalated_at = ts;
    alertFired = true;
  }
  // Re-nudge: every repeatNudgeMs after the previous nudge. No upper bound.
  if (nowMs - nudgedAt < cfg.repeatNudgeMs) {
    return alertFired ? "alert" : null;
  }
  try {
    sendMessage(sessionId, cfg.message, false);
  } catch {
    return alertFired ? "alert" : null;
  }
  slice.steward_nudge_sent_at = ts;
  slice.steward_nudge_count = (slice.steward_nudge_count || 1) + 1;
  return alertFired ? "alert" : "nudged";
}

// Post-dispatch stuck-worker watchdog tuning. Distinct from the stranded-
// steward watchdog (which fires while a slice is still in "implementing" and
// has no PR yet). This covers the post-PR-creation case where the loop sent
// the worker a /smithy.fix or conflict-resolution prompt and the worker
// session went to waiting/idle without acting — Claude has received the
// message but parked (likely on a permission prompt, a stuck spinner, or a
// "task complete" misjudgement). The loop's existing alreadyDispatched dedup
// keyed off action keys correctly prevents repeat dispatches when nothing
// changed, but it also prevents *waking the worker back up* when the change
// the loop wants is the worker actually doing the work.
function postDispatchNudgeConfig() {
  return {
    // First nudge: at this delay after the original dispatch.
    initialNudgeMs: 5 * 60 * 1000,
    // Subsequent nudges: every interval thereafter.
    repeatNudgeMs: 5 * 60 * 1000,
    // Cumulative nudges per action key before escalating. Three unanswered
    // re-nudges (~15 min total) is strong evidence the worker is genuinely
    // stuck on something the loop can't unblock from outside.
    escalateAfterNudges: 3,
  };
}

// Re-deliver the most recent dispatch message when a worker session has been
// sitting idle/waiting too long after we sent something. Tracks the nudge
// count under `post_dispatch_nudge_for_key` so when the loop sends a fresh
// dispatch (different key — new threads, new state), the counter resets.
// Returns {nudged, escalate, count} for the caller to translate into an
// action event + optional legate-judgement request.
function maybePostDispatchNudge(slice, sessionId, workerStatus, ts, key, buildMessage, sendMessage = sendAgentDeckMessage) {
  if (workerStatus !== "waiting" && workerStatus !== "idle") {
    return { nudged: false, escalate: false, count: 0 };
  }
  if (!sessionId) return { nudged: false, escalate: false, count: 0 };
  const lastDispatchAt = Date.parse(slice.last_processor_action_at || "");
  const nowMs = Date.parse(ts);
  if (!Number.isFinite(lastDispatchAt) || !Number.isFinite(nowMs)) {
    return { nudged: false, escalate: false, count: 0 };
  }
  const cfg = postDispatchNudgeConfig();
  // Reset nudge state if the action key changed — a new dispatch since the
  // last nudge state was written invalidates the prior count.
  if (slice.post_dispatch_nudge_for_key !== key) {
    slice.post_dispatch_nudge_for_key = key;
    slice.post_dispatch_nudge_count = 0;
    slice.post_dispatch_nudge_sent_at = null;
  }
  if (nowMs - lastDispatchAt < cfg.initialNudgeMs) {
    return { nudged: false, escalate: false, count: slice.post_dispatch_nudge_count || 0 };
  }
  const currentCount = slice.post_dispatch_nudge_count || 0;
  if (currentCount >= cfg.escalateAfterNudges) {
    return { nudged: false, escalate: true, count: currentCount };
  }
  const nudgedAt = Date.parse(slice.post_dispatch_nudge_sent_at || "");
  if (Number.isFinite(nudgedAt) && nowMs - nudgedAt < cfg.repeatNudgeMs) {
    return { nudged: false, escalate: false, count: currentCount };
  }
  try {
    sendMessage(sessionId, buildMessage(), false);
  } catch {
    return { nudged: false, escalate: false, count: currentCount };
  }
  slice.post_dispatch_nudge_sent_at = ts;
  slice.post_dispatch_nudge_count = currentCount + 1;
  return { nudged: true, escalate: false, count: currentCount + 1 };
}

function sendAgentDeckMessage(sessionId, message, wait = false) {
  const args = ["-p", meta.profile, "session", "send", sessionId, message, "-q"];
  if (wait) {
    args.push("--wait", "--timeout", "600s");
  } else {
    args.push("--no-wait");
  }
  return execText("agent-deck", args);
}

function truncateText(text, max = 4000) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return value.slice(value.length - max);
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 16);
}

function hasClaudeLoginBlock(output) {
  const text = String(output || "");
  return text.includes("Please run /login") ||
    text.includes("API Error: 401 Invalid authentication credentials");
}

function captureRecentSessionOutput(sessionId) {
  try {
    const output = execText("agent-deck", ["-p", meta.profile, "session", "output", sessionId, "-q"]);
    return { output: truncateText(output.trim()) };
  } catch (err) {
    return { output: "", error: err?.message || String(err) };
  }
}

function loginRequiredDetail({ sliceId, slice, sessionId, recent }) {
  const pr = slice.pr || {};
  return [
    "One or more worker sessions are blocked by Claude Code authentication failure:",
    '"Please run /login · API Error: 401 Invalid authentication credentials"',
    "",
    "Please run /login in the Legate agent session. After login completes, invoke the Legate resume flow so the loop can re-check blocked workers and send resume prompts.",
    "",
    `slice: ${sliceId}`,
    `session: ${sessionId}`,
    `stage: ${slice.stage || "unknown"}`,
    `PR: ${pr.url || (pr.number ? "#" + pr.number : "none")}`,
    "",
    "Recent output:",
    recent.output || (recent.error ? `<unavailable: ${recent.error}>` : "<empty>"),
  ].join("\n");
}

function loginResumeMessage(sliceId, slice) {
  const pr = slice.pr || {};
  return `Claude authentication has been refreshed. Resume your previous task from the current repository state.

Current slice: ${sliceId}
Current stage: ${slice.stage || "unknown"}
PR: ${pr.url || (pr.number ? "#" + pr.number : "none")}

Re-check the PR, CI, review threads, and working tree before taking action. Continue with the last assigned fix/rebase/conflict-resolution task. If the previous instruction is no longer applicable, summarize the current blocker.`;
}

function markLoginBlocked({ sliceId, slice, sessionId, recent, ts, requests }) {
  const outputHash = hashText(recent.output || recent.error || "");
  if (!slice.login_blocked_at) slice.login_blocked_at = ts;
  slice.login_blocked_session_id = sessionId;
  slice.login_blocked_reason = "claude_api_401_login_required";
  slice.login_blocked_output_hash = outputHash;
  slice.last_action = ts;
  slice.last_action_note = "worker blocked on Claude Code login refresh";

  const request = requestLegateJudgement({
    ts,
    slice,
    requestKey: `login-required:${sessionId}:${outputHash}`,
    sliceId,
    sessionId,
    pr: slice.pr || null,
    reason: "claude_api_401_login_required",
    detail: loginRequiredDetail({ sliceId, slice, sessionId, recent }),
  });
  if (request) requests.push(request);
}

function clearLoginBlocked(slice) {
  delete slice.login_blocked_at;
  delete slice.login_blocked_session_id;
  delete slice.login_blocked_reason;
  delete slice.login_blocked_output_hash;
}

function maybeResumeLoginBlocked({ sliceId, slice, sessionId, recent, ts, actions, requests }) {
  if (hasClaudeLoginBlock(recent.output)) return { stillBlocked: true, mutated: false };

  if (recent.error) {
    const request = requestLegateJudgement({
      ts,
      slice,
      requestKey: `login-refresh-unknown:${sessionId}:${hashText(recent.error)}`,
      sliceId,
      sessionId,
      pr: slice.pr || null,
      reason: "could not verify Claude login refresh",
      detail: `Could not read worker output to verify login refresh for ${sliceId}: ${recent.error}`,
    });
    if (request) requests.push(request);
    return { stillBlocked: true, mutated: Boolean(request) };
  }

  const key = [
    "login-resume",
    sessionId,
    slice.stage || "",
    prNumber(slice) || "",
    slice.login_blocked_at || "",
  ].join(":");
  if (alreadyDispatched(slice, key)) return { stillBlocked: false, mutated: false };

  sendAgentDeckMessage(sessionId, loginResumeMessage(sliceId, slice), false);
  clearLoginBlocked(slice);
  markSliceAction(slice, "login-resume", key, "processor sent login-refresh resume prompt", ts);
  actions.push({
    action: "login-resume",
    sliceId,
    sessionId,
    pr: slice.pr || null,
    detail: "sent resume prompt after Claude login refresh",
  });
  return { stillBlocked: false, mutated: true };
}

function workerErrorDetail({ sliceId, slice, worker, sessionId, recent }) {
  const pr = slice.pr || {};
  const lines = [
    "Worker session is in agent-deck error state.",
    "",
    `slice: ${sliceId}`,
    `session: ${sessionId}${worker?.title ? " (" + worker.title + ")" : ""}`,
    `worker_path: ${worker?.path || slice.worktree_path || "unknown"}`,
    `stage: ${slice.stage || "unknown"}`,
    `PR: ${pr.url || (pr.number ? "#" + pr.number : "none")}`,
    `last_action_note: ${slice.last_action_note || "none"}`,
    "",
    "Recent output:",
    recent.output || (recent.error ? `<unavailable: ${recent.error}>` : "<empty>"),
    "",
    "This is not deterministic-safe for the processor. Run legate.error to inspect the worker and choose recovery: resume prompt, direct diagnostic query, restart, login/auth escalation, or operator escalation.",
  ];
  return lines.join("\n");
}

function sendDoorbellToLegate() {
  try {
    execText("agent-deck", [
      "-p",
      meta.profile,
      "session",
      "send",
      `conductor-${meta.paired_legate}`,
      "[PROCESSOR]",
      "--no-wait",
      "-q",
    ]);
    return true;
  } catch {
    return false;
  }
}

function requestLegateJudgement(input) {
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
  const delivered = sendDoorbellToLegate();
  appendText(meta.processor_log_path, `${formatProcessorRequestLine(event)}${delivered ? "" : " (doorbell delivery failed)"}`);
  if (input.slice && input.requestKey) {
    input.slice.last_processor_request_key = input.requestKey;
    input.slice.last_processor_request_at = input.ts;
  }
  return event;
}

function updatePrSnapshot(slice, pr) {
  slice.pr = {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    checks: pr.checks,
    mergeable: pr.mergeable,
  };
  if (pr.head_branch) slice.actual_branch = pr.head_branch;
  slice.thread_count = pr.thread_count;
  slice.needs_response_count = pr.needs_response_count;
  slice.unresolved_threads = pr.unresolved_threads;
}

function threadsNeedingResponse(slice, pr) {
  const openAt = slice.pr_open_at ? Date.parse(slice.pr_open_at) : NaN;
  return (pr.unresolved_threads || []).filter((thread) => {
    if (thread.needs_response) return true;
    if (slice.stage !== "pr-open" && slice.stage) return false;
    if (!Number.isFinite(openAt)) return true;
    const last = Date.parse(thread.last_comment_at || "");
    return Number.isFinite(last) && last > openAt;
  });
}

function failedChecksSummary(pr) {
  const failed = pr.failed_checks || [];
  if (failed.length === 0) return "No failed-check details were available.";
  return failed
    .map((check) => `- ${check.name}${check.url ? ": " + check.url : ""}`)
    .join("\n");
}

function prDiscoverySince(slice) {
  return slice.last_action || slice.created_at || slice.dispatched_at || slice.started_at || "";
}

function reviewThreadsSummary(threads) {
  return threads
    .map((thread) => `- ${thread.path || "unknown path"}${thread.line ? ":" + thread.line : ""} by ${thread.last_author || thread.author || "unknown"}: ${thread.body_preview || ""}`)
    .join("\n");
}

function conflictMessage(slice, pr, state) {
  const defaultBranch = state?.repo?.default_branch || "main";
  const worktree = slice.worktree_path || "<worker worktree>";
  return `/smithy.fix

PR #${pr.number} is blocked from merging: GitHub reports mergeable=CONFLICTING against origin/${defaultBranch}.

Please rebase onto the latest default and resolve the conflicts:

  cd "${worktree}"
  git fetch origin
  git rebase origin/${defaultBranch}

Resolve conflicted files by preserving both the latest default-branch intent and this slice's spec/contracts intent. Then:

  git add <resolved-paths>
  git rebase --continue
  git push --force-with-lease

Reply with the new HEAD sha when the push completes. If the conflict reflects a genuine design disagreement, abort the rebase and summarize the conflicting paths and disagreement.`;
}

function reviewFixMessage(pr, threads) {
  return `/smithy.fix

Unresolved review threads on PR #${pr.number} need a response. Please address them in the same PR branch and push the fix.

Threads:
${reviewThreadsSummary(threads)}`;
}

function addBranchVariants(branches, value) {
  const raw = String(value || "").trim();
  if (!raw) return;
  const normalized = raw.replace(/^refs\/heads\//, "");
  branches.add(normalized);
  if (normalized.startsWith("feature/")) {
    branches.add(normalized.slice("feature/".length));
  } else {
    branches.add(`feature/${normalized}`);
  }
}

function expectedPrBranches(slice) {
  const branches = new Set();
  addBranchVariants(branches, slice.actual_branch);
  addBranchVariants(branches, slice.branch);
  if (slice.worktree_path) {
    try {
      addBranchVariants(branches, execText("git", ["-C", slice.worktree_path, "branch", "--show-current"]));
    } catch {
      // Best-effort guard only; branch fields still protect PR discovery.
    }
  }
  return branches;
}

function prMatchesSliceBranch(slice, pr) {
  const branches = expectedPrBranches(slice);
  if (branches.size === 0) return false;
  return branches.has(String(pr?.head_branch || pr?.headRefName || ""));
}

function discoverPrForSlice(slice, state, sessionId) {
  const repoPath = state?.repo?.path || meta.repo?.path;
  if (!repoPath) return null;
  try {
    const output = execText("agent-deck", ["-p", meta.profile, "session", "output", sessionId, "-q"]);
    const matches = output.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/([0-9]+)/g) || [];
    if (matches.length > 0) {
      const url = matches[matches.length - 1];
      const number = url.split("/").pop();
      const pr = queryPrForBabysit({ pr: { number } }, state);
      return pr?.skipped || !prMatchesSliceBranch(slice, pr) ? null : pr;
    }
  } catch {
    // fall through to branch-based lookup
  }
  try {
    const owner = repoOwner(state);
    const args = ["pr", "list", "--author", "@me", "--state", "open", "--json", "number,url,state,mergeable,headRefName,title,statusCheckRollup,createdAt"];
    if (owner) args.push("-R", owner);
    const options = owner ? {} : { cwd: repoPath };
    const list = JSON.parse(execText("gh", args, options));
    if (!Array.isArray(list) || list.length === 0) return null;
    const since = prDiscoverySince(slice);
    const candidates = since
      ? list.filter((candidate) => String(candidate.createdAt || "") >= since)
      : list;
    const branchMatches = candidates.filter((candidate) => prMatchesSliceBranch(slice, candidate));
    const chosen = branchMatches
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
    if (!chosen) return null;
    return queryPrForBabysit({ pr: { number: chosen.number } }, state);
  } catch {
    return null;
  }
}

function runBabysit(state, workerList, ts) {
  const actions = [];
  const failures = [];
  const requests = [];
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  if (!state || !Array.isArray(workerList)) return { actions, failures, requests, mutated: false };
  const workers = workerBySessionId(workerList);
  let mutated = false;

  for (const [sliceId, slice] of Object.entries(slices)) {
    if (!slice || typeof slice !== "object") continue;
    if (slice.resume_pending === "selected") continue;
    const sessionId = String(slice.worker_session_id || "");
    if (!sessionId) continue;
    const worker = workers.get(sessionId);
    if (!worker) continue;
    const workerStatus = worker.status || "other";

    const recentForLogin = captureRecentSessionOutput(sessionId);
    if (hasClaudeLoginBlock(recentForLogin.output)) {
      markLoginBlocked({
        sliceId,
        slice,
        sessionId,
        recent: recentForLogin,
        ts,
        requests,
      });
      mutated = true;
      continue;
    }

    if (slice.login_blocked_at || slice.login_blocked_session_id || slice.login_blocked_reason) {
      try {
        const resume = maybeResumeLoginBlocked({
          sliceId,
          slice,
          sessionId,
          recent: recentForLogin,
          ts,
          actions,
          requests,
        });
        if (resume.mutated) mutated = true;
        if (resume.stillBlocked) continue;
      } catch (err) {
        const request = requestLegateJudgement({
          ts,
          slice,
          requestKey: `login-resume-send-failed:${sessionId}:${slice.login_blocked_at || ""}`,
          sliceId,
          sessionId,
          pr: slice.pr || null,
          reason: "processor failed to send login-refresh resume prompt",
          detail: err?.message || String(err),
        });
        if (request) {
          requests.push(request);
          mutated = true;
        }
        continue;
      }
    }

    if (workerStatus === "error") {
      const recent = captureRecentSessionOutput(sessionId);
      const key = workerErrorRequestKey(sessionId, slice, recent);
      if (!slice.worker_error_detected_at) slice.worker_error_detected_at = ts;
      slice.worker_error_last_seen_at = ts;
      const request = requestLegateJudgement({
        ts,
        slice,
        requestKey: key,
        sliceId,
        sessionId,
        pr: slice.pr || null,
        reason: "worker_session_error",
        detail: workerErrorDetail({ sliceId, slice, worker, sessionId, recent }),
      });
      if (request) {
        requests.push(request);
      }
      mutated = true;
      continue;
    }

    if (slice.worker_error_last_seen_at) {
      delete slice.worker_error_detected_at;
      delete slice.worker_error_last_seen_at;
      mutated = true;
    }

    if (workerStatus === "running") continue;

    let pr = null;
    if (!slice.pr && slice.stage === "implementing" && (workerStatus === "waiting" || workerStatus === "idle")) {
      pr = discoverPrForSlice(slice, state, sessionId);
      if (pr) {
        updatePrSnapshot(slice, pr);
        slice.stage = "pr-open";
        slice.pr_open_at = ts;
        markSliceAction(slice, "discover-pr", actionKey("discover-pr", pr), "processor discovered PR", ts);
        mutated = true;
        actions.push({ action: "discover-pr", sliceId, sessionId, pr, detail: "discovered worker PR" });
      }
    }

    if (!pr) {
      if (!slice.pr) {
        // Stranded-steward watchdog: a slice that's been "implementing" for
        // longer than the nudge threshold without producing a PR has almost
        // certainly exited mid-workflow (post-commit, post-push, or mid-
        // gh-pr-create). The manager-prompt asks claude to escalate via
        // NEED: rather than stop silently, but legacy stewards and sonnet's
        // "task complete" judgement can still drop the workflow.
        // Send a single explicit nudge to resume; if that doesn't produce a
        // PR by the next watchdog interval, escalate for operator review.
        const nudgeOutcome = maybeNudgeStrandedSteward(slice, sliceId, sessionId, ts);
        if (nudgeOutcome === "nudged" || nudgeOutcome === "alert") {
          mutated = true;
          actions.push({ action: "steward-nudge", sliceId, sessionId, detail: "sent stranded-steward nudge (count " + (slice.steward_nudge_count || 1) + ") — implementing for " + Math.round((Date.parse(ts) - Date.parse(slice.implementing_started_at || ts)) / 60000) + "min with no PR" });
        }
        if (nudgeOutcome === "alert") {
          const request = requestLegateJudgement({
            ts,
            slice,
            requestKey: actionKey("steward-stranded", { number: 0 }, "alert"),
            sliceId,
            sessionId,
            reason: "steward stranded after dispatch (watchdog still nudging)",
            detail: "Slice has been in 'implementing' for >" + strandedStewardConfig().alertEscalateMs / 60000 + "min with no PR. The watchdog is still re-nudging every 5 min; operator can manually inspect the worktree at " + (slice.worktree_path || "(unknown)") + " and run 'gh pr create' if the steward is genuinely stuck.",
          });
          if (request) {
            requests.push(request);
            mutated = true;
          }
        }
        continue;
      }
      try {
        pr = queryPrForBabysit(slice, state);
      } catch (err) {
        const request = requestLegateJudgement({
          ts,
          slice,
          requestKey: actionKey("query-failed", slice.pr || {}, "query"),
          sliceId,
          sessionId,
          prNumber: slice.pr?.number,
          reason: "processor could not query PR state",
          detail: err?.message || String(err),
        });
        if (request) {
          requests.push(request);
          mutated = true;
        }
        continue;
      }
      if (pr?.skipped) continue;
      updatePrSnapshot(slice, pr);
      mutated = true;
    }

    if (pr.state === "MERGED" || pr.state === "CLOSED") continue;
    if (pr.state !== "OPEN") {
      const request = requestLegateJudgement({ ts, slice, requestKey: actionKey("unknown-pr-state", pr), sliceId, sessionId, pr, reason: "unknown PR state", detail: `state=${pr.state}` });
      if (request) {
        requests.push(request);
        mutated = true;
      }
      continue;
    }

    if (pr.mergeable === "CONFLICTING") {
      if (slice.stage === "pr-resolving-conflicts") {
        const request = requestLegateJudgement({
          ts,
          slice,
          requestKey: actionKey("conflict-persisted", pr),
          sliceId,
          sessionId,
          pr,
          reason: "merge conflict persisted after processor prompt",
          detail: `PR #${pr.number} is still CONFLICTING after the processor previously sent a conflict-resolution prompt. Legate judgement is required before repeating recovery.`,
        });
        if (request) {
          requests.push(request);
          mutated = true;
        }
        continue;
      }
      const key = actionKey("conflict-fix", pr);
      if (alreadyDispatched(slice, key)) {
        // Same conflict, conflict prompt already sent. The pr-resolving-
        // conflicts stage check above escalates as soon as conflict
        // *persists* across a tick — but the worker may still be parked
        // (received the prompt, never acted). Nudge before that escalation
        // fires so we give the worker a chance to wake up.
        const result = maybePostDispatchNudge(
          slice, sessionId, workerStatus, ts, key,
          () => conflictMessage(slice, pr, state),
        );
        if (result.nudged) {
          mutated = true;
          actions.push({
            action: "post-dispatch-nudge",
            sliceId, sessionId, pr,
            detail: `re-sent conflict-fix prompt (nudge ${result.count}/${postDispatchNudgeConfig().escalateAfterNudges}) — worker ${workerStatus}`,
          });
        } else if (result.escalate) {
          const request = requestLegateJudgement({
            ts, slice,
            requestKey: actionKey("conflict-nudges-exhausted", pr, key),
            sliceId, sessionId, pr,
            reason: "worker_unresponsive_after_conflict_fix",
            detail: `Sent ${result.count} conflict-fix nudges to PR #${pr.number} worker (session ${sessionId}); still ${workerStatus}. Operator should attach and inspect.`,
          });
          if (request) {
            requests.push(request);
            mutated = true;
          }
        }
        continue;
      }
      try {
        sendAgentDeckMessage(sessionId, conflictMessage(slice, pr, state), false);
      } catch (err) {
        const request = requestLegateJudgement({ ts, slice, requestKey: actionKey("conflict-send-failed", pr), sliceId, sessionId, pr, reason: "processor failed to send conflict-resolution prompt", detail: err?.message || String(err) });
        if (request) {
          requests.push(request);
          mutated = true;
        }
        continue;
      }
      slice.stage = "pr-resolving-conflicts";
      markSliceAction(slice, "conflict-fix", key, "processor sent conflict-resolution fix", ts);
      mutated = true;
      actions.push({ action: "conflict-fix", sliceId, sessionId, pr, detail: "sent conflict-resolution prompt" });
      continue;
    }

    const neededThreads = threadsNeedingResponse(slice, pr);
    if (neededThreads.length > 0) {
      const key = actionKey("review-fix", pr, neededThreads.map((thread) => `${thread.id || ""}@${thread.last_comment_at || ""}`).join(","));
      if (alreadyDispatched(slice, key)) {
        // Same thread set, /smithy.fix already sent. If the worker has been
        // parked in waiting/idle for too long, re-deliver to wake it up.
        // Without this the loop's dedup silently lets a stuck worker rot —
        // the parked Claude session keeps sitting at the prompt and the loop
        // happily reports "already dispatched" on every tick.
        const result = maybePostDispatchNudge(
          slice, sessionId, workerStatus, ts, key,
          () => reviewFixMessage(pr, neededThreads),
        );
        if (result.nudged) {
          mutated = true;
          actions.push({
            action: "post-dispatch-nudge",
            sliceId, sessionId, pr,
            detail: `re-sent /smithy.fix (nudge ${result.count}/${postDispatchNudgeConfig().escalateAfterNudges}) — worker ${workerStatus} ${Math.round((Date.parse(ts) - Date.parse(slice.last_processor_action_at || ts)) / 60000)}min after dispatch`,
          });
        } else if (result.escalate) {
          const request = requestLegateJudgement({
            ts, slice,
            requestKey: actionKey("review-nudges-exhausted", pr, key),
            sliceId, sessionId, pr,
            reason: "worker_unresponsive_after_review_fix",
            detail: `Sent ${result.count} /smithy.fix nudges to PR #${pr.number} worker (session ${sessionId}) and still ${workerStatus} with ${neededThreads.length} thread(s) needing response. Likely parked at a permission prompt or a stuck spinner. Operator should attach and inspect, or close the slice if the worker is unrecoverable.`,
          });
          if (request) {
            requests.push(request);
            mutated = true;
          }
        }
        continue;
      }
      try {
        sendAgentDeckMessage(sessionId, reviewFixMessage(pr, neededThreads), false);
      } catch (err) {
        const request = requestLegateJudgement({ ts, slice, requestKey: actionKey("review-send-failed", pr, key), sliceId, sessionId, pr, reason: "processor failed to send review-thread /smithy.fix", detail: err?.message || String(err) });
        if (request) {
          requests.push(request);
          mutated = true;
        }
        continue;
      }
      slice.stage = "pr-in-fix";
      markSliceAction(slice, "review-fix", key, "processor sent review-thread /smithy.fix", ts);
      mutated = true;
      actions.push({ action: "review-fix", sliceId, sessionId, pr, detail: `sent /smithy.fix for ${neededThreads.length} review thread(s)` });
      continue;
    }

    if (pr.checks === "FAIL") {
      const request = requestLegateJudgement({
        ts,
        slice,
        requestKey: actionKey("ci-failure", pr, (pr.failed_checks || []).map((check) => `${check.name}:${check.url || ""}`).join(",")),
        sliceId,
        sessionId,
        pr,
        reason: "CI failure requires Legate judgement",
        detail: `PR #${pr.number} has failing CI. The deterministic loop cannot distinguish stale-main, transient flake, and real PR-diff failure safely. Failed checks:\n${failedChecksSummary(pr)}`,
      });
      if (request) {
        requests.push(request);
        mutated = true;
      }
      continue;
    }

    if (pr.checks === "PASS" && pr.needs_response_count === 0 && pr.mergeable !== "CONFLICTING") {
      if (["pr-in-fix", "pr-resolving-conflicts", "pr-rebasing", "pr-in-rerun", "implementing"].includes(slice.stage)) {
        slice.stage = "pr-open";
        slice.pr_open_at = ts;
        markSliceAction(slice, "pr-open", actionKey("pr-open", pr), "processor observed PR all clear", ts);
        mutated = true;
        actions.push({ action: "pr-open", sliceId, sessionId, pr, detail: "observed PR all clear" });
      }
      continue;
    }

    if (pr.checks === "PENDING" || pr.mergeable === "UNKNOWN") continue;
  }

  if (mutated) writeJson(meta.legate_state_path, state);
  return { actions, failures, requests, mutated };
}

function slugifyDispatchPart(value, fallback = "item") {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return slug || fallback;
}

function smithyVerb(command) {
  return String(command || "").replace(/^smithy\./, "");
}

function actionArguments(action) {
  return Array.isArray(action?.arguments)
    ? action.arguments.map((arg) => String(arg))
    : [];
}

function actionCommandLine(action) {
  const command = String(action?.command || "");
  const args = actionArguments(action);
  return ["/" + command, ...args].join(" ").trim();
}

function dispatchItemKey(item) {
  const action = item?.next_action || {};
  return JSON.stringify({
    command: action.command || "",
    arguments: actionArguments(action),
    path: item?.path || "",
  });
}

function sliceActionKey(slice) {
  if (!slice || typeof slice !== "object") return "";
  return JSON.stringify({
    command: slice.command || "",
    arguments: Array.isArray(slice.arguments)
      ? slice.arguments.map((arg) => String(arg))
      : [],
    path: slice.artifact_path || "",
  });
}

// Strip a known artifact suffix from a basename so the leftover is a short,
// readable spec / RFC / features-file slug. Returns null if the suffix isn't
// recognized so we can fall back to the hash-based name rather than misderive.
function dispatchArtifactSlug(filename) {
  if (typeof filename !== "string" || filename.length === 0) return null;
  const base = filename.split("/").pop() || "";
  const m = base.match(/^(.+?)\.(?:spec|rfc|features|tasks)\.md$/);
  return m ? m[1] : null;
}

// Derive a structured identity (spec/RFC slug + US/M row + slice/feature/
// milestone index) for a smithy status record. Produces a short, semantic
// stem that mirrors how operators already hand-name slices ("us6-s1",
// "spawn-dispatch-us7"). Returns the legacy hash-based stem only when the
// record lacks the structure to derive a meaningful name — in that case
// behavior is identical to the pre-refactor scheme.
//
// Branch / slice ID collisions are intentional under this scheme: the same
// spec + US + slice yields the same name on every dispatch, so a collision
// means "this is a re-attempt of the same logical work", which is exactly
// what the loop's branch-collision recovery wants to surface (vs. an opaque
// hash that hides whether the collision is meaningful).
function dispatchIdentity(item) {
  const action = item?.next_action || {};
  const verb = smithyVerb(action.command);
  const args = actionArguments(action);
  const parentSlug = dispatchArtifactSlug(item?.parent_path);
  const row = String(item?.parent_row_id || "").trim().toLowerCase();
  const numericTail = (s) => String(s || "").replace(/[^0-9]/g, "");
  let stem = null;
  if (verb === "forge" && parentSlug && row) {
    const slice = numericTail(args[1]);
    stem = parentSlug + "-" + row + (slice ? "-s" + slice : "");
  } else if (verb === "cut" && parentSlug && row) {
    const slice = numericTail(args[1]);
    stem = parentSlug + "-" + row + (slice ? "-s" + slice : "");
  } else if (verb === "mark" && parentSlug && row) {
    const feature = numericTail(args[1]);
    stem = parentSlug + "-" + row + (feature ? "-f" + feature : "");
  } else if (verb === "render") {
    const rfcSlug = dispatchArtifactSlug(args[0]) || parentSlug;
    const milestone = numericTail(args[1]);
    if (rfcSlug && milestone) stem = rfcSlug + "-m" + milestone;
  }
  if (stem) {
    return { stem: slugifyDispatchPart(stem, "smithy"), verb, hash: null, semantic: true };
  }
  // Fallback: original hash-based scheme. Keeps dispatch working for records
  // without parent_path / parent_row_id structure. Order is preserved
  // exactly so existing state.json / archive entries keyed by the legacy
  // ID continue to match: dispatchSliceId is "<stem>-<verb>-<hash>",
  // dispatchBranch is "smithy/<verb>/<stem>-<hash>".
  const basis = [item?.path || item?.title || "smithy", ...args].join(" ");
  const truncStem = slugifyDispatchPart(basis, "smithy").slice(0, 44);
  const hash = hashText(dispatchItemKey(item)).slice(0, 8);
  return { stem: truncStem, verb, hash, semantic: false };
}

function dispatchSliceId(item) {
  const { stem, verb, hash, semantic } = dispatchIdentity(item);
  const verbSlug = slugifyDispatchPart(verb, "step");
  return semantic ? stem + "-" + verbSlug : stem + "-" + verbSlug + "-" + hash;
}

function dispatchTitle(item) {
  const action = item?.next_action || {};
  const verb = smithyVerb(action.command);
  const title = item?.title || item?.path || actionArguments(action).join(" ");
  return verb + ": " + String(title || "smithy work").slice(0, 80);
}

function dispatchBranch(item) {
  const { stem, verb, hash, semantic } = dispatchIdentity(item);
  const verbSlug = slugifyDispatchPart(verb, "step");
  return semantic
    ? "smithy/" + verbSlug + "/" + stem
    : "smithy/" + verbSlug + "/" + stem + "-" + hash;
}

function isTerminalSlice(slice) {
  if (!slice || typeof slice !== "object") return true;
  if (slice.stage === "merged" || slice.stage === "escalated") return true;
  if (slice.pr?.state === "MERGED" || slice.pr?.state === "CLOSED") return true;
  return false;
}

// Dedup helper for new-dispatch suppression. Stricter than isTerminalSlice:
// only a successfully merged slice means the artifact is "done" and a fresh
// dispatch is safe. Escalated / closed-unmerged slices are still load-bearing
// — they represent unresolved blockers that an operator must clear, and the
// loop must not silently re-queue the same artifact behind their back.
function sliceReleasesArtifact(slice) {
  if (!slice || typeof slice !== "object") return false;
  if (slice.stage === "merged") return true;
  if (slice.pr?.state === "MERGED") return true;
  return false;
}

function archivedSlices(state) {
  return state?.archived_slices && typeof state.archived_slices === "object"
    ? state.archived_slices
    : {};
}

// A stub archive entry has no command, no args, and no branch — usually a
// leftover from an older state-schema migration. dispatchSliceId is
// deterministic from the item path, so a stub's persisted key collides
// with the SID of any freshly-computed ready item on the same path, even
// when no real work was ever recorded for it. Treat stubs as "no info"
// and fall back to the stronger action_key / branch matchers so we don't
// silently block fresh dispatches behind ghost archives.
function isStubArchivedSlice(slice) {
  if (!slice || typeof slice !== "object") return true;
  const hasCommand = typeof slice.command === "string" && slice.command.length > 0;
  const hasBranch = (typeof slice.branch === "string" && slice.branch.length > 0)
    || (typeof slice.actual_branch === "string" && slice.actual_branch.length > 0);
  return !hasCommand && !hasBranch;
}

function alreadyArchivedSlice(state, item, sliceId) {
  const archived = archivedSlices(state);
  if (Object.prototype.hasOwnProperty.call(archived, sliceId) && !isStubArchivedSlice(archived[sliceId])) return true;
  const key = dispatchItemKey(item);
  const branch = dispatchBranch(item);
  for (const slice of Object.values(archived)) {
    if (!slice || typeof slice !== "object") continue;
    if (sliceActionKey(slice) === key) return true;
    if (slice.branch && slice.branch === branch) return true;
    if (slice.actual_branch && slice.actual_branch === branch) return true;
  }
  return false;
}

function alreadyHasInFlightSlice(state, item, sliceId) {
  if (alreadyArchivedSlice(state, item, sliceId)) return true;
  return inFlightSliceMatches(state, item, sliceId);
}

// Live-only portion of the dedup check. Carved out so the recovery-dispatch
// path can distinguish "blocked because a recovery is already in flight"
// from "blocked because the prior MERGED archive collides" — the former is
// correct dedup, the latter is the exact case we want to recover from.
function inFlightSliceMatches(state, item, sliceId) {
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const key = dispatchItemKey(item);
  const branch = dispatchBranch(item);
  for (const [existingId, slice] of Object.entries(slices)) {
    if (existingId === sliceId) return true;
    if (!slice || typeof slice !== "object") continue;
    if (sliceReleasesArtifact(slice)) continue;
    // Recovery slice for the same item — its original_slice_id matches
    // the to-be-dispatched sliceId. Without this, every tick would mint
    // a new recovery-N attempt for the same in-flight original.
    if (slice.original_slice_id === sliceId) return true;
    if (sliceActionKey(slice) === key) return true;
    if (slice.branch && slice.branch === branch) return true;
  }
  return false;
}

// Returns the matching archived slice ONLY if it terminated in MERGED.
// Callers use this to detect the partial-merge dedup wedge: smithy says
// "still ready", the slice id collides with a prior MERGED archive, the
// loop should fire a recovery dispatch rather than silently filtering.
// Escalated / closed-unmerged archives intentionally fall through (return
// null) so they keep blocking re-dispatch — those represent unresolved
// operator decisions and recovery is not the right tool.
function blockingMergedArchive(state, item, sliceId) {
  const archived = archivedSlices(state);
  const key = dispatchItemKey(item);
  const branch = dispatchBranch(item);
  const isMerged = (a) => {
    if (!a || typeof a !== "object") return false;
    if (a.terminal_state === "MERGED") return true;
    if (a.stage === "merged") return true;
    if (a.pr && a.pr.state === "MERGED") return true;
    return false;
  };
  const direct = archived[sliceId];
  if (direct && !isStubArchivedSlice(direct) && isMerged(direct)) return direct;
  for (const slice of Object.values(archived)) {
    if (!slice || typeof slice !== "object") continue;
    if (!isMerged(slice)) continue;
    if (sliceActionKey(slice) === key) return slice;
    if (slice.branch && slice.branch === branch) return slice;
    if (slice.actual_branch && slice.actual_branch === branch) return slice;
  }
  return null;
}

// Cap on codex-spawn recovery dispatches per original slice before the loop
// stops fighting the spawn path. Two attempts is enough to distinguish a
// fluky worker (first attempt missed the checkbox) from a systemic codex
// problem (truncated patches, the prompt not taking). After this we fall
// back to a direct, no-spawn steward dispatch (see handleRecoveryDispatch) —
// the old mini-legate style of handing the /smithy.<verb> command straight
// to a Claude steward that does the whole job itself.
const MAX_RECOVERY_ATTEMPTS = 2;

function graphNodes(status) {
  return status?.graph?.nodes && typeof status.graph.nodes === "object"
    ? status.graph.nodes
    : {};
}

function graphNode(status, nodeId) {
  const nodes = graphNodes(status);
  return nodeId ? nodes[nodeId] || null : null;
}

function forgeRowId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return /^[a-zA-Z]/.test(raw) ? raw : "S" + raw;
}

function forgeNodeId(item) {
  const args = actionArguments(item?.next_action || {});
  const tasksPath = args[0] || item?.path || "";
  const rowId = forgeRowId(args[1]);
  if (!tasksPath || !rowId) return null;
  return tasksPath + "#" + rowId;
}

function recordRowForForgeItem(status, item) {
  const args = actionArguments(item?.next_action || {});
  const tasksPath = args[0] || item?.path || "";
  const rowId = forgeRowId(args[1]);
  if (!tasksPath || !rowId) return null;
  const records = Array.isArray(status?.records) ? status.records : [];
  const record = records.find((candidate) => candidate?.path === tasksPath);
  const rows = Array.isArray(record?.dependency_order?.rows)
    ? record.dependency_order.rows
    : [];
  return rows.find((row) => String(row?.id || "") === rowId) || null;
}

function dependencyIds(status, item) {
  const nodeId = forgeNodeId(item);
  const node = graphNode(status, nodeId);
  const row = node?.row || recordRowForForgeItem(status, item) || {};
  const raw = Array.isArray(row?.depends_on) ? row.depends_on : [];
  const recordPath = String(node?.record_path || actionArguments(item?.next_action || {})[0] || item?.path || "");
  return raw
    .map((dep) => String(dep || "").trim())
    .filter(Boolean)
    .map((dep) => dep.includes("#") ? dep : recordPath + "#" + dep);
}

function dependencyMerged(state, depId) {
  const archived = state?.archived_slices && typeof state.archived_slices === "object"
    ? state.archived_slices
    : {};
  const live = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const archivedSlice = archived[depId] || archived[slugifyDispatchPart(depId)];
  if (archivedSlice && typeof archivedSlice === "object") {
    if (archivedSlice.terminal_state === "MERGED" || archivedSlice.merged_at) return true;
  }
  const liveSlice = live[depId] || live[slugifyDispatchPart(depId)];
  if (liveSlice && typeof liveSlice === "object") {
    if (liveSlice.stage === "merged" || liveSlice.pr?.state === "MERGED") return true;
  }
  return false;
}

function itemFromGraphNode(status, node) {
  const recordPath = String(node?.record_path || "");
  const row = node?.row && typeof node.row === "object" ? node.row : {};
  const rowId = String(row.id || "").trim();
  const rowNumber = rowId.replace(/^[a-zA-Z]+/, "") || rowId;
  // Look up the matching smithy status record so parent_path / parent_row_id
  // are populated. Without these, dispatchSliceId(depItem) falls into the
  // hash-based fallback and produces an ID that cannot match the semantic
  // ID used when that dep was actually dispatched — leaving merged-archived
  // deps invisible to dependencySatisfied.
  const records = Array.isArray(status?.records) ? status.records : [];
  const record = records.find((candidate) => candidate?.path === recordPath) || {};
  return {
    path: recordPath,
    title: row.title || recordPath,
    parent_path: record.parent_path || null,
    parent_row_id: record.parent_row_id || null,
    next_action: {
      command: "smithy.forge",
      arguments: [recordPath, rowNumber],
    },
  };
}

function dependencySatisfied(state, status, depId) {
  const node = graphNode(status, depId);
  const nodeStatus = String(node?.status || "").toLowerCase();
  if (nodeStatus === "done") return true;
  const depItem = node ? itemFromGraphNode(status, node) : null;
  const candidates = [
    depId,
    depItem ? dispatchSliceId(depItem) : null,
    slugifyDispatchPart(depId),
  ].filter(Boolean);
  return candidates.some((candidate) => dependencyMerged(state, candidate));
}

function dependenciesClear(state, status, item) {
  return dependencyIds(status, item).every((depId) => dependencySatisfied(state, status, depId));
}

function dispatchPriority(item) {
  const command = String(item?.next_action?.command || "");
  if (command === "smithy.cut") return 0;
  if (command === "smithy.forge") return 1;
  if (command === "smithy.render") return 2;
  if (command === "smithy.mark") return 3;
  return 9;
}

function readyLayerNodeIds(status) {
  const layers = Array.isArray(status?.graph?.layers) ? status.graph.layers : [];
  const layer = layers.find((candidate) => Number(candidate?.layer) === 0);
  const ids = Array.isArray(layer?.node_ids) ? layer.node_ids : [];
  return new Set(ids.map((id) => String(id)));
}

function recordGraphNodeId(record) {
  if (!record || typeof record !== "object") return null;
  if (record.parent_path && record.parent_row_id) {
    return String(record.parent_path) + "#" + String(record.parent_row_id);
  }
  const action = record.next_action || {};
  if (String(action.command || "") === "smithy.render") {
    const args = actionArguments(action);
    const milestone = args[1] ? "M" + String(args[1]).replace(/^[a-zA-Z]+/, "") : "";
    return milestone ? String(args[0] || record.path || "") + "#" + milestone : null;
  }
  return record.path ? String(record.path) : null;
}

function readySmithyItems(status) {
  const records = Array.isArray(status?.records) ? status.records : [];
  const readyNodes = readyLayerNodeIds(status);
  return records
    .filter((record) => record?.next_action && !record.virtual)
    .filter((record) => ["smithy.render", "smithy.mark", "smithy.cut", "smithy.forge"].includes(String(record.next_action.command || "")))
    .filter((record) => readyNodes.size === 0 || readyNodes.has(recordGraphNodeId(record)))
    .map((record, index) => ({ ...record, __index: index }))
    .sort((a, b) => dispatchPriority(a) - dispatchPriority(b) || a.__index - b.__index);
}

function readSmithyStatus(repoPath) {
  // --pending = shorthand for --status in-progress,not-started. Filters out
  // all done records up-front (smithy ships a much smaller, dispatch-shaped
  // payload — the prior full output had hundreds of done entries the loop
  // had to wade through). Layer 0 of the returned graph still means "ready
  // to dispatch right now" — a node's dependencies have either landed (and
  // were filtered out by --pending) or never existed.
  const out = execText("smithy", ["status", "--format", "json", "--pending"], { cwd: repoPath });
  return JSON.parse(out);
}

function syncDefaultBranch(state) {
  const repoPath = state?.repo?.path || meta.repo?.path;
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new Error("repo path is missing");
  }
  let defaultBranch = state?.repo?.default_branch;
  if (!defaultBranch) {
    try {
      defaultBranch = execText("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repoPath })
        .trim()
        .replace(/^origin\//, "");
    } catch {
      defaultBranch = execText("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], { cwd: repoPath }).trim();
    }
  }
  if (!defaultBranch) throw new Error("could not determine default branch");
  execText("git", ["fetch", "origin", defaultBranch], { cwd: repoPath });
  execText("git", ["switch", defaultBranch], { cwd: repoPath });
  execText("git", ["pull", "--ff-only", "origin", defaultBranch], { cwd: repoPath });
  if (state.repo && !state.repo.default_branch) state.repo.default_branch = defaultBranch;
  return {
    default_branch: defaultBranch,
    synced: true,
    head: execText("git", ["rev-parse", "HEAD"], { cwd: repoPath }).trim(),
  };
}

function buildSmithySpawnPrompt(item) {
  const commandLine = actionCommandLine(item.next_action);
  return [
    "Complete this Smithy workflow step and produce a git patch.",
    "",
    "Smithy command:",
    commandLine,
    "",
    "Artifact:",
    item.path || item.title || "(unknown)",
    "",
    "Rules:",
    "- Implement only this one Smithy step.",
    "- Do not chain into the next Smithy step.",
    "- Make the smallest coherent patch needed for this step.",
    "- Every acceptance criterion the step lists must be satisfied by the patch.",
    "  Do not produce a partial patch and rely on a follow-up — the deterministic",
    "  loop dedups future dispatches off the merged slice id and a partial merge",
    "  is silently abandoned.",
    "- Flip the matching tasks.md row(s) from `[ ]` to `[x]` in the same patch.",
    "  The check-state is the loop's only durable signal that this slice is done.",
    "- Leave PR creation to the Hatchery manager session.",
  ].join("\n");
}

// Recovery-dispatch prompt: a layer-0 ready item collided with a prior
// MERGED archive entry. The prior PR shipped a partial slice that left the
// matching tasks.md row `[ ]`, so the loop's dedup silently filtered the
// item until this path was added. Frame the work as cleanup: either finish
// the remaining acceptance criteria or open a checkbox-only fix PR.
function buildSmithyRecoverySpawnPrompt(item, mergedArchive, attempt) {
  const commandLine = actionCommandLine(item.next_action);
  const priorPr = mergedArchive?.pr || {};
  const priorPrLine = priorPr.number
    ? "Prior merged PR: #" + priorPr.number + (priorPr.url ? " (" + priorPr.url + ")" : "")
    : "Prior merged slice: " + (mergedArchive?.branch || mergedArchive?.actual_branch || "(branch unknown)");
  return [
    "RECOVERY DISPATCH (attempt " + attempt + "). The slice listed below was",
    "previously merged via the prior PR — but the merge was partial: smithy",
    "still reports the tasks.md row as ready, which means at least one",
    "checkbox is still `[ ]` and/or an acceptance criterion is unmet.",
    "",
    priorPrLine,
    "",
    "Smithy command:",
    commandLine,
    "",
    "Artifact:",
    item.path || item.title || "(unknown)",
    "",
    "Rules:",
    "- Read the artifact and the prior merged diff (`gh pr view <num> --json files`",
    "  if you have the number). Identify what shipped vs. what is still missing.",
    "- If acceptance criteria are unmet: implement them now. Smallest coherent patch.",
    "- If the work is actually done and only the checkbox was missed: open a",
    "  checkbox-only cleanup PR that flips the row from `[ ]` to `[x]`.",
    "- Either way, the patch MUST flip the matching tasks.md row(s).",
    "- Do not re-implement work the prior PR already shipped — don't churn.",
    "- Leave PR creation to the Hatchery manager session.",
  ].join("\n");
}

function hatcheryResultPath(sliceId) {
  return path.join(meta.legate_conductor_dir || here, "hatchery-result-" + sliceId + ".json");
}

function hatcheryLogPath(sliceId) {
  return path.join(meta.legate_conductor_dir || here, "hatchery-result-" + sliceId + ".log");
}

function hatcheryRequestPath(sliceId) {
  return path.join(meta.legate_conductor_dir || here, "hatchery-request-" + sliceId + ".json");
}

function hatcheryRunnerCode() {
  // Wrapped in try/catch so any runner-side crash (bad request file, missing
  // command, spawnSync throw, fs error) still produces a result file. Without
  // this, a crashed runner leaves the slice stuck in hatchery-pending forever
  // because completePendingHatcheryDispatches only acts when the result file
  // appears.
  //
  // Escape carefully: this code lives inside a TEMPLATE LITERAL that becomes
  // the deployed legate-loop.mjs. Anywhere we need a backslash-n in the
  // runner SOURCE we're handing to `node -e`, we must write four
  // backslashes here: template eval collapses \\n -> \n, then the
  // deployed .mjs evaluates \n -> \n (2 chars) inside the array element,
  // which finally evaluates to a real \n inside the runner's "..." string
  // literal. Using only two backslashes used to insert a real newline mid
  // string literal, producing a SyntaxError that silently killed every
  // hatchery spawn.
  // resultPath and logPath come in as their own argv entries (argv[2], argv[3])
  // so the crash guard has somewhere to write even when the request file
  // itself fails to read or parse. If we relied on request.resultPath
  // alone, a malformed/truncated request would leave request = null and
  // the catch block would have no path to fall back to, stranding the slice
  // in hatchery-pending until the 15-min stale timeout fires.
  return [
    'const { spawnSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const requestPath = process.argv[1];',
    'const resultPath = process.argv[2];',
    'const logPath = process.argv[3];',
    'let request = null;',
    'try {',
    '  request = JSON.parse(fs.readFileSync(requestPath, "utf-8"));',
    // request.otelEnv is present only when the deployment has telemetry on
    // (meta.otel.enabled at init). It carries MARCH_OTEL=1 + endpoint down to
    // the "march hatchery spawn" orchestrator so it emits spawn metrics/spans —
    // the loop is launched by agent-deck as a bare node with no MARCH_OTEL in
    // its env, so without this the orchestrator (which reads process.env) would
    // emit nothing. Omitted when off, so the spawn argv/env is unchanged.
    // (No backticks in this comment: it lives inside the LEGATE_LOOP_MJS literal.)
    '  const spawnOpts = { cwd: request.cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] };',
    '  if (request.otelEnv) spawnOpts.env = Object.assign({}, process.env, request.otelEnv);',
    '  const result = spawnSync(request.command, request.args, spawnOpts);',
    '  if (result.stderr) { try { fs.appendFileSync(logPath, result.stderr); } catch {} }',
    '  if (result.status === 0) {',
    '    fs.writeFileSync(resultPath, result.stdout || "", "utf-8");',
    '  } else {',
    '    fs.writeFileSync(resultPath, JSON.stringify({ error: result.stderr || result.error?.message || "hatchery spawn failed", exitCode: result.status ?? null }) + "\\n", "utf-8");',
    '  }',
    '} catch (err) {',
    '  const message = (err && err.stack) ? err.stack : String(err);',
    '  try {',
    '    if (resultPath) {',
    '      fs.writeFileSync(resultPath, JSON.stringify({ error: "hatchery runner crashed: " + message, exitCode: null }) + "\\n", "utf-8");',
    '    }',
    '    if (logPath) { fs.appendFileSync(logPath, "runner crash: " + message + "\\n"); }',
    '  } catch {}',
    '  process.exit(1);',
    '}',
  ].join("\n");
}

function marchCommandAndArgs(args) {
  const cliPath = meta.march_cli_path;
  if (!inContainer() && typeof cliPath === "string" && cliPath.length > 0) {
    return { command: process.execPath, args: [cliPath, ...args] };
  }
  return { command: "march", args };
}

function launchHatcheryDispatch(item, resultPath, logPath, opts) {
  const repoPath = meta.repo?.path;
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new Error("repo path is missing");
  }
  const dispatchIdent = dispatchIdentity(item);
  const branch = opts?.branchOverride || dispatchBranch(item);
  const title = opts?.titleOverride || dispatchTitle(item);
  const prompt = opts?.promptOverride || buildSmithySpawnPrompt(item);
  const requestSliceId = opts?.requestSliceIdOverride || dispatchSliceId(item);
  const args = [
    "hatchery",
    "spawn",
    "--backend",
    "codex",
    "--agent-deck-profile",
    meta.profile,
    "--manager-group",
    meta.worker_group,
    "--name",
    title,
    "--branch",
    branch,
    "--profile",
    meta.profile,
    "--task-type",
    dispatchIdent.verb,
    "--task-name",
    dispatchIdent.stem,
    "--slice-id",
    requestSliceId,
    "--prompt",
    prompt,
    "--json",
  ];
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, "", "utf-8");
  const requestPath = hatcheryRequestPath(requestSliceId);
  const resolved = marchCommandAndArgs(args);
  const requestBody = {
    command: resolved.command,
    args: resolved.args,
    cwd: repoPath,
    resultPath,
    logPath,
  };
  // Propagate the deployment's frozen telemetry config to the spawn orchestrator
  // so it emits even though the loop runs without MARCH_OTEL in its ambient env.
  if (meta.otel && meta.otel.enabled) {
    requestBody.otelEnv = {
      MARCH_OTEL: "1",
      MARCH_OTEL_ENDPOINT: meta.otel.endpoint || "http://localhost:4318",
    };
  }
  fs.writeFileSync(requestPath, JSON.stringify(requestBody) + "\n", "utf-8");
  const child = spawn(process.execPath, ["-e", hatcheryRunnerCode(), requestPath, resultPath, logPath], {
    cwd: repoPath,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  return { pid: child.pid || null, requestPath };
}

// Initial message handed to a direct-steward dispatch (no-spawn fallback).
// The steward runs the /smithy.<verb> command itself and carries it all the
// way to an open PR — the pre-Hatchery mini-legate flow. `mergedArchive` is
// present when this is the fallback after recovery spawns failed; null on a
// first-class direct dispatch.
function buildDirectStewardMessage(item, mergedArchive) {
  const commandLine = actionCommandLine(item.next_action);
  const priorPr = mergedArchive?.pr || {};
  const priorLine = priorPr.number
    ? "A prior PR (#" + priorPr.number + ") merged for this artifact but left it incomplete — smithy still reports it as pending."
    : "";
  return [
    "[DIRECT DISPATCH — no spawn] The Hatchery codex spawn path failed",
    "repeatedly for this slice, so the loop is handing you the Smithy command",
    "directly. Implement it yourself, end-to-end — do not wait for a patch.",
    priorLine,
    "",
    "Run this Smithy command and carry it through to an open PR:",
    commandLine,
    "",
    "Artifact: " + (item.path || item.title || "(unknown)"),
    "",
    "Requirements:",
    "- Satisfy every acceptance criterion the step lists.",
    "- Flip the matching tasks.md row(s) from `[ ]` to `[x]` in the same change.",
    "- Commit, push, and open the PR yourself (`gh pr create`).",
    "- Report the PR URL on the final line as `PR: <url>`.",
    "- If genuinely blocked, escalate via `NEED: <summary> — <next action>`",
    "  instead of ending your turn silently.",
  ].filter((line) => line !== "").join("\n");
}

// Direct-steward dispatch: the no-spawn fallback. Launches a plain Claude
// steward on a fresh worktree+branch and hands it the /smithy.<verb> command
// as the initial message. Reliable but slower/less parallel than codex spawn.
// Returns {launched, sliceId, sessionId, error}. Mutates state.slices on
// success so babysit/cleanup track the steward like any other.
function launchDirectStewardDispatch(state, ts, item, sliceId, mergedArchive) {
  const repoPath = state?.repo?.path || meta.repo?.path;
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    return { launched: false, error: "repo path is missing" };
  }
  const bareBranch = dispatchBranch(item) + "-direct";
  const featureBranch = "feature/" + bareBranch;
  const directSliceId = sliceId + "-direct";
  const title = "direct: " + dispatchTitle(item);
  const message = buildDirectStewardMessage(item, mergedArchive);

  let beforeIds;
  try {
    const beforeList = agentDeckList();
    beforeIds = new Set(Array.isArray(beforeList) ? beforeList.map((s) => s.id) : []);
  } catch {
    beforeIds = new Set();
  }
  const launchArgs = [
    "-p", meta.profile,
    "launch",
    repoPath,
    "-t", title,
    "-c", "claude",
    "-g", meta.worker_group,
    "--worktree", bareBranch,
    "-b",
    "--title-lock",
    "--model", "opus",
    "--extra-arg", "--permission-mode",
    "--extra-arg", "auto",
    "-message", message,
    "-q",
  ];
  try {
    execFileSync("agent-deck", launchArgs, {
      encoding: "utf-8",
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    return { launched: false, sliceId: directSliceId, error: "agent-deck launch failed: " + (err?.message || String(err)).slice(0, 200) };
  }
  let newSessionId = null;
  try {
    const afterList = agentDeckList();
    if (Array.isArray(afterList)) {
      for (const s of afterList) {
        if (!isWorkerSession(s)) continue;
        if (beforeIds.has(s.id)) continue;
        newSessionId = s.id;
        break;
      }
    }
  } catch {}
  if (!newSessionId) {
    return { launched: false, sliceId: directSliceId, error: "agent-deck launch returned no identifiable new session" };
  }
  try {
    execFileSync("agent-deck", ["-p", meta.profile, "session", "set", newSessionId, "auto-mode", "true"], {
      encoding: "utf-8",
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    // Best-effort; the --permission-mode auto extra-arg already covers it.
  }
  const action = item.next_action || {};
  const worktreesParent = path.join(path.dirname(repoPath), "WorkTrees", path.basename(repoPath));
  state.slices[directSliceId] = {
    kind: "smithy",
    worker_session_id: newSessionId,
    worker_title: title,
    branch: bareBranch,
    actual_branch: featureBranch,
    worktree_path: path.join(worktreesParent, "feature-" + bareBranch.replace(/\//g, "-")),
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

// Pull the branch name out of a hatchery spawn error. Git emits at least
// two forms for the same underlying condition:
//   "branch 'feature/...' already exists"            (git branch -b on an existing branch)
//   "fatal: a branch named 'feature/...' already exists"  (git checkout -b / worktree add -b)
// Returns null when the error isn't a branch collision so callers fall
// through to the normal escalation path.
function parseBranchCollisionError(text) {
  const s = String(text || "");
  const named = s.match(/branch named '([^']+)' already exists/);
  if (named) return named[1];
  const direct = s.match(/branch '([^']+)' already exists/);
  return direct ? direct[1] : null;
}

// Inspect a local branch enough to classify a collision: where its HEAD
// sits, whether the work already landed on the default branch, and what
// PRs exist for it. All read-only — caller decides whether to act.
function inspectCollidedBranch(repoPath, defaultBranch, branchName) {
  let head = null;
  try {
    head = execText("git", ["rev-parse", branchName], { cwd: repoPath }).trim();
  } catch {
    // branch doesn't exist locally anymore — nothing to recover.
    return null;
  }
  let isAncestor = false;
  if (defaultBranch) {
    try {
      execText("git", ["merge-base", "--is-ancestor", branchName, defaultBranch], { cwd: repoPath });
      isAncestor = true;
    } catch {
      isAncestor = false;
    }
  }
  let prs = [];
  let prsKnown = true;
  try {
    const out = execText("gh", ["pr", "list", "--head", branchName, "--state", "all", "--json", "number,state"], { cwd: repoPath });
    prs = JSON.parse(out);
    if (!Array.isArray(prs)) prs = [];
  } catch {
    // gh failures (auth, network) mean we cannot prove that no open PR
    // exists. Track that explicitly so classifyBranchCollision refuses
    // the autoSafe verdicts — otherwise an ancestor-of-master branch
    // would auto-delete without the open-PR check actually succeeding.
    prs = [];
    prsKnown = false;
  }
  return { head, isAncestor, prs, prsKnown };
}

function classifyBranchCollision(info) {
  if (!info) return { verdict: "no-such-branch", autoSafe: false };
  const open = info.prs.filter((p) => p && p.state === "OPEN");
  const merged = info.prs.filter((p) => p && p.state === "MERGED");
  // If we couldn't verify the PR list, refuse the autoSafe verdicts —
  // an ancestor-of-master branch might still have an open PR we can't
  // see. Escalate so the operator or agent can investigate.
  if (info.prsKnown === false) {
    return { verdict: "pr-lookup-unknown", autoSafe: false, open, merged };
  }
  if (open.length > 0) {
    return { verdict: "open-pr", autoSafe: false, open, merged };
  }
  if (info.isAncestor) {
    // Branch HEAD is already an ancestor of the default branch — there's no
    // diverged work to lose. Safe to delete.
    return { verdict: "orphan-ref", autoSafe: true, open, merged };
  }
  if (merged.length > 0) {
    // PR was squash-merged so HEAD isn't an ancestor, but the work landed.
    // Safe to delete the stale ref.
    return { verdict: "post-merge-stale", autoSafe: true, open, merged };
  }
  return { verdict: "diverged-unknown", autoSafe: false, open, merged };
}

function deleteHatcheryArtifacts(slice) {
  const remove = (p) => {
    if (typeof p !== "string" || p.length === 0) return;
    try { fs.unlinkSync(p); } catch { /* best effort */ }
  };
  remove(slice?.hatchery?.hatchery_request_path);
  remove(slice?.hatchery?.hatchery_result_path);
  remove(slice?.hatchery?.hatchery_log_path);
}

// Attempt to recover from a "branch already exists" dispatch failure
// without operator help. Reads classifyBranchCollision; for verdicts marked
// autoSafe, deletes the stale branch and removes the slice from state so the
// loop re-dispatches it on the next tick. For everything else, returns the
// verdict + detail string so the caller can include them in the escalation
// notification.
// Locate the git worktree (if any) that currently has the colliding branch
// checked out. Returns the worktree's filesystem path, or null when the
// branch isn't held by a worktree.
function findWorktreeForBranch(repoPath, branchName) {
  let out;
  try {
    out = execText("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
  } catch {
    return null;
  }
  const blocks = out.split("\n\n");
  for (const block of blocks) {
    const wt = block.match(/^worktree (.+)$/m);
    const br = block.match(/^branch refs\/heads\/(.+)$/m);
    if (wt && br && br[1].trim() === branchName) {
      return wt[1].trim();
    }
  }
  return null;
}

// Check whether a worktree path is empty of in-progress work — no
// uncommitted changes, no untracked files (other than git internals).
// Conservative: any output from "git status --porcelain" blocks removal.
function worktreeIsClean(worktreePath) {
  try {
    const out = execText("git", ["status", "--porcelain"], { cwd: worktreePath });
    return out.trim().length === 0;
  } catch {
    return false;
  }
}

// Check whether any agent-deck session in our worker group is currently
// pointing at this worktree. If a live session holds it, the worker may
// still be doing real work — never remove.
function agentDeckSessionHoldsWorktree(worktreePath) {
  try {
    const list = agentDeckList();
    if (!Array.isArray(list)) return false;
    return list.some((session) => {
      // Match the hatchery session parser's field-name precedence
      // (src/hatchery/spawn-handoff.ts:parseAgentDeckSession) so we never
      // refuse to recognize a live session because it exposes the
      // worktree as a different key — e.g. older "path", current
      // snake_case "worktree_path", or camelCase "worktreePath".
      const path = String(session?.worktree_path || session?.path || session?.worktreePath || "");
      return path === worktreePath;
    });
  } catch {
    return false;
  }
}

// Attempt to recover from a "branch already exists" dispatch failure
// without operator help. Reads classifyBranchCollision; for verdicts marked
// autoSafe, deletes the stale branch and removes the slice from state so the
// loop re-dispatches it on the next tick. For everything else, returns the
// verdict + detail string so the caller can include them in the escalation
// notification.
//
// If "git branch -D" fails because the branch is checked out in a worktree,
// inspects the worktree: when clean AND not held by an active agent-deck
// session, removes the worktree with "git worktree remove --force" first,
// then deletes the branch. Anything dirty or session-held escalates.
function tryRecoverBranchCollision(state, slice, sliceId, errorText) {
  const branchName = parseBranchCollisionError(errorText);
  if (!branchName) return null;
  const repoPath = state?.repo?.path || meta.repo?.path;
  if (typeof repoPath !== "string" || repoPath.length === 0) return null;
  const defaultBranch = state?.repo?.default_branch || meta.repo?.default_branch || null;
  const info = inspectCollidedBranch(repoPath, defaultBranch, branchName);
  const classification = classifyBranchCollision(info);
  const summary = info
    ? "branch=" + branchName + " head=" + (info.head || "").slice(0, 7) + " ancestor-of-" + (defaultBranch || "default") + "=" + info.isAncestor + " open_prs=[" + classification.open.map((p) => "#" + p.number).join(",") + "] merged_prs=[" + classification.merged.map((p) => "#" + p.number).join(",") + "]"
    : "branch=" + branchName + " (no local ref)";
  if (!classification.autoSafe) {
    return { recovered: false, verdict: classification.verdict, detail: summary };
  }
  let extra = "";
  try {
    execText("git", ["branch", "-D", branchName], { cwd: repoPath });
  } catch (err) {
    // git refuses when the branch is checked out by a worktree. Try to
    // unblock by removing the worktree — but only when it's safe (no
    // uncommitted changes, not held by an active agent-deck session).
    const worktreePath = findWorktreeForBranch(repoPath, branchName);
    if (!worktreePath) {
      return { recovered: false, verdict: classification.verdict + "-delete-failed", detail: summary + " | branch delete failed: " + (err?.message || String(err)) };
    }
    if (!worktreeIsClean(worktreePath)) {
      return { recovered: false, verdict: classification.verdict + "-worktree-dirty", detail: summary + " | branch held by worktree " + worktreePath + " with uncommitted changes; refusing to auto-remove" };
    }
    if (agentDeckSessionHoldsWorktree(worktreePath)) {
      return { recovered: false, verdict: classification.verdict + "-worktree-session", detail: summary + " | branch held by worktree " + worktreePath + " which is still owned by a live agent-deck session; operator must drain that session before re-dispatch" };
    }
    try {
      execText("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath });
    } catch (e2) {
      return { recovered: false, verdict: classification.verdict + "-worktree-remove-failed", detail: summary + " | worktree remove failed: " + (e2?.message || String(e2)) };
    }
    extra = " | worktree " + worktreePath + " removed";
    try {
      execText("git", ["branch", "-D", branchName], { cwd: repoPath });
    } catch (e3) {
      return { recovered: false, verdict: classification.verdict + "-delete-after-worktree-failed", detail: summary + extra + " | second branch delete failed: " + (e3?.message || String(e3)) };
    }
  }
  deleteHatcheryArtifacts(slice);
  delete state.slices[sliceId];
  return { recovered: true, verdict: classification.verdict, detail: summary + extra + " | branch deleted, slice released for re-dispatch" };
}

// Match the launchAgentDeckManager wrong-worktree refusal — the upstream
// n→n-1 agent-deck launch race where pickLaunchedSession attaches to the
// wrong sibling session. The error text is the contract; if it changes in
// spawn-handoff.ts, update the regex here in lockstep.
function parseWrongWorktreeRaceError(text) {
  const s = String(text || "");
  return /agent-deck manager session "[^"]+" attached to worktree "[^"]+" but this launch requested branch/.test(s);
}

function transientRetryCounts(state) {
  if (!state.transient_retry_counts || typeof state.transient_retry_counts !== "object") {
    state.transient_retry_counts = {};
  }
  return state.transient_retry_counts;
}

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
  const counts = transientRetryCounts(state);
  const prev = Number.isFinite(counts[sliceId]) ? counts[sliceId] : 0;
  const next = prev + 1;
  if (next > limit) {
    delete counts[sliceId];
    return {
      recovered: false,
      verdict: "wrong-worktree-race-persistent",
      detail: "wrong-worktree race recurred " + next + " times for this slice; auto-release exhausted, escalating for operator review",
    };
  }
  counts[sliceId] = next;
  deleteHatcheryArtifacts(slice);
  delete state.slices[sliceId];
  return {
    recovered: true,
    verdict: "wrong-worktree-race",
    detail: "agent-deck launch race detected (attempt " + next + "/" + limit + "); slice released for re-dispatch on next tick",
  };
}

// Adopt-open-PR recovery: when the branch collision verdict is "open-pr"
// for a PR that matches this slice's expected branch, the work is already
// in flight on GitHub. Don't escalate — transition the slice directly to
// pr-open so the loop's normal babysit picks up the PR going forward.
function tryAdoptOpenPr(state, slice, sliceId, errorText, ts) {
  const branchName = parseBranchCollisionError(errorText);
  if (!branchName) return null;
  const repoPath = state?.repo?.path || meta.repo?.path;
  if (typeof repoPath !== "string" || repoPath.length === 0) return null;
  const defaultBranch = state?.repo?.default_branch || meta.repo?.default_branch || null;
  const info = inspectCollidedBranch(repoPath, defaultBranch, branchName);
  const classification = classifyBranchCollision(info);
  if (classification.verdict !== "open-pr") return null;
  // Pick the first PR matching our slice branch, falling back to the
  // first open PR on the branch (the names diverge slightly between the
  // smithy dispatch branch slug and the actual feature/* git ref).
  const candidates = classification.open || [];
  const tentativeSlice = { branch: slice.branch || branchName };
  let chosen = candidates.find((p) => prMatchesSliceBranch(tentativeSlice, p));
  if (!chosen) chosen = candidates[0];
  if (!chosen) return null;
  let hydrated;
  try {
    hydrated = queryPrForBabysit({ pr: { number: chosen.number } }, state);
  } catch {
    return null;
  }
  if (!hydrated || hydrated.skipped) return null;
  // Transition the slice to pr-open with the discovered PR.
  slice.stage = "pr-open";
  slice.pr_open_at = ts;
  slice.branch = branchName.replace(/^feature\//, "");
  slice.last_action = ts;
  slice.last_action_note = "Adopted existing open PR #" + chosen.number;
  updatePrSnapshot(slice, hydrated);
  deleteHatcheryArtifacts(slice);
  return {
    recovered: true,
    verdict: "open-pr-adopted",
    detail: "branch=" + branchName + " head=" + (info?.head || "").slice(0, 7) + " | adopted PR #" + chosen.number + " (" + (hydrated.url || "") + ")",
  };
}

// Stranded-leftover recovery: a branch with diverged commits, no PR (open
// or merged), and no live agent-deck session owning its worktree is almost
// always the leftover of a previous stranded steward — the steward
// committed and pushed, then exited before opening the PR, and the slice
// was cleared or the steward record removed. The branch is "orphaned
// work" from the loop's perspective: re-dispatching produces fresh
// content; preserving it requires operator action (open the PR manually).
// Conservative auto-recovery: delete the branch + worktree, bump a retry
// counter, and let the new dispatch produce a clean steward run. This
// loses the prior partial work, but the manager-prompt + stranded-steward
// watchdog now make stranded leftovers exceptional, so this should rarely
// fire after the first one-time cleanup.
function tryRecoverStrandedLeftover(state, slice, sliceId, errorText, classification, info, branchName) {
  if (!info || info.isAncestor) return null;
  // classifyBranchCollision strips prsKnown from the diverged-unknown return
  // value, so read it from info directly (info comes from inspectCollidedBranch
  // which sets prsKnown explicitly based on whether the gh pr list succeeded).
  if (!info.prsKnown) return null;
  if ((classification.open || []).length > 0) return null;
  if ((classification.merged || []).length > 0) return null;
  if (classification.verdict !== "diverged-unknown") return null;
  const repoPath = state?.repo?.path || meta.repo?.path;
  if (typeof repoPath !== "string" || repoPath.length === 0) return null;
  // Refuse if a live agent-deck session still owns the worktree — that
  // means there's an active steward and we'd be racing it.
  const worktreePath = findWorktreeForBranch(repoPath, branchName);
  if (worktreePath && agentDeckSessionHoldsWorktree(worktreePath)) return null;
  const limit = 3;
  const counts = transientRetryCounts(state);
  const key = "stranded-leftover:" + sliceId;
  const prev = Number.isFinite(counts[key]) ? counts[key] : 0;
  const next = prev + 1;
  if (next > limit) {
    delete counts[key];
    return {
      recovered: false,
      verdict: "stranded-leftover-persistent",
      detail: "stranded-leftover cleanup recurred " + next + " times for " + branchName + "; auto-release exhausted, escalating for operator review",
    };
  }
  counts[key] = next;
  let extra = "";
  if (worktreePath) {
    try {
      execText("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath });
      extra = " | worktree " + worktreePath + " removed";
    } catch (err) {
      return { recovered: false, verdict: "stranded-leftover-worktree-remove-failed", detail: "worktree remove failed: " + (err?.message || String(err)) };
    }
  }
  try {
    execText("git", ["branch", "-D", branchName], { cwd: repoPath });
  } catch (err) {
    return { recovered: false, verdict: "stranded-leftover-delete-failed", detail: "branch delete failed: " + (err?.message || String(err)) };
  }
  // Delete the remote branch too. If we leave it behind, the re-dispatched
  // steward will push to a remote ref that diverged from the new local
  // branch (since the new local branch starts from origin/master while the
  // remote stranded ref still has the prior steward's commits). The result
  // is a push rejection on the new steward. The stranded-leftover verdict
  // already confirms no PR references this ref, so the remote ref has no
  // GitHub-side dependencies — safe to delete.
  let remoteExtra = "";
  try {
    execText("git", ["push", "--delete", "origin", branchName], { cwd: repoPath });
    remoteExtra = " | origin/" + branchName + " also deleted";
  } catch (err) {
    const msg = String(err?.message || err || "");
    // "remote ref does not exist" is fine — nothing to delete.
    if (/remote ref does not exist|src refspec.*does not match/i.test(msg)) {
      remoteExtra = " | no remote ref (already absent)";
    } else {
      // Otherwise surface the failure but don't roll back the local delete —
      // the loop will retry the dispatch and the same recovery will run
      // again. Note the failure for diagnosis.
      remoteExtra = " | WARNING remote ref delete failed: " + msg.slice(0, 200);
    }
  }
  deleteHatcheryArtifacts(slice);
  delete state.slices[sliceId];
  return {
    recovered: true,
    verdict: "stranded-leftover",
    detail: "branch=" + branchName + " head=" + (info.head || "").slice(0, 7) + " no PR, no live session (attempt " + next + "/" + limit + ")" + extra + remoteExtra + " | slice released for re-dispatch",
  };
}

// Codex spawn-error recovery: when 'git apply --index' rejects the patch
// codex produced — usually because codex truncated its output mid-diff
// ("corrupt patch at ...:N") or generated a patch that re-creates an
// existing file ("already exists in index") — re-running codex with the
// same prompt typically produces a different (often correct) output. Add
// a per-slice retry counter and escalate only if it persists.
function parseSpawnPatchError(text) {
  const s = String(text || "");
  if (/git apply --index failed/.test(s)) return true;
  if (/corrupt patch at /.test(s)) return true;
  if (/already exists in index/.test(s)) return true;
  return false;
}

function tryRecoverSpawnPatchError(state, slice, sliceId, errorText) {
  if (!parseSpawnPatchError(errorText)) return null;
  // Codex patch errors are deeply non-deterministic — same prompt, different
  // output each run. Give it a generous budget before declaring the artifact
  // genuinely undispatchable. The cost of each retry is one codex container
  // (~2-3 min), and we'd rather burn an hour of compute than strand a slice
  // that would have succeeded on attempt 7.
  const limit = 10;
  const counts = transientRetryCounts(state);
  const key = "spawn-error:" + sliceId;
  const prev = Number.isFinite(counts[key]) ? counts[key] : 0;
  const next = prev + 1;
  if (next > limit) {
    delete counts[key];
    return {
      recovered: false,
      verdict: "spawn-error-persistent",
      detail: "codex spawn produced an unapplicable patch " + next + " times for this slice; auto-release exhausted, escalating for operator review",
    };
  }
  counts[key] = next;
  deleteHatcheryArtifacts(slice);
  delete state.slices[sliceId];
  return {
    recovered: true,
    verdict: "spawn-error-retry",
    detail: "codex spawn patch error (attempt " + next + "/" + limit + "); slice released for re-dispatch on next tick",
  };
}

function completePendingHatcheryDispatches(state, ts) {
  const actions = [];
  const failures = [];
  const notifications = [];
  let mutated = false;
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const nowMs = Date.parse(ts);
  const queueDispatchEscalation = (slice, sliceId, reason, error) => {
    // Build a stable requestKey so requestLegateJudgement only fires once per
    // distinct failure mode. Without notification the agent never wakes and
    // the operator sees "loop is silent" while state.json piles up escalated
    // slices.
    const key = "hatchery-failure:" + sliceId + ":" + reason + ":" + hashText(String(error || "")).slice(0, 12);
    notifications.push({
      slice, sliceId, requestKey: key,
      reason: "hatchery_dispatch_failed",
      detail: "Hatchery dispatch for " + actionCommandLine({ command: slice.command, arguments: slice.arguments || [] }) + " escalated: " + reason + ".\n\nError:\n" + String(error || "(no detail)").trim() + "\n\nSlice has been marked escalated in state.json. If reason is 'spawn-error' with 'branch ... already exists' or any 'branch-collision-*' verdict, load legate.unwedge and run inspect-partial-work.sh / clean-stale-branch.sh — the loop auto-recovers orphan-ref and post-merge-stale cases, but anything with an open PR or unknown divergence reaches here for operator inspection. Otherwise run legate.error for worker-side recovery.",
    });
  };
  const escalateStale = (slice, sliceId, reason) => {
    const queuedMs = Date.parse(slice.last_action || "");
    if (!Number.isFinite(queuedMs) || !Number.isFinite(nowMs)) return false;
    if (nowMs - queuedMs <= HATCHERY_PENDING_TIMEOUT_MS) return false;
    const ageMin = Math.round((nowMs - queuedMs) / 60000);
    // Runner-silent recovery: the hatchery runner died before writing its
    // result file (almost always because the loop conductor was restarted
    // mid-spawn — detached:true doesnt fully insulate from tmux's session-
    // kill cascade). This is transient. Auto-clear the slice and let it
    // re-dispatch, capped by a per-slice retry counter.
    const limit = 3;
    const counts = transientRetryCounts(state);
    const key = "runner-silent:" + sliceId;
    const prev = Number.isFinite(counts[key]) ? counts[key] : 0;
    const nextN = prev + 1;
    if (nextN <= limit) {
      counts[key] = nextN;
      actions.push({
        action: "auto-recovered",
        sliceId,
        sessionId: null,
        detail: "runner-silent (" + reason + ") after " + ageMin + " min — likely loop restart killed the runner (attempt " + nextN + "/" + limit + "); slice released for re-dispatch",
      });
      deleteHatcheryArtifacts(slice);
      delete state.slices[sliceId];
      return true;
    }
    delete counts[key];
    const note = "NEED: Hatchery spawn " + reason + " after " + ageMin + " min and " + limit + " auto-retry attempts; runner is dying repeatedly — manual investigation required";
    slice.stage = "escalated";
    slice.last_action = ts;
    slice.last_action_note = note;
    failures.push({ slice_id: sliceId, command: actionCommandLine({ command: slice.command, arguments: slice.arguments || [] }), error: note });
    queueDispatchEscalation(slice, sliceId, "runner-silent-persistent", note);
    return true;
  };
  for (const [sliceId, slice] of Object.entries(slices)) {
    if (!slice || typeof slice !== "object" || slice.stage !== "hatchery-pending") continue;
    const resultPath = slice.hatchery?.hatchery_result_path;
    if (typeof resultPath !== "string" || resultPath.length === 0) continue;
    let raw;
    try {
      raw = fs.readFileSync(resultPath, "utf-8").trim();
    } catch (err) {
      if (err && err.code === "ENOENT") {
        if (escalateStale(slice, sliceId, "produced no result file")) mutated = true;
        continue;
      }
      failures.push({ slice_id: sliceId, command: actionCommandLine({ command: slice.command, arguments: slice.arguments || [] }), error: err?.message || String(err) });
      continue;
    }
    if (!raw) {
      // Empty result file = launchHatcheryDispatch wrote the placeholder but
      // the runner died before writing real content. Same failure mode as a
      // missing file; treat it the same way once the timeout has elapsed.
      if (escalateStale(slice, sliceId, "left an empty result file")) mutated = true;
      continue;
    }
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      continue;
    }
    if (result.error) {
      const errorText = String(result.error).trim();
      // Auto-recover branch-collision failures when the branch is provably
      // safe to delete (HEAD on default branch, or merged-PR + no open PR).
      // Anything ambiguous falls through to escalation with the verdict
      // included in the detail so the agent / operator has the full context.
      // Branch-collision adoption: if the colliding branch already has an
      // open PR matching this slice, the work is already in flight on
      // GitHub. Adopt the PR and transition the slice to pr-open instead
      // of escalating — there's nothing to recover.
      const adoption = tryAdoptOpenPr(state, slice, sliceId, errorText, ts);
      if (adoption && adoption.recovered) {
        actions.push({
          action: "auto-recovered",
          sliceId,
          sessionId: null,
          detail: "branch-collision " + adoption.verdict + ": " + adoption.detail,
        });
        mutated = true;
        continue;
      }
      const recovery = tryRecoverBranchCollision(state, slice, sliceId, errorText);
      if (recovery && recovery.recovered) {
        actions.push({
          action: "auto-recovered",
          sliceId,
          sessionId: null,
          detail: "branch-collision " + recovery.verdict + " auto-recovered: " + recovery.detail,
        });
        mutated = true;
        continue;
      }
      // Stranded-leftover recovery: a diverged branch with no PR and no
      // live session is almost always the residue of a previous stranded
      // steward. The branch-collision path above refused (verdict was
      // diverged-unknown, not autoSafe). Try the leftover cleanup with a
      // retry counter so a persistent diverged-unknown still escalates.
      let leftoverRecovery = null;
      if (recovery && recovery.verdict === "diverged-unknown") {
        const branchName = parseBranchCollisionError(errorText);
        const repoPath = state?.repo?.path || meta.repo?.path;
        const defaultBranch = state?.repo?.default_branch || meta.repo?.default_branch || null;
        const info = branchName ? inspectCollidedBranch(repoPath, defaultBranch, branchName) : null;
        const classification = classifyBranchCollision(info);
        leftoverRecovery = tryRecoverStrandedLeftover(state, slice, sliceId, errorText, classification, info, branchName);
        if (leftoverRecovery && leftoverRecovery.recovered) {
          actions.push({
            action: "auto-recovered",
            sliceId,
            sessionId: null,
            detail: leftoverRecovery.verdict + ": " + leftoverRecovery.detail,
          });
          mutated = true;
          continue;
        }
      }
      // Race-victim recovery runs only when branch-collision recovery had
      // nothing to do with the error. Order matters: a wrong-worktree
      // error never carries a "branch already exists" substring, so the
      // two paths are mutually exclusive — but checking branch-collision
      // first keeps the existing recovery behavior untouched.
      const raceRecovery = recovery ? null : tryRecoverWrongWorktreeRace(state, slice, sliceId, errorText);
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
      // (re-running produces different output). Retry up to 3 times via
      // the same transient_retry_counts machinery.
      const spawnRecovery = (recovery || raceRecovery) ? null : tryRecoverSpawnPatchError(state, slice, sliceId, errorText);
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
      const effectiveRecovery = recovery || raceRecovery || spawnRecovery || leftoverRecovery;
      const detail = effectiveRecovery ? errorText + "\n\nLoop verdict: " + effectiveRecovery.detail : errorText;
      slice.stage = "escalated";
      slice.last_action = ts;
      slice.last_action_note = "NEED: Hatchery dispatch failed: " + detail;
      failures.push({ slice_id: sliceId, command: actionCommandLine({ command: slice.command, arguments: slice.arguments || [] }), error: detail });
      const reasonTag = recovery
        ? "branch-collision-" + recovery.verdict
        : (raceRecovery ? raceRecovery.verdict : (spawnRecovery ? spawnRecovery.verdict : (leftoverRecovery ? leftoverRecovery.verdict : "spawn-error")));
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
    // elapsed time without being reset by subsequent markSliceAction calls.
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

// Ghost-steward cleanup: launchAgentDeckManager creates the agent-deck
// session BEFORE codex spawn + patch apply + manager-prompt send. If anything
// fails after the launch but before the success path (codex truncation,
// "already exists in index", etc.) the session is left dangling: its worktree
// is empty, claude is running with no prompt to act on, and the slice it
// belongs to is either escalated or gone from state.slices. The session is
// alive enough that agentDeckSessionHoldsWorktree() refuses to delete its
// branch, which blocks future dispatches of the same artifact.
//
// Detect such sessions on each tick and remove them. A session is a ghost
// when:
//   - it's in the worker_group, AND
//   - its worktree path's basename doesn't match the expected worktree dir
//     of any non-terminal slice's branch, AND
//   - it's at least 5 minutes old (give legitimate launches time to be
//     linked to their slice's worker_session_id)
function runGhostStewardCleanup(state, workerList, ts) {
  const actions = [];
  let mutated = false;
  if (!Array.isArray(workerList)) return { actions, mutated };
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const activeDirs = new Set();
  const activeSessionIds = new Set();
  for (const [_sid, slice] of Object.entries(slices)) {
    if (!slice || typeof slice !== "object") continue;
    if (isTerminalSlice(slice)) continue;
    const sessId = slice.worker_session_id;
    if (typeof sessId === "string" && sessId.length > 0) activeSessionIds.add(sessId);
    const br = typeof slice.branch === "string" ? slice.branch : "";
    if (br.length === 0) continue;
    // Slice tracks the bare branch (e.g., "smithy/forge/...") while agent-deck
    // creates "feature/<branch>" worktree dirs. Cover both forms.
    const stripped = br.replace(/^feature\//, "");
    activeDirs.add("feature-" + stripped.replace(/\//g, "-"));
  }
  const nowMs = Date.parse(ts);
  const minAgeMs = 5 * 60 * 1000;
  for (const session of workerList) {
    if (!session || typeof session !== "object") continue;
    if (!isWorkerSession(session)) continue;
    if (typeof session.id === "string" && activeSessionIds.has(session.id)) continue;
    const worktreePath = session.worktreePath || session.worktree_path || session.path;
    if (typeof worktreePath !== "string" || worktreePath.length === 0) continue;
    const dirName = path.basename(worktreePath);
    if (activeDirs.has(dirName)) continue;
    const createdAt = Date.parse(session.created_at || session.createdAt || "");
    if (Number.isFinite(createdAt) && Number.isFinite(nowMs) && nowMs - createdAt < minAgeMs) continue;
    try {
      execFileSync("agent-deck", ["-p", meta.profile, "session", "remove", session.id, "--prune-worktree", "--force"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      actions.push({
        action: "ghost-cleanup",
        sessionId: session.id,
        title: session.title || "",
        detail: "removed ghost steward (worktree " + dirName + " not tracked by any non-terminal slice)",
      });
      mutated = true;
    } catch (err) {
      // Surface the failure as a note but keep going — next tick can retry.
      actions.push({
        action: "ghost-cleanup-failed",
        sessionId: session.id,
        title: session.title || "",
        detail: "agent-deck session remove failed for " + dirName + ": " + (err?.message || String(err)).slice(0, 200),
      });
    }
  }
  return { actions, mutated };
}

// Orphaned-PR steward re-launch: when a non-terminal slice has a PR but its
// worker_session_id either is null or points to a session that no longer
// exists in agent-deck, the slice is stuck. Babysit cannot send /smithy.fix
// to a missing session. Re-attach a fresh opus steward to the existing
// branch+worktree so the slice is babysit-ready again.
//
// Two cases this handles:
//   - tryAdoptOpenPr transitioned the slice to pr-open without ever launching
//     a session (the PR came from a previous run whose steward is gone).
//   - A bulk session-remove (manual or by ghost-cleanup) took the steward
//     while the slice was still pr-open / pr-in-fix.
//
// Throttle to 3 attempts per slice via transient_retry_counts so a
// genuinely-broken re-launch path doesn't loop forever.
function runStewardRelaunch(state, workerList, ts) {
  const actions = [];
  const failures = [];
  let mutated = false;
  if (!Array.isArray(workerList)) return { actions, failures, mutated };
  const liveSessionIds = new Set();
  for (const s of workerList) {
    if (isWorkerSession(s) && typeof s.id === "string") liveSessionIds.add(s.id);
  }
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const eligibleStages = new Set([
    "implementing",
    "pr-open",
    "pr-in-fix",
    "pr-resolving-conflicts",
    "pr-rebasing",
    "pr-in-rerun",
  ]);
  const repoPath = state?.repo?.path || meta.repo?.path;
  if (typeof repoPath !== "string" || repoPath.length === 0) return { actions, failures, mutated };
  for (const [sliceId, slice] of Object.entries(slices)) {
    if (!slice || typeof slice !== "object") continue;
    if (!eligibleStages.has(slice.stage)) continue;
    const pr = slice.pr || {};
    if (!pr.number) continue;
    const sessId = slice.worker_session_id;
    if (typeof sessId === "string" && sessId.length > 0 && liveSessionIds.has(sessId)) continue;
    const rawBranch = typeof slice.branch === "string" ? slice.branch : "";
    if (rawBranch.length === 0) continue;
    const bareBranch = rawBranch.replace(/^feature\//, "");
    const featureBranch = "feature/" + bareBranch;
    const expectedDirName = "feature-" + bareBranch.replace(/\//g, "-");
    // Throttle.
    const limit = 3;
    const counts = transientRetryCounts(state);
    const key = "relaunch-steward:" + sliceId;
    const prev = Number.isFinite(counts[key]) ? counts[key] : 0;
    const nextN = prev + 1;
    if (nextN > limit) continue;
    counts[key] = nextN;
    // Compute worktree path. Use the slice's recorded worktree_path when
    // it points at an extant directory; otherwise derive from the repo
    // parent (agent-deck's sibling-worktree convention: <repoParent>/
    // WorkTrees/<repoName>/<expectedDirName>).
    const worktreesParent = path.join(path.dirname(repoPath), "WorkTrees", path.basename(repoPath));
    let worktreePath = slice.worktree_path || path.join(worktreesParent, expectedDirName);
    if (!fs.existsSync(worktreePath)) {
      // Try to re-create from the branch ref.
      try {
        fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
        execText("git", ["worktree", "add", worktreePath, featureBranch], { cwd: repoPath });
      } catch (err) {
        actions.push({
          action: "relaunch-failed",
          sliceId,
          sessionId: null,
          detail: "could not recreate worktree at " + worktreePath + " from branch " + featureBranch + ": " + (err?.message || String(err)).slice(0, 200),
        });
        continue;
      }
    }
    // Launch a fresh agent-deck session attached to the existing worktree.
    // No -b: don't create a new branch. The session attaches to whatever
    // branch the worktree is on.
    const launchTitle = slice.worker_title || ("steward: " + sliceId);
    let beforeIds;
    try {
      const beforeList = agentDeckList();
      beforeIds = new Set(Array.isArray(beforeList) ? beforeList.map((s) => s.id) : []);
    } catch {
      beforeIds = new Set();
    }
    const launchArgs = [
      "-p", meta.profile,
      "launch",
      repoPath,
      "-t", launchTitle,
      "-c", "claude",
      "-g", meta.worker_group,
      "--worktree", bareBranch,
      "--title-lock",
      "--extra-arg", "--permission-mode",
      "--extra-arg", "auto",
      "--extra-arg", "--model",
      "--extra-arg", "opus",
    ];
    try {
      execFileSync("agent-deck", launchArgs, {
        encoding: "utf-8",
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      actions.push({
        action: "relaunch-failed",
        sliceId,
        sessionId: null,
        detail: "agent-deck launch failed: " + (err?.message || String(err)).slice(0, 200),
      });
      continue;
    }
    // Identify the new session by diffing the list.
    let newSessionId = null;
    try {
      const afterList = agentDeckList();
      if (Array.isArray(afterList)) {
        for (const s of afterList) {
          if (!isWorkerSession(s)) continue;
          if (beforeIds.has(s.id)) continue;
          newSessionId = s.id;
          break;
        }
      }
    } catch {}
    if (!newSessionId) {
      actions.push({
        action: "relaunch-failed",
        sliceId,
        sessionId: null,
        detail: "agent-deck launch returned no identifiable new session",
      });
      continue;
    }
    // Enable session-level auto-mode (parity with launchAgentDeckManager).
    try {
      execFileSync("agent-deck", ["-p", meta.profile, "session", "set", newSessionId, "auto-mode", "true"], {
        encoding: "utf-8",
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {}
    // Send a context message so claude knows it's a steward on a PR.
    const contextMsg = [
      "[STEWARD RESUME] You are the re-launched March Hatchery management session for PR #" + pr.number + ".",
      "Branch: " + featureBranch,
      "PR: " + (pr.url || "(unknown)"),
      "",
      "The previous steward session for this slice was removed; the loop has attached you to the",
      "existing worktree so future babysit messages have somewhere to go. Stand by for:",
      "  - '/smithy.fix <thread-summary>' if review threads need a response.",
      "  - Conflict-resolution prompts if the branch develops merge conflicts.",
      "  - CI-failure judgement requests.",
      "",
      "When such a message arrives, act on it directly: inspect, fix, commit, push.",
      "Do not pre-emptively rewrite anything; the PR is already open and may be in review.",
    ].join("\n");
    try {
      execFileSync("agent-deck", ["-p", meta.profile, "session", "send", newSessionId, contextMsg], {
        encoding: "utf-8",
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      // Best-effort: session is alive; future babysit messages will still reach it.
    }
    slice.worker_session_id = newSessionId;
    slice.worker_title = launchTitle;
    slice.worktree_path = worktreePath;
    slice.last_action = ts;
    slice.last_action_note = "Re-launched steward for PR #" + pr.number + " (attempt " + nextN + "/" + limit + "); new session " + newSessionId;
    mutated = true;
    actions.push({
      action: "relaunch-steward",
      sliceId,
      sessionId: newSessionId,
      detail: "re-attached opus steward to PR #" + pr.number + " on " + featureBranch + " (attempt " + nextN + "/" + limit + ")",
    });
  }
  return { actions, failures, mutated };
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
function handleRecoveryDispatch(state, ts, item, sliceId, mergedArchive) {
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
      const direct = launchDirectStewardDispatch(state, ts, item, sliceId, mergedArchive);
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
    const resultPath = hatcheryResultPath(recoverySliceId);
    const logPath = hatcheryLogPath(recoverySliceId);
    const requestPath = hatcheryRequestPath(recoverySliceId);
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
        hatchery_result_path: resultPath,
        hatchery_request_path: requestPath,
        hatchery_log_path: logPath,
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
    writeJson(meta.legate_state_path, state);
    const launched = launchHatcheryDispatch(item, resultPath, logPath, {
      branchOverride: recoveryBranch,
      titleOverride: recoveryTitle,
      promptOverride: buildSmithyRecoverySpawnPrompt(item, mergedArchive, attempt),
      requestSliceIdOverride: recoverySliceId,
    });
    actions.push({
      action: "recovery_dispatch",
      sliceId: recoverySliceId,
      sessionId: null,
      detail: "queued Hatchery recovery codex spawn pid " + (launched.pid || "unknown")
        + " (attempt " + attempt + " of " + MAX_RECOVERY_ATTEMPTS + ") "
        + "for " + actionCommandLine(action)
        + (mergedArchive?.pr?.number ? "; prior PR #" + mergedArchive.pr.number : ""),
    });
  } catch (err) {
    const error = err?.message || String(err);
    const existing = state.slices?.[recoverySliceId];
    if (existing && existing.stage === "hatchery-pending") {
      existing.stage = "escalated";
      existing.last_action = ts;
      existing.last_action_note = "NEED: Hatchery recovery dispatch launch failed: " + error;
      notifications.push({
        slice: existing, sliceId: recoverySliceId,
        requestKey: "hatchery-failure:" + recoverySliceId + ":launch-throw:" + hashText(error).slice(0, 12),
        reason: "hatchery_recovery_dispatch_failed",
        detail: "Hatchery recovery dispatch launch threw for " + actionCommandLine(item.next_action)
          + " (recovery attempt " + attempt + ").\n\nError:\n" + error
          + "\n\nSlice is escalated in state.json. legate.unwedge / legate.error as appropriate.",
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

function runDispatch(state, ts) {
  const actions = [];
  const failures = [];
  if (!state) return { actions, failures, mutated: false };
  const repoPath = state?.repo?.path || meta.repo?.path;
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    failures.push({ error: "repo path is missing" });
    return { actions, failures, mutated: false };
  }
  if (!state.slices || typeof state.slices !== "object") state.slices = {};
  const completed = completePendingHatcheryDispatches(state, ts);
  actions.push(...completed.actions);
  failures.push(...completed.failures);
  let mutated = completed.mutated;
  // Wake the legate agent for each escalation produced by completion (spawn
  // errors and stale-pending timeouts). requestLegateJudgement is idempotent
  // by requestKey so duplicate ticks won't spam the doorbell.
  for (const n of completed.notifications || []) {
    requestLegateJudgement({
      ts, slice: n.slice, sliceId: n.sliceId,
      requestKey: n.requestKey, reason: n.reason, detail: n.detail,
    });
  }

  // Pull the default branch BEFORE reading smithy status. Without this,
  // smithy reads a stale local tasks.md and either (a) reports a row as
  // ready when a merge elsewhere has already ticked the box (triggering
  // pointless recovery dispatches) or (b) misses a newly-ready row that a
  // recent merge unblocked. Fetch is best-effort: on failure (network blip,
  // repo lock) the tick still proceeds against whatever the local repo last
  // saw — cleanup/babysit/etc. don't need fresh local state, and the next
  // tick will retry. We do NOT escalate fetch failures — they are noise on a
  // healthy system.
  try {
    syncDefaultBranch(state);
  } catch (err) {
    const error = err?.message || String(err);
    appendText(
      meta.processor_log_path,
      "[" + ts + "] sync warning: " + error + " — proceeding against stale local repo",
    );
    append(meta.processor_events_path, {
      schema_version: 1,
      ts,
      processor: meta.processor_name,
      paired_legate: meta.paired_legate,
      kind: "sync_warning",
      error,
    });
  }

  let status;
  try {
    status = readSmithyStatus(repoPath);
  } catch (err) {
    const error = err?.message || String(err);
    const failure = { error, phase: "read-smithy-status" };
    failures.push(failure);
    append(meta.processor_events_path, {
      schema_version: 1,
      ts,
      processor: meta.processor_name,
      paired_legate: meta.paired_legate,
      kind: "dispatch_read_failure",
      ...failure,
    });
    appendText(meta.processor_log_path, "[" + ts + "] dispatch read failed: " + error);
    if (mutated) writeJson(meta.legate_state_path, state);
    return { actions, failures, mutated };
  }
  state.last_smithy_status_at = ts;

  const ready = readySmithyItems(status);
  // Queue depth for the heartbeat metrics / HTTP /status: dispatchable = ready
  // now; total = all non-virtual pending tasks with a next_action; blocked = the
  // rest (waiting on dependencies or a command this loop doesn't dispatch).
  const candidates = Array.isArray(status?.records)
    ? status.records.filter((r) => r && r.next_action && !r.virtual)
    : [];
  const queue = {
    dispatchable: ready.length,
    total: candidates.length,
    blocked: Math.max(0, candidates.length - ready.length),
  };
  mutated = true;
  for (const item of ready) {
    const sliceId = dispatchSliceId(item);
    // Live-slice dedup first. If a worker (or a prior recovery attempt) is
    // already in-flight for this item, never queue a second.
    if (inFlightSliceMatches(state, item, sliceId)) continue;

    // Partial-merge recovery: smithy still reports the item as ready, but a
    // prior MERGED archive entry collides with the to-be-minted slice id.
    // Without this branch, alreadyArchivedSlice silently filtered the item
    // and the loop went idle on real work. See Balexda/March#140.
    const blockingMerged = blockingMergedArchive(state, item, sliceId);
    if (blockingMerged) {
      const recoveryResult = handleRecoveryDispatch(state, ts, item, sliceId, blockingMerged);
      if (recoveryResult) {
        actions.push(...recoveryResult.actions);
        failures.push(...recoveryResult.failures);
        for (const n of recoveryResult.notifications || []) {
          requestLegateJudgement({
            ts, slice: n.slice, sliceId: n.sliceId,
            requestKey: n.requestKey, reason: n.reason, detail: n.detail,
          });
        }
      }
      continue;
    }

    // Defensive: anything else in archived_slices (escalated, closed-unmerged,
    // hash-stub) still blocks. blockingMergedArchive returns null for those
    // cases on purpose — only MERGED archives are recovery candidates.
    if (alreadyArchivedSlice(state, item, sliceId)) continue;

    // Trust smithy's readyLayerNodeIds filter as the authoritative "ready
    // to work" set. The previous extra dependenciesClear gate disagreed
    // with smithy on slice-level deps: a tasks.md row's depends_on would
    // reference the bare tasks.md path while smithy's graph keys those
    // nodes as path#S<n>, so graphNode returned null and the dep was
    // conservatively treated as unresolved — even though smithy itself
    // had already cleared the item to layer 0. Letting smithy own the
    // readiness verdict matches the operator's "smithy status --graph"
    // mental model and gets the loop to dispatch every layer-0 item.

    try {
      // syncDefaultBranch already ran at the top of runDispatch; no need
      // to re-fetch per dispatch.
      const action = item.next_action || {};
      const resultPath = hatcheryResultPath(sliceId);
      const logPath = hatcheryLogPath(sliceId);
      const requestPath = hatcheryRequestPath(sliceId);
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
          hatchery_result_path: resultPath,
          hatchery_request_path: requestPath,
          hatchery_log_path: logPath,
        },
        last_action: ts,
        last_action_note: "Queued Hatchery codex spawn for " + actionCommandLine(action),
      };
      writeJson(meta.legate_state_path, state);
      const launched = launchHatcheryDispatch(item, resultPath, logPath);
      actions.push({
        action: "dispatch",
        sliceId,
        sessionId: null,
        detail: "queued Hatchery codex spawn pid " + (launched.pid || "unknown") + " for " + actionCommandLine(action),
      });
    } catch (err) {
      const error = err?.message || String(err);
      const existing = state.slices?.[sliceId];
      if (existing && existing.stage === "hatchery-pending") {
        existing.stage = "escalated";
        existing.last_action = ts;
        existing.last_action_note = "NEED: Hatchery dispatch launch failed: " + error;
        mutated = true;
        // Wake the legate agent — without this the operator only sees state.json
        // grow stale while the loop appears idle.
        requestLegateJudgement({
          ts, slice: existing, sliceId,
          requestKey: "hatchery-failure:" + sliceId + ":launch-throw:" + hashText(error).slice(0, 12),
          reason: "hatchery_dispatch_failed",
          detail: "Hatchery dispatch launch threw for " + actionCommandLine(item.next_action) + ".\n\nError:\n" + error + "\n\nSlice is escalated in state.json. For 'branch already exists' surface this via legate.unwedge; otherwise legate.error.",
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
  }
  if (mutated) writeJson(meta.legate_state_path, state);
  return { actions, failures, mutated, queue };
}

function tick() {
  const ts = now();
  let state = null;
  let stateError = null;
  try {
    state = readJsonIfPresent(meta.legate_state_path);
  } catch (err) {
    stateError = err?.message || String(err);
  }
  const workerList = agentDeckList();
  const cleanupResult = cleanupTerminalPrs(state, workerList, ts);
  const postCleanupWorkerList = cleanupResult.cleanups.length > 0
    ? agentDeckList()
    : workerList;
  const ghostResult = runGhostStewardCleanup(state, postCleanupWorkerList, ts);
  const postGhostWorkerList = ghostResult.actions.length > 0
    ? agentDeckList()
    : postCleanupWorkerList;
  const relaunchResult = runStewardRelaunch(state, postGhostWorkerList, ts);
  const babysitWorkerList = relaunchResult.actions.length > 0
    ? agentDeckList()
    : postGhostWorkerList;
  const babysitResult = runBabysit(state, babysitWorkerList, ts);
  const dispatchResult = runDispatch(state, ts);
  const summaryWorkerList = cleanupResult.cleanups.length > 0 || ghostResult.actions.length > 0 || relaunchResult.actions.length > 0 || babysitResult.actions.length > 0 || dispatchResult.actions.length > 0
    ? agentDeckList()
    : workerList;
  const workers = summarizeWorkers(summaryWorkerList);
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const archived = state?.archived_slices && typeof state.archived_slices === "object"
    ? state.archived_slices
    : {};
  const record = {
    schema_version: 1,
    ts,
    processor: meta.processor_name,
    paired_legate: meta.paired_legate,
    kind: "heartbeat",
    mode: "terminal-pr-maintenance",
    state_present: Boolean(state),
    state_error: stateError,
    slice_count: Object.keys(slices).length,
    archived_slice_count: Object.keys(archived).length,
    workers,
    cleanup_count: cleanupResult.cleanups.length,
    cleanup_failure_count: cleanupResult.failures.length,
    ghost_cleanup_count: ghostResult.actions.filter((a) => a.action === "ghost-cleanup").length,
    relaunch_count: relaunchResult.actions.filter((a) => a.action === "relaunch-steward").length,
    babysit_action_count: babysitResult.actions.length,
    processor_request_count: babysitResult.requests.length,
    dispatch_action_count: dispatchResult.actions.length,
    dispatch_failure_count: dispatchResult.failures.length,
    dispatchable_count: dispatchResult.queue?.dispatchable ?? 0,
    blocked_count: dispatchResult.queue?.blocked ?? 0,
    pending_total: dispatchResult.queue?.total ?? 0,
  };
  append(heartbeatEventsPath, record);
  lastHeartbeat = record;
  for (const cleanup of cleanupResult.cleanups) {
    append(meta.processor_events_path, cleanup);
    appendText(meta.processor_log_path, formatCleanupLine(cleanup));
  }
  for (const action of ghostResult.actions) {
    const event = {
      schema_version: 1,
      ts,
      processor: meta.processor_name,
      paired_legate: meta.paired_legate,
      kind: "ghost_cleanup",
      action: action.action,
      session_id: action.sessionId,
      title: action.title,
      detail: action.detail,
    };
    append(meta.processor_events_path, event);
    appendText(meta.processor_log_path, "[" + ts + "] " + action.action + " " + action.sessionId + " " + (action.title || "") + ": " + action.detail + "\n");
  }
  for (const action of relaunchResult.actions) {
    const event = {
      schema_version: 1,
      ts,
      processor: meta.processor_name,
      paired_legate: meta.paired_legate,
      kind: "steward_relaunch",
      action: action.action,
      slice_id: action.sliceId,
      session_id: action.sessionId,
      detail: action.detail,
    };
    append(meta.processor_events_path, event);
    appendText(meta.processor_log_path, "[" + ts + "] " + action.action + " " + action.sliceId + ": " + action.detail + "\n");
  }
  for (const failure of cleanupResult.failures) {
    append(meta.processor_events_path, {
      schema_version: 1,
      ts,
      processor: meta.processor_name,
      paired_legate: meta.paired_legate,
      kind: "cleanup_failure",
      ...failure,
    });
    appendText(meta.processor_log_path, formatCleanupFailureLine({ ts, ...failure }));
  }
  for (const action of babysitResult.actions) {
    const event = {
      schema_version: 1,
      ts,
      processor: meta.processor_name,
      paired_legate: meta.paired_legate,
      kind: "babysit_action",
      action: action.action,
      slice_id: action.sliceId,
      session_id: action.sessionId,
      pr_number: action.pr?.number ?? null,
      pr_url: action.pr?.url ?? null,
      detail: action.detail,
    };
    append(meta.processor_events_path, event);
    appendText(meta.processor_log_path, formatBabysitActionLine(event));
  }
  for (const failure of babysitResult.failures) {
    const event = {
      schema_version: 1,
      ts,
      processor: meta.processor_name,
      paired_legate: meta.paired_legate,
      kind: "babysit_failure",
      ...failure,
    };
    append(meta.processor_events_path, event);
    appendText(
      meta.processor_log_path,
      `[${ts}] babysit failed ${failure.slice_id || "unknown"}: ${failure.error}`,
    );
  }
  for (const action of dispatchResult.actions) {
    const isRecovery = action.action === "recovery_dispatch" || action.action === "direct_dispatch";
    const logPrefix = action.action === "recovery_dispatch"
      ? "recovery-dispatch"
      : action.action === "direct_dispatch"
      ? "direct-dispatch"
      : "dispatch";
    const event = {
      schema_version: 1,
      ts,
      processor: meta.processor_name,
      paired_legate: meta.paired_legate,
      kind: isRecovery ? "recovery_dispatch" : "dispatch_action",
      action: action.action,
      slice_id: action.sliceId,
      session_id: action.sessionId,
      detail: action.detail,
    };
    append(meta.processor_events_path, event);
    appendText(
      meta.processor_log_path,
      "[" + ts + "] " + logPrefix + " " + action.sliceId + ": " + action.detail,
    );
  }
  appendTextSilent(
    heartbeatLogPath,
    `[${ts}] heartbeat slice_count=${record.slice_count} archived=${record.archived_slice_count} cleanups=${record.cleanup_count} ghost_cleanups=${record.ghost_cleanup_count} relaunches=${record.relaunch_count} babysit_actions=${record.babysit_action_count} dispatches=${record.dispatch_action_count} processor_requests=${record.processor_request_count} workers=${JSON.stringify(workers)}${stateError ? " state_error=" + stateError : ""}`,
  );
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

function safeTick() {
  const startedAt = Date.now();
  try {
    tick();
  } catch (err) {
    logTickError(err);
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
  safeTick();
  const timer = setInterval(safeTick, Math.max(10, intervalSeconds) * 1000);
  return {
    stop: () => clearInterval(timer),
  };
}

