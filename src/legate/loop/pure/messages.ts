import { actionCommandLine } from "./dispatch-id.js";

/**
 * Pure builders for the prompts and escalation/detail strings the loop sends to
 * stewards and to the legate agent. No I/O, no `meta` — everything is derived
 * from the passed item/slice/pr/threads. Extracted so the wording is reviewable
 * and the decision helpers (e.g. threadsNeedingResponse) are unit-testable.
 */

export function buildSmithySpawnPrompt(item: any): string {
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

/** Pure decision helper: which unresolved review threads still need a response. */
export function threadsNeedingResponse(slice: any, pr: any): any[] {
  const openAt = slice.pr_open_at ? Date.parse(slice.pr_open_at) : NaN;
  return (pr.unresolved_threads || []).filter((thread: any) => {
    if (thread.needs_response) return true;
    if (slice.stage !== "pr-open" && slice.stage) return false;
    if (!Number.isFinite(openAt)) return true;
    const last = Date.parse(thread.last_comment_at || "");
    return Number.isFinite(last) && last > openAt;
  });
}

export function failedChecksSummary(pr: any): string {
  const failed = pr.failed_checks || [];
  if (failed.length === 0) return "No failed-check details were available.";
  return failed.map((check: any) => `- ${check.name}${check.url ? ": " + check.url : ""}`).join("\n");
}

export function prDiscoverySince(slice: any): string {
  return slice.last_action || slice.created_at || slice.dispatched_at || slice.started_at || "";
}

export function reviewThreadsSummary(threads: any[]): string {
  return threads
    .map(
      (thread: any) =>
        `- ${thread.path || "unknown path"}${thread.line ? ":" + thread.line : ""} by ${
          thread.last_author || thread.author || "unknown"
        }: ${thread.body_preview || ""}`,
    )
    .join("\n");
}

export function conflictMessage(slice: any, pr: any, state: any): string {
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

export function reviewFixMessage(pr: any, threads: any[]): string {
  return `/smithy.fix

Unresolved review threads on PR #${pr.number} need a response. Please address them in the same PR branch and push the fix.

Threads:
${reviewThreadsSummary(threads)}`;
}

export function loginRequiredDetail(input: {
  sliceId: string;
  slice: any;
  sessionId: string;
  recent: { output?: string; error?: string };
}): string {
  const { sliceId, slice, sessionId, recent } = input;
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

export function loginResumeMessage(sliceId: string, slice: any): string {
  const pr = slice.pr || {};
  return `Claude authentication has been refreshed. Resume your previous task from the current repository state.

Current slice: ${sliceId}
Current stage: ${slice.stage || "unknown"}
PR: ${pr.url || (pr.number ? "#" + pr.number : "none")}

Re-check the PR, CI, review threads, and working tree before taking action. Continue with the last assigned fix/rebase/conflict-resolution task. If the previous instruction is no longer applicable, summarize the current blocker.`;
}

export function workerErrorDetail(input: {
  sliceId: string;
  slice: any;
  worker: any;
  sessionId: string;
  recent: { output?: string; error?: string };
}): string {
  const { sliceId, slice, worker, sessionId, recent } = input;
  const pr = slice.pr || {};
  return [
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
  ].join("\n");
}
