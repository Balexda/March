/**
 * Pure parsers over a spawn's line-delimited codex CLI output
 * (`spawn-output.log`). No I/O — callers pass the already-read log text.
 *
 * Two jobs:
 *  - {@link classifyAgentFailure}: turn a failed spawn's log into a bounded
 *    failure-reason enum. The codex auth lapse ("refresh token already used")
 *    was previously invisible to telemetry — it lumped into
 *    `failure_stage="container_run"` with no way to tell agent-death from any
 *    other container failure (the smithy-profile-idle incident). This makes it a
 *    first-class, alertable signal.
 *  - {@link parseTokenUsage}: pull the per-turn token accounting codex emits on
 *    the final `turn.completed` line.
 */

/**
 * Why a spawn's agent (codex CLI) failed, as a LOW-CARDINALITY metric label.
 * Keep bounded — never carry ids or free text. `"none"` means no agent-level
 * failure was found in the log (the failure, if any, was elsewhere in the
 * handoff: patch apply, steward send, ...).
 */
export type AgentFailureReason = "auth" | "rate_limit" | "timeout" | "other" | "none";

/** Token accounting from a codex `turn.completed` line. */
export interface AgentTokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

/** Yield each parsed JSON object from the line-delimited (and possibly
 * `>`-prefixed, as the spawn log sometimes indents) codex output. */
function* parseJsonLines(logs: string): Generator<Record<string, unknown>> {
  for (const raw of logs.split("\n")) {
    const line = raw.trim().replace(/^>+\s*/, "").trim();
    if (!line.startsWith("{")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj && typeof obj === "object") yield obj as Record<string, unknown>;
  }
}

/** Map a codex error message to a bounded reason. */
function reasonFromMessage(message: string): Exclude<AgentFailureReason, "none"> {
  const m = message.toLowerCase();
  // codex OAuth lapse: "Your access token could not be refreshed because your
  // refresh token was already used. Please log out and sign in again."
  if (
    m.includes("refresh token") ||
    m.includes("could not be refreshed") ||
    m.includes("log out and sign in") ||
    m.includes("unauthorized") ||
    m.includes("authentication")
  ) {
    return "auth";
  }
  if (m.includes("rate limit") || m.includes("rate-limit") || m.includes("429") || m.includes("quota")) {
    return "rate_limit";
  }
  if (m.includes("timed out") || m.includes("timeout") || m.includes("deadline")) {
    return "timeout";
  }
  return "other";
}

/**
 * Classify why the agent failed from its log. Scans for codex `type:"error"`
 * and `type:"turn.failed"` records and maps their message to a bounded reason.
 * Returns `"none"` when no agent-level error record is present (e.g. the
 * container ran fine and the dispatch failed in a later, non-agent step).
 */
export function classifyAgentFailure(logs: string): AgentFailureReason {
  let found: AgentFailureReason = "none";
  for (const obj of parseJsonLines(logs)) {
    const type = obj.type;
    let message: string | undefined;
    if (type === "error" && typeof obj.message === "string") {
      message = obj.message;
    } else if (type === "turn.failed") {
      const err = obj.error;
      if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
        message = (err as Record<string, unknown>).message as string;
      }
    }
    if (message === undefined) continue;
    const reason = reasonFromMessage(message);
    // Prefer a specific reason (auth/rate_limit/timeout) over a later generic
    // "other" — the auth `error` line precedes the echoed `turn.failed`, but
    // don't let an unclassifiable line downgrade an already-specific finding.
    if (found === "none" || (found === "other" && reason !== "other")) {
      found = reason;
    }
  }
  return found;
}

/**
 * Extract per-turn token usage from the LAST `turn.completed` line in the log
 * (codex emits one per turn; the last reflects the completed spawn). Returns
 * `undefined` when no usage line is present. Missing sub-fields default to 0.
 */
export function parseTokenUsage(logs: string): AgentTokenUsage | undefined {
  let usage: AgentTokenUsage | undefined;
  for (const obj of parseJsonLines(logs)) {
    if (obj.type !== "turn.completed") continue;
    const u = obj.usage;
    if (!u || typeof u !== "object") continue;
    const rec = u as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    usage = {
      inputTokens: num(rec.input_tokens),
      cachedInputTokens: num(rec.cached_input_tokens),
      outputTokens: num(rec.output_tokens),
      reasoningOutputTokens: num(rec.reasoning_output_tokens),
    };
  }
  return usage;
}
