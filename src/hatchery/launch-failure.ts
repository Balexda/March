/**
 * Structured launch-failure classes for a failed Hatchery spawn (launch-failure
 * recovery plan, step 2).
 *
 * Every failed launch used to reach the legate as an error STRING, and the
 * legate retried every `hatchery_dispatch_failed` escalation forever. That is
 * right for an outage and pointless for a failure that clears only when someone
 * changes something. Hatchery now reports a {@link LaunchFailure} — a bounded
 * `class`, the `retry` policy the legate must follow, and the `evidence` the
 * operator needs — on the job record (`JobError.failure`). The legate folds it
 * onto `slice.escalated`, so the class survives a restart.
 *
 * This module is PURE (no I/O): types, the class → policy table, the
 * classifiers that derive a class from a bounded reason code, a bounded agent
 * message extractor, and the validator Herald and the legate use on the wire.
 * Git-derived evidence lives in {@link ./launch-failure-evidence.ts}.
 *
 * No raw secret-bearing text: evidence fields are SHAs, paths, counts, PR
 * numbers, and one bounded, redacted agent message (matching the fixed-diagnostic
 * rule in `integration-outcome.ts`). Subprocess stderr never enters evidence.
 */

/** The bounded failure-class vocabulary. Also a span attribute (`march.failure_class`). */
export const LAUNCH_FAILURE_CLASSES = [
  // Outages: the world heals by itself.
  "castra_error",
  "docker_error",
  "timeout",
  "worker_exit",
  "tessera_unreachable",
  "rate_limit",
  // Workers vary run to run.
  "patch_apply_failed",
  "patch_conflict",
  "extraction_rejected",
  "commit_failed",
  "push_failed",
  "pr_failed",
  "persistence",
  "missing_lifecycle",
  // Needs a change before it can succeed (policy depends on the evidence).
  "branch_collision",
  "agent_declined",
  // Stack-wide credential conditions: the spawn breaker + the operator fix.
  "auth",
  // Unknown: fail-open for retry, observed.
  "other",
] as const;
export type LaunchFailureClass = (typeof LAUNCH_FAILURE_CLASSES)[number];

/**
 * What the legate does with a failed launch.
 *  - `auto`: today's exponential backoff + AIMD re-dispatch.
 *  - `adopt`: an open PR already owns the branch; adopt it, never re-spawn.
 *  - `operator`: unpushed work is in the way; hold until an operator acts.
 *  - `until_input_changes`: the agent declined on purpose; hold until the
 *    slice's task file or parent spec changes on the default branch, then
 *    dispatch once.
 */
export const LAUNCH_RETRY_POLICIES = ["auto", "adopt", "operator", "until_input_changes"] as const;
export type LaunchRetryPolicy = (typeof LAUNCH_RETRY_POLICIES)[number];

/** Blob hash of one plan artifact at the commit the agent declined at. */
export interface DeclinedArtifact {
  readonly path: string;
  /** Git blob id, or null when the path did not exist at that commit. */
  readonly blob: string | null;
}

/** Bounded evidence carried with a failure. Every field is optional. */
export interface LaunchFailureEvidence {
  /** Branch the launch collided with. */
  readonly branch?: string;
  /** Exact worktree path holding that branch, when one does. */
  readonly worktreePath?: string;
  /** The collision safety verdict label (`unsafe:diverged`, `safe:orphan-ref`, …). */
  readonly verdict?: string;
  /** First {@link MAX_EVIDENCE_COMMITS} unpushed commit SHAs on the branch. */
  readonly commits?: readonly string[];
  /** Total unpushed commits (may exceed `commits.length`). */
  readonly commitCount?: number;
  /** Distinct files those commits touch. */
  readonly touchedFileCount?: number;
  /** Open PR numbers on the colliding branch (`adopt`). */
  readonly prNumbers?: readonly number[];
  /** The agent's last message, bounded and redacted (`agent_declined`). */
  readonly agentMessage?: string;
  /** Plan artifacts and their blob hashes at the declined commit. */
  readonly artifacts?: readonly DeclinedArtifact[];
  /** The commit the worker snapshot was taken from. */
  readonly baseCommit?: string;
}

/** A structured launch failure. */
export interface LaunchFailure {
  readonly class: LaunchFailureClass;
  readonly retry: LaunchRetryPolicy;
  /** Bounded reason code (the `march_hatchery_dispatches_total{reason}` value). */
  readonly reason: string;
  readonly evidence?: LaunchFailureEvidence;
}

export const MAX_EVIDENCE_COMMITS = 10;
export const MAX_AGENT_MESSAGE_CHARS = 2000;
const MAX_ARTIFACTS = 8;
const MAX_PATH_CHARS = 1024;
const MAX_PR_NUMBERS = 10;

const CLASS_SET: ReadonlySet<string> = new Set(LAUNCH_FAILURE_CLASSES);
const POLICY_SET: ReadonlySet<string> = new Set(LAUNCH_RETRY_POLICIES);

/** The default retry policy per class; `branch_collision` is refined by its verdict. */
export const DEFAULT_RETRY_POLICY: Readonly<Record<LaunchFailureClass, LaunchRetryPolicy>> = {
  castra_error: "auto",
  docker_error: "auto",
  timeout: "auto",
  worker_exit: "auto",
  tessera_unreachable: "auto",
  rate_limit: "auto",
  patch_apply_failed: "auto",
  patch_conflict: "auto",
  extraction_rejected: "auto",
  commit_failed: "auto",
  push_failed: "auto",
  pr_failed: "auto",
  persistence: "auto",
  missing_lifecycle: "auto",
  branch_collision: "auto",
  agent_declined: "until_input_changes",
  // Unchanged: the stack-wide spawn breaker throttles these and the operator
  // fixes the credential; per-slice the legate keeps its backoff.
  auth: "auto",
  other: "auto",
};

/** True for the policies under which the legate must NOT auto re-dispatch. */
export function isHeldPolicy(retry: LaunchRetryPolicy | undefined): boolean {
  return retry === "adopt" || retry === "operator" || retry === "until_input_changes";
}

/** Tessera codes that mean the credential itself is the problem (breaker class). */
const TESSERA_AUTH = new Set([
  "tessera:unconfigured", "tessera:unauthorized", "tessera:credential_invalid", "tessera:policy_denied",
  "tessera:repo_not_installed", "tessera:provider_unconfigured",
]);

/**
 * Map a bounded reason code (from `dispatchReasonCode`, an
 * `IntegrationFailureReason`, or an agent failure reason) to its class. Never
 * throws; an unknown code is `other`.
 */
export function classForReason(reason: string): LaunchFailureClass {
  if (CLASS_SET.has(reason)) return reason as LaunchFailureClass;
  if (TESSERA_AUTH.has(reason)) return "auth";
  if (reason.startsWith("tessera:")) return "tessera_unreachable";
  if (reason === "fetch_failed" || reason === "remote_check_failed" || reason === "branch_lookup_failed") {
    return "tessera_unreachable";
  }
  return "other";
}

/** A {@link LaunchFailure} with the class's default policy and no evidence. */
export function launchFailureFromReason(reason: string): LaunchFailure {
  const cls = classForReason(reason);
  return { class: cls, retry: DEFAULT_RETRY_POLICY[cls], reason };
}

/** The class an agent-level failure (`classifyAgentFailure`) maps to. */
export function classForAgentFailure(reason: "auth" | "rate_limit" | "timeout" | "other"): LaunchFailureClass {
  return reason === "other" ? "worker_exit" : reason;
}

// ── Agent message ───────────────────────────────────────────────────────────

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

/** Replace token-shaped substrings with `[redacted]`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

/** Redact, trim, and bound free text to {@link MAX_AGENT_MESSAGE_CHARS}. */
export function boundAgentMessage(text: string): string {
  const clean = redactSecrets(text).replace(/\r/g, "").trim();
  return clean.length > MAX_AGENT_MESSAGE_CHARS ? clean.slice(0, MAX_AGENT_MESSAGE_CHARS - 1) + "…" : clean;
}

/**
 * The agent's LAST message from a codex JSON-lines spawn log: the text of the
 * final `item.completed` `agent_message` (or a bare `agent_message` record), or a
 * `turn.failed` error message when the turn failed after it. Bounded and
 * redacted; undefined when the log has none.
 */
export function lastAgentMessage(logs: string): string | undefined {
  let last: string | undefined;
  for (const raw of logs.split("\n")) {
    const line = raw.trim().replace(/^>+\s*/, "").trim();
    if (!line.startsWith("{")) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const item = obj.type === "item.completed" ? obj.item : obj;
    if (item?.type === "agent_message" && typeof item.text === "string" && item.text.trim()) last = item.text;
    else if (obj.type === "turn.failed" && typeof obj.error?.message === "string" && obj.error.message.trim()) {
      last = obj.error.message;
    }
  }
  return last === undefined ? undefined : boundAgentMessage(last);
}

/** The worker scaffold's "real no-op" marker (`src/spawn/backends.ts`, exit 3). */
export const NO_COMMIT_MARKER = "worker produced no commit and the worktree is clean";

/** True when a spawn's exit + log mean the agent deliberately made no change. */
export function isAgentDeclined(exitCode: number, logs: string): boolean {
  return exitCode === 3 && logs.includes(NO_COMMIT_MARKER);
}

// ── Artifact blobs ──────────────────────────────────────────────────────────

/** Unique, non-empty repo-relative paths. */
function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((p) => typeof p === "string" && p.length > 0))];
}

/**
 * `git` arguments that list the blob id of each path at `rev` in ONE call.
 * `ls-tree` prints a line per path that exists and none for a missing one, so
 * an absent artifact never fails the whole read (unlike `rev-parse`).
 */
export function lsTreeArgs(rev: string, paths: readonly string[]): string[] {
  return ["ls-tree", "--full-tree", rev, "--", ...uniquePaths(paths)];
}

/** Parse {@link lsTreeArgs} output into one entry per path (`blob: null` = absent). */
export function parseLsTreeBlobs(stdout: string, paths: readonly string[]): DeclinedArtifact[] {
  const blobs = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const m = /^\d+ blob ([0-9a-f]{7,64})\t(.+)$/.exec(line);
    if (m) blobs.set(m[2], m[1]);
  }
  // ls-tree prints tree-entry names, so `./specs/x` is looked up as `specs/x`.
  return uniquePaths(paths).map((path) => ({ path, blob: blobs.get(path.replace(/^(\.\/)+/, "")) ?? null }));
}

// ── Wire validation ─────────────────────────────────────────────────────────

const SHA = /^[0-9a-f]{7,64}$/i;

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function count(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function parseEvidence(raw: unknown): LaunchFailureEvidence | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const branch = boundedString(r.branch, 256);
  if (branch) out.branch = branch;
  const worktreePath = boundedString(r.worktreePath, MAX_PATH_CHARS);
  if (worktreePath) out.worktreePath = worktreePath;
  const verdict = boundedString(r.verdict, 64);
  if (verdict) out.verdict = verdict;
  if (Array.isArray(r.commits)) {
    const commits = r.commits.filter((c): c is string => typeof c === "string" && SHA.test(c)).slice(0, MAX_EVIDENCE_COMMITS);
    if (commits.length) out.commits = commits;
  }
  const commitCount = count(r.commitCount);
  if (commitCount !== undefined) out.commitCount = commitCount;
  const touched = count(r.touchedFileCount);
  if (touched !== undefined) out.touchedFileCount = touched;
  if (Array.isArray(r.prNumbers)) {
    const prs = r.prNumbers.filter((n): n is number => Number.isInteger(n) && (n as number) > 0).slice(0, MAX_PR_NUMBERS);
    if (prs.length) out.prNumbers = prs;
  }
  if (typeof r.agentMessage === "string" && r.agentMessage.trim()) out.agentMessage = boundAgentMessage(r.agentMessage);
  if (Array.isArray(r.artifacts)) {
    const artifacts = r.artifacts
      .filter((a): a is { path: string; blob: unknown } =>
        !!a && typeof a === "object" && !!boundedString((a as any).path, MAX_PATH_CHARS))
      .slice(0, MAX_ARTIFACTS)
      .map((a) => ({ path: a.path, blob: typeof a.blob === "string" && SHA.test(a.blob) ? a.blob : null }));
    if (artifacts.length) out.artifacts = artifacts;
  }
  if (typeof r.baseCommit === "string" && SHA.test(r.baseCommit)) out.baseCommit = r.baseCommit;
  return Object.keys(out).length ? (out as LaunchFailureEvidence) : undefined;
}

/**
 * Validate an untrusted {@link LaunchFailure} (job record, `POST /events` body,
 * the fold). Returns a normalized, bounded copy, or undefined when the value is
 * not a launch failure. Unknown classes/policies are rejected (never invented as
 * new labels).
 */
export function parseLaunchFailure(raw: unknown): LaunchFailure | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.class !== "string" || !CLASS_SET.has(r.class)) return undefined;
  if (typeof r.retry !== "string" || !POLICY_SET.has(r.retry)) return undefined;
  const reason = boundedString(r.reason, 64) ?? r.class;
  const evidence = parseEvidence(r.evidence);
  return {
    class: r.class as LaunchFailureClass,
    retry: r.retry as LaunchRetryPolicy,
    reason,
    ...(evidence && { evidence }),
  };
}

/** Errors that carry a structured launch failure expose it on this property. */
export interface CarriesLaunchFailure {
  launchFailure?: LaunchFailure;
}

/** The structured failure an error carries, if any. */
export function launchFailureOf(err: unknown): LaunchFailure | undefined {
  const value = (err as CarriesLaunchFailure | null | undefined)?.launchFailure;
  return value ? parseLaunchFailure(value) : undefined;
}
