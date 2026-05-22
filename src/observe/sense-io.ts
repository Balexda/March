import { execFile } from "node:child_process";
import { CastraClient } from "../castra/client.js";
import type { LoopMeta } from "../legate/loop/meta.js";
import type { SenseDeps } from "../legate/loop/state/sense.js";

/**
 * Shared system-observation I/O — the impure reads that turn the live world
 * (gh PR/CI/review state, smithy readiness, git default-branch sync, Castra
 * sessions + output) into the values the legate and Herald fold into a snapshot.
 *
 * This was lifted verbatim from the legate loop's `runtime.ts` (the
 * `@ts-nocheck` mechanical lift) so there is ONE tested implementation of the
 * subtle bits — review-thread GraphQL, branch-variant PR matching, the
 * `--pending` smithy query — shared by the legate loop (Stage 1 sense, plus its
 * dispatch/recovery paths) and the Herald observation service. Behavior is
 * unchanged from the lifted original; only the module-global `meta`/`castra`/
 * `execText` dependencies are now injected via {@link SenseIoContext}.
 */

export interface SenseIoContext {
  /** Loaded loop meta (repo path, profile, worker group, …). */
  readonly meta: LoopMeta;
  readonly env?: NodeJS.ProcessEnv;
  /** Castra client; defaults to one built from `env`. */
  readonly castra?: CastraClient;
  /** Timestamp source; defaults to ISO `now`. */
  readonly now?: () => string;
  /** Non-fatal warning sink (sync/sense warnings); defaults to a no-op. */
  readonly warn?: (message: string) => void;
}

/** Result of a default-branch sync. */
export interface SyncResult {
  default_branch: string;
  synced: true;
  head: string;
}

/**
 * The shared observation I/O bundle. The legate loop uses {@link toSenseDeps}
 * for Stage 1 and calls {@link listSessions} / {@link queryPrForBabysit} /
 * {@link prMatchesSliceBranch} / {@link syncDefaultBranch} directly from its
 * dispatch/recovery paths; Herald uses {@link toSenseDeps} to feed `senseObserved`.
 */
export interface SenseIo {
  listSessions(): Promise<any[] | { error: string }>;
  syncDefaultBranch(state: any): Promise<SyncResult>;
  readSmithyStatus(repoPath: string): Promise<any>;
  queryPrForBabysit(slice: any, state: any): Promise<any>;
  discoverPrForSlice(slice: any, state: any, sessionId: string): Promise<any>;
  prMatchesSliceBranch(slice: any, pr: any): Promise<boolean>;
  captureRecentSessionOutput(sessionId: string): Promise<{ output: string; error?: string }>;
  /** Adapt to the injected {@link SenseDeps} contract the sense entry points consume. */
  toSenseDeps(): SenseDeps;
}

// Async command runner (mirrors the loop's former execFileSync seam): rejects on
// non-zero exit with execFileSync-shaped errors (message folds in stderr, plus
// .stdout/.stderr) so the recovery parsers that read failure text still work.
function execText(
  command: string,
  args: string[],
  options: Record<string, unknown> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024, ...options },
      (err: any, stdout: string, stderr: string) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          if (stderr && !String(err.message).includes(stderr)) {
            err.message = err.message + "\n" + stderr;
          }
          reject(err);
          return;
        }
        resolve(typeof stdout === "string" ? stdout : "");
      },
    );
  });
}

// Map a Castra session to the agent-deck-shaped object the loop consumes
// (id/status/group/worktree_path/…).
function toLoopSession(s: any) {
  return {
    id: s.sessionId,
    title: s.title,
    name: s.title,
    group: s.group,
    status: s.status || "other",
    branch: s.branch,
    worktree_path: s.worktreePath,
    created_at: s.createdAt,
    // Carry Castra's self-described metadata (#214) so Herald's observer can
    // reconcile a session to its slice by exact sliceId (`senseObserved`).
    metadata: s.metadata,
  };
}

function prNumber(slice: any): string | null {
  const n = slice?.pr?.number;
  if (typeof n === "number" && Number.isInteger(n) && n > 0) return String(n);
  if (typeof n === "string" && /^[0-9]+$/.test(n)) return n;
  return null;
}

function checksSummary(statusCheckRollup: any): string {
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

function failedChecks(statusCheckRollup: any) {
  const checks = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  return checks
    .filter((check) => ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes(check.conclusion))
    .map((check) => ({
      name: check.name || check.context || "unknown",
      url: check.detailsUrl || check.targetUrl || null,
    }));
}

function truncateText(text: any, max = 4000): string {
  const value = String(text || "");
  if (value.length <= max) return value;
  return value.slice(value.length - max);
}

function prDiscoverySince(slice: any): string {
  return slice.last_action || slice.created_at || slice.dispatched_at || slice.started_at || "";
}

function addBranchVariants(branches: Set<string>, value: any): void {
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

/** Build the shared observation I/O bundle bound to a context. */
export function createSenseIo(ctx: SenseIoContext): SenseIo {
  const meta = ctx.meta;
  const env = ctx.env ?? process.env;
  const now = ctx.now ?? (() => new Date().toISOString());
  const warn = ctx.warn;
  let castraClient = ctx.castra;
  const castra = (): CastraClient => (castraClient ??= new CastraClient({ env }));

  async function listSessions(): Promise<any[] | { error: string }> {
    // Sessions come from Castra (the agent-deck interdiction service), mapped
    // back to agent-deck-shaped objects. On error we return {error} so
    // summarizeWorkers reports "unavailable" exactly as for an agent-deck CLI
    // failure.
    try {
      return (await castra().listSessions(meta.profile)).map(toLoopSession);
    } catch (err: any) {
      return { error: err?.message || String(err) };
    }
  }

  async function repoOwner(state: any): Promise<string | null> {
    const owner = state?.repo?.owner_with_name;
    if (typeof owner === "string" && owner.length > 0) return owner;
    const repoPath = state?.repo?.path || meta.repo?.path;
    if (typeof repoPath !== "string" || repoPath.length === 0) return null;
    try {
      const out = await execText("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
        cwd: repoPath,
      });
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  async function ghPrArgs(slice: any, state: any, fields: string): Promise<any> {
    const number = prNumber(slice);
    if (!number) return { skipped: true, reason: "missing_pr_number" };
    const args = ["pr", "view", number, "--json", fields];
    const owner = await repoOwner(state);
    if (typeof owner === "string" && owner.length > 0) {
      args.push("-R", owner);
    }
    const options: Record<string, unknown> = {};
    const repoPath = state?.repo?.path || meta.repo?.path;
    if (!owner && typeof repoPath === "string" && repoPath.length > 0) {
      options.cwd = repoPath;
    }
    return { args, options, owner, number };
  }

  async function queryReviewThreads(owner: string | null, prNumberValue: any): Promise<any[]> {
    if (!owner) return [];
    const [repoOwnerName, repoName] = owner.split("/");
    if (!repoOwnerName || !repoName) return [];
    const out = await execText("gh", [
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
      .filter((thread: any) => thread && thread.isResolved === false)
      .map((thread: any) => {
        const comments = Array.isArray(thread.comments?.nodes)
          ? [...thread.comments.nodes].sort((a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)))
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
          // Every comment's databaseId, so the legate can dedup /smithy.fix by
          // comment id rather than last_comment_at (#224). A reply does carry a
          // new, previously-unseen id; the dedup comes from the legate
          // persisting the ids it has already dispatched for across ticks, so a
          // thread's churning last_comment_at no longer re-arms the dispatch.
          comment_ids: comments.map((comment: any) => comment.databaseId).filter((id: any) => id != null),
        };
      });
  }

  async function queryPrForBabysit(slice: any, state: any): Promise<any> {
    const request = await ghPrArgs(
      slice,
      state,
      "number,url,state,mergeable,reviewDecision,statusCheckRollup,headRefName,title,author",
    );
    if (request.skipped) return request;
    const summary = JSON.parse(await execText("gh", request.args, request.options));
    const threads = await queryReviewThreads(request.owner || (await repoOwner(state)), summary.number);
    const prAuthor = summary.author?.login || "";
    const annotated = threads.map((thread: any) => ({
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
      needs_response_count: annotated.filter((thread: any) => thread.needs_response).length,
    };
  }

  async function captureRecentSessionOutput(sessionId: string): Promise<{ output: string; error?: string }> {
    try {
      const output = await castra().sessionOutput(meta.profile, sessionId);
      return { output: truncateText(output.trim()) };
    } catch (err: any) {
      return { output: "", error: err?.message || String(err) };
    }
  }

  async function expectedPrBranches(slice: any): Promise<Set<string>> {
    const branches = new Set<string>();
    addBranchVariants(branches, slice.actual_branch);
    addBranchVariants(branches, slice.branch);
    if (slice.worktree_path) {
      try {
        addBranchVariants(branches, await execText("git", ["-C", slice.worktree_path, "branch", "--show-current"]));
      } catch {
        // Best-effort guard only; branch fields still protect PR discovery.
      }
    }
    return branches;
  }

  async function prMatchesSliceBranch(slice: any, pr: any): Promise<boolean> {
    const branches = await expectedPrBranches(slice);
    if (branches.size === 0) return false;
    return branches.has(String(pr?.head_branch || pr?.headRefName || ""));
  }

  async function discoverPrForSlice(slice: any, state: any, sessionId: string): Promise<any> {
    const repoPath = state?.repo?.path || meta.repo?.path;
    if (!repoPath) return null;
    try {
      const output = await castra().sessionOutput(meta.profile, sessionId);
      const matches = output.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/([0-9]+)/g) || [];
      if (matches.length > 0) {
        const url = matches[matches.length - 1];
        const number = url.split("/").pop();
        const pr = await queryPrForBabysit({ pr: { number } }, state);
        return pr?.skipped || !(await prMatchesSliceBranch(slice, pr)) ? null : pr;
      }
    } catch {
      // fall through to branch-based lookup
    }
    try {
      const owner = await repoOwner(state);
      const args = ["pr", "list", "--author", "@me", "--state", "open", "--json", "number,url,state,mergeable,headRefName,title,statusCheckRollup,createdAt"];
      if (owner) args.push("-R", owner);
      const options = owner ? {} : { cwd: repoPath };
      const list = JSON.parse(await execText("gh", args, options));
      if (!Array.isArray(list) || list.length === 0) return null;
      const since = prDiscoverySince(slice);
      const candidates = since
        ? list.filter((candidate: any) => String(candidate.createdAt || "") >= since)
        : list;
      // prMatchesSliceBranch is async — await every predicate, then keep the
      // candidates whose resolved boolean is true. Filtering on the raw Promise
      // would pass every candidate (a Promise is always truthy) and could adopt
      // a PR on the wrong branch.
      const matchFlags = await Promise.all(
        candidates.map((candidate: any) => prMatchesSliceBranch(slice, candidate)),
      );
      const branchMatches = candidates.filter((_candidate: any, i: number) => matchFlags[i]);
      const chosen = branchMatches
        .sort((a: any, b: any) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
      if (!chosen) return null;
      return await queryPrForBabysit({ pr: { number: chosen.number } }, state);
    } catch {
      return null;
    }
  }

  async function readSmithyStatus(repoPath: string): Promise<any> {
    // --pending = shorthand for --status in-progress,not-started. Filters out
    // all done records up-front. Layer 0 of the returned graph still means
    // "ready to dispatch right now".
    const out = await execText("smithy", ["status", "--format", "json", "--pending"], { cwd: repoPath });
    return JSON.parse(out);
  }

  async function syncDefaultBranch(state: any): Promise<SyncResult> {
    const repoPath = state?.repo?.path || meta.repo?.path;
    if (typeof repoPath !== "string" || repoPath.length === 0) {
      throw new Error("repo path is missing");
    }
    let defaultBranch = state?.repo?.default_branch;
    if (!defaultBranch) {
      try {
        defaultBranch = (await execText("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repoPath }))
          .trim()
          .replace(/^origin\//, "");
      } catch {
        defaultBranch = (await execText("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], { cwd: repoPath })).trim();
      }
    }
    if (!defaultBranch) throw new Error("could not determine default branch");
    await execText("git", ["fetch", "origin", defaultBranch], { cwd: repoPath });
    await execText("git", ["switch", defaultBranch], { cwd: repoPath });
    await execText("git", ["pull", "--ff-only", "origin", defaultBranch], { cwd: repoPath });
    if (state?.repo && !state.repo.default_branch) state.repo.default_branch = defaultBranch;
    return {
      default_branch: defaultBranch,
      synced: true,
      head: (await execText("git", ["rev-parse", "HEAD"], { cwd: repoPath })).trim(),
    };
  }

  function toSenseDeps(): SenseDeps {
    return {
      meta,
      now,
      listSessions: () => listSessions(),
      syncDefaultBranch: async (repoPath: string, knownDefault?: string) => {
        await syncDefaultBranch({ repo: { path: repoPath, default_branch: knownDefault } });
      },
      readSmithyStatus: (repoPath: string) => readSmithyStatus(repoPath),
      queryPr: (slice: any, state: any) => queryPrForBabysit(slice, state),
      discoverPr: (slice: any, state: any, _repoPath: string | undefined, sessionId: string) =>
        discoverPrForSlice(slice, state, sessionId),
      sessionOutput: (sessionId: string) => captureRecentSessionOutput(sessionId),
      ...(warn ? { warn } : {}),
    };
  }

  return {
    listSessions,
    syncDefaultBranch,
    readSmithyStatus,
    queryPrForBabysit,
    discoverPrForSlice,
    prMatchesSliceBranch,
    captureRecentSessionOutput,
    toSenseDeps,
  };
}

/** Convenience: the {@link SenseDeps} for the sense entry points, bound to a context. */
export function buildSenseIo(ctx: SenseIoContext): SenseDeps {
  return createSenseIo(ctx).toSenseDeps();
}
