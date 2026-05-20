import fs from "node:fs";
import path from "node:path";
import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { isWorkerSession } from "../pure/session.js";
import { execText } from "../clients/exec.js";

/**
 * Steward relaunch: a non-terminal slice that still has an open PR but whose
 * worker session has vanished (crashed/removed) gets a fresh opus steward
 * re-attached to its EXISTING worktree/branch (createBranch:false), so future
 * babysit messages have somewhere to land. assess() is pure; apply() recreates
 * the worktree if needed, launches via Castra, sends a resume-context prompt,
 * and rewrites the slice's worker pointer. Throttled to {@link RELAUNCH_LIMIT}
 * attempts per slice via state.json's transient_retry_counts.
 */

const ELIGIBLE_STAGES = new Set([
  "implementing",
  "pr-open",
  "pr-in-fix",
  "pr-resolving-conflicts",
  "pr-rebasing",
  "pr-in-rerun",
]);
const RELAUNCH_LIMIT = 3;

export interface RelaunchDecision {
  readonly sliceId: string;
  readonly bareBranch: string;
  readonly featureBranch: string;
  readonly expectedDirName: string;
  readonly worktreePath: string;
  readonly launchTitle: string;
  readonly prNumber: number;
  readonly prUrl: string;
  /** This attempt's 1-based count (== persisted counter after apply). */
  readonly attempt: number;
  readonly limit: number;
}

/** Side-effect seams for apply — injectable so the git/fs writes are testable. */
export interface RelaunchDeps {
  worktreeExists: (p: string) => boolean;
  ensureWorktree: (worktreePath: string, featureBranch: string, repoPath: string) => void;
}

const defaultRelaunchDeps: RelaunchDeps = {
  worktreeExists: (p) => fs.existsSync(p),
  ensureWorktree: (worktreePath, featureBranch, repoPath) => {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    execText("git", ["worktree", "add", worktreePath, featureBranch], { cwd: repoPath });
  },
};

function errMsg(err: any): string {
  return (err?.message || String(err)).slice(0, 200);
}

/** Pure read of the throttle counters (assess never mutates them). */
function readRetryCounts(raw: any): Record<string, number> {
  const c = raw?.transient_retry_counts;
  return c && typeof c === "object" ? c : {};
}

/** apply-side: ensure the counter object exists so we can write into it. */
function ensureRetryCounts(raw: any): Record<string, number> {
  if (!raw.transient_retry_counts || typeof raw.transient_retry_counts !== "object") {
    raw.transient_retry_counts = {};
  }
  return raw.transient_retry_counts;
}

function stewardResumeMessage(d: RelaunchDecision): string {
  return [
    "[STEWARD RESUME] You are the re-launched March Hatchery management session for PR #" + d.prNumber + ".",
    "Branch: " + d.featureBranch,
    "PR: " + d.prUrl,
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
}

/** Pure: which slices have lost their steward and are within the retry budget. */
export function assess(state: LoopState): RelaunchDecision[] {
  const out: RelaunchDecision[] = [];
  const repoPath = state.repoPath;
  if (typeof repoPath !== "string" || repoPath.length === 0) return out;

  const liveSessionIds = new Set<string>();
  for (const s of state.sessions) {
    if (isWorkerSession(s, state.workerGroup) && typeof s?.id === "string") liveSessionIds.add(s.id);
  }
  const counts = readRetryCounts(state.raw);
  const worktreesParent = path.join(path.dirname(repoPath), "WorkTrees", path.basename(repoPath));

  for (const [sliceId, slice] of Object.entries(state.slices) as [string, any][]) {
    if (!slice || typeof slice !== "object") continue;
    if (!ELIGIBLE_STAGES.has(slice.stage)) continue;
    const pr = slice.pr || {};
    if (!pr.number) continue;
    const sessId = slice.worker_session_id;
    if (typeof sessId === "string" && sessId.length > 0 && liveSessionIds.has(sessId)) continue;
    const rawBranch = typeof slice.branch === "string" ? slice.branch : "";
    if (rawBranch.length === 0) continue;
    const bareBranch = rawBranch.replace(/^feature\//, "");
    const featureBranch = "feature/" + bareBranch;
    const expectedDirName = "feature-" + bareBranch.replace(/\//g, "-");
    const key = "relaunch-steward:" + sliceId;
    const prev = Number.isFinite(counts[key]) ? counts[key] : 0;
    const attempt = prev + 1;
    if (attempt > RELAUNCH_LIMIT) continue;
    out.push({
      sliceId,
      bareBranch,
      featureBranch,
      expectedDirName,
      worktreePath: slice.worktree_path || path.join(worktreesParent, expectedDirName),
      launchTitle: slice.worker_title || "steward: " + sliceId,
      prNumber: pr.number,
      prUrl: pr.url || "(unknown)",
      attempt,
      limit: RELAUNCH_LIMIT,
    });
  }
  return out;
}

export function apply(
  decisions: RelaunchDecision[],
  ctx: HandlerContext,
  state: LoopState,
  deps: RelaunchDeps = defaultRelaunchDeps,
): HandlerResult {
  const res = emptyHandlerResult();
  if (decisions.length === 0) return res;
  const counts = ensureRetryCounts(state.raw);

  for (const d of decisions) {
    if (!deps.worktreeExists(d.worktreePath)) {
      try {
        deps.ensureWorktree(d.worktreePath, d.featureBranch, state.repoPath as string);
      } catch (err) {
        res.actions.push({
          action: "relaunch-failed",
          sliceId: d.sliceId,
          sessionId: null,
          detail: "could not recreate worktree at " + d.worktreePath + " from branch " + d.featureBranch + ": " + errMsg(err),
        });
        continue;
      }
    }

    let newSessionId: string | null = null;
    try {
      const relaunched = ctx.castra.launchSession({
        profile: ctx.meta.profile,
        repoPath: state.repoPath as string,
        branch: d.bareBranch,
        title: d.launchTitle,
        group: ctx.meta.worker_group,
        model: "opus",
        createBranch: false,
        traceKey: d.sliceId,
      } as any);
      newSessionId = relaunched.sessionId;
    } catch (err) {
      res.actions.push({ action: "relaunch-failed", sliceId: d.sliceId, sessionId: null, detail: "castra launch failed: " + errMsg(err) });
      continue;
    }
    if (!newSessionId) {
      res.actions.push({ action: "relaunch-failed", sliceId: d.sliceId, sessionId: null, detail: "castra launch returned no identifiable new session" });
      continue;
    }

    try {
      ctx.castra.sendPrompt({ profile: ctx.meta.profile, sessionId: newSessionId, prompt: stewardResumeMessage(d), traceKey: d.sliceId } as any);
    } catch {
      // Best-effort: session is alive; future babysit messages will still reach it.
    }

    const slice = state.slices[d.sliceId];
    slice.worker_session_id = newSessionId;
    slice.worker_title = d.launchTitle;
    slice.worktree_path = d.worktreePath;
    slice.last_action = ctx.ts;
    slice.last_action_note = "Re-launched steward for PR #" + d.prNumber + " (attempt " + d.attempt + "/" + d.limit + "); new session " + newSessionId;
    counts["relaunch-steward:" + d.sliceId] = d.attempt;
    res.mutated = true;
    res.actions.push({
      action: "relaunch-steward",
      sliceId: d.sliceId,
      sessionId: newSessionId,
      detail: "re-attached opus steward to PR #" + d.prNumber + " on " + d.featureBranch + " (attempt " + d.attempt + "/" + d.limit + ")",
    });
  }

  if (res.mutated) ctx.persist(state);
  return res;
}
