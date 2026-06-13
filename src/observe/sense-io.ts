import { execFile } from "node:child_process";
import { CastraClient } from "../castra/client.js";
import type { LoopMeta } from "../legate/loop/meta.js";
import type { OpenPrIndex, SenseDeps, StaleRecheckTracker } from "../legate/loop/state/sense.js";
import { createStaleRecheckTracker } from "../legate/loop/state/sense.js";
import { readSmithyStatus } from "./smithy-status.js";

/**
 * Per-profile {@link StaleRecheckTracker}s for the rotating forced-recheck sweep.
 * Module-scoped (not closure-scoped) because Herald rebuilds the SenseIo bundle
 * every tick (`buildObserveDeps`), so a per-bundle tracker would reset each tick
 * and the rotation cooldown would never hold. Keyed by profile; a Herald restart
 * resets all of them, which only re-warms the 10-minute clocks.
 */
const staleRecheckByProfile = new Map<string, StaleRecheckTracker>();
function staleRecheckForProfile(profile: string): StaleRecheckTracker {
  let tracker = staleRecheckByProfile.get(profile);
  if (!tracker) {
    tracker = createStaleRecheckTracker();
    staleRecheckByProfile.set(profile, tracker);
  }
  return tracker;
}

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
 * Per-invocation `git -c …` config that rewrites GitHub SSH remotes to
 * token-authenticated HTTPS, so a container with no ssh client / key / agent can
 * still fetch over the network (#300/#301 live-validation: the `march-herald`
 * image has no openssh, and `$HOME/.ssh` carried only a `config`, so
 * `git fetch origin` died with "cannot run ssh"). The token is the same
 * `GH_TOKEN` / `GITHUB_TOKEN` the rest of the stack uses for GitHub — passed
 * PER COMMAND (never written to the repo's config / disk), so it isn't
 * persisted. Returns `[]` when no token is set, in which case git uses the
 * remote as-is (unchanged behaviour — host-credential / SSH paths still work).
 *
 * Both the scp-short (`git@github.com:`) and `ssh://` remote forms are rewritten
 * to the SAME authenticated HTTPS base; git accumulates the repeated multi-valued
 * `insteadOf` entries (verified) so both rules apply.
 */
export function gitHubAuthConfigArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const token = (env.GH_TOKEN || env.GITHUB_TOKEN || "").trim();
  if (!token) return [];
  const https = `https://x-access-token:${token}@github.com/`;
  return [
    "-c",
    `url.${https}.insteadOf=git@github.com:`,
    "-c",
    `url.${https}.insteadOf=ssh://git@github.com/`,
  ];
}

/**
 * The shared observation I/O bundle. The legate loop uses {@link toSenseDeps}
 * for Stage 1 and calls {@link listSessions} / {@link queryPrForBabysit} /
 * {@link prMatchesSliceBranch} directly from its dispatch/recovery paths. Herald
 * uses {@link toSenseDeps} to feed `senseObserved` AND calls {@link
 * syncDefaultBranch} from its observe path — Herald owns the default-branch git
 * sync (`MARCH_HERALD_SYNC`, #300), so the sync is no longer part of SenseDeps.
 */
export interface SenseIo {
  listSessions(): Promise<any[] | { error: string }>;
  syncDefaultBranch(state: any): Promise<SyncResult>;
  readSmithyStatus(repoPath: string): Promise<any>;
  queryPrForBabysit(slice: any, state: any): Promise<any>;
  discoverPrForSlice(slice: any, state: any, sessionId: string): Promise<any>;
  prMatchesSliceBranch(slice: any, pr: any): Promise<boolean>;
  captureRecentSessionOutput(sessionId: string): Promise<{ output: string; error?: string }>;
  /** The cheap open-PR change-cursor probe (one GraphQL call). */
  listOpenPrs(state: any): Promise<OpenPrIndex | { error: string }>;
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

/**
 * Reduce a PR's `reviews` nodes to human (non-bot) approval / changes-requested
 * counts — the data the legate's merge gate needs. Mirrors the jq the (retired)
 * `check-merge-readiness.sh` ran:
 *  - a review is a bot's when `author.__typename === "Bot"` or its login ends in
 *    `[bot]` (covers GitHub Apps that present as Users, e.g. Copilot);
 *  - per human, only the latest non-COMMENTED/PENDING/DISMISSED review counts, so
 *    a stale CHANGES_REQUESTED later superseded by an APPROVED doesn't block.
 * Pure (no I/O) so it can be unit-tested without `gh`.
 */
export function summarizeReviews(
  reviewNodes: any,
): { human_approval_count: number; changes_requested_count: number } {
  const nodes = Array.isArray(reviewNodes) ? reviewNodes : [];
  const isBot = (node: any): boolean =>
    node?.author?.__typename === "Bot" || String(node?.author?.login || "").endsWith("[bot]");
  const meaningful = nodes
    .filter((node) => !isBot(node))
    .filter((node) => !["COMMENTED", "PENDING", "DISMISSED"].includes(String(node?.state)));
  // Latest meaningful review per human login (by submittedAt).
  const latestByLogin = new Map<string, any>();
  for (const node of [...meaningful].sort((a, b) =>
    String(a?.submittedAt).localeCompare(String(b?.submittedAt)),
  )) {
    latestByLogin.set(String(node?.author?.login || ""), node);
  }
  let approvals = 0;
  let changesRequested = 0;
  for (const node of latestByLogin.values()) {
    if (node?.state === "APPROVED") approvals++;
    else if (node?.state === "CHANGES_REQUESTED") changesRequested++;
  }
  return { human_approval_count: approvals, changes_requested_count: changesRequested };
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
  // The repo's `owner/name` never changes for a checkout, and this bundle is built
  // fresh per profile per tick — so resolving it once and reusing it collapses the
  // former one-`gh repo view`-per-slice fan-out into a single call per tick.
  // `undefined` = not yet resolved; `null` = resolution failed (cached for the tick
  // so a gh outage isn't retried per slice).
  let ownerCache: string | null | undefined;

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
    if (ownerCache !== undefined) return ownerCache;
    const repoPath = state?.repo?.path || meta.repo?.path;
    // Don't cache a "no path" miss — it's a caller/config gap, not a resolved fact.
    if (typeof repoPath !== "string" || repoPath.length === 0) return null;
    try {
      const out = await execText("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
        cwd: repoPath,
      });
      ownerCache = out.trim() || null;
    } catch {
      ownerCache = null;
    }
    return ownerCache;
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

  async function queryReviewThreads(
    owner: string | null,
    prNumberValue: any,
  ): Promise<{ threads: any[]; reviews: any[]; comments: any[]; headRefOid: string | null; mergeStateStatus: string | null }> {
    const empty = { threads: [], reviews: [], comments: [], headRefOid: null, mergeStateStatus: null };
    if (!owner) return empty;
    const [repoOwnerName, repoName] = owner.split("/");
    if (!repoOwnerName || !repoName) return empty;
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
      // One graphql call also fetches headRefOid (to pin --match-head-commit on the
      // merge), mergeStateStatus (not exposed by `gh pr view --json`), and the
      // reviews array with author type (for human approval / changes-requested
      // counting) — all the data the legate's merge gate needs.
      `query=query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      headRefOid
      mergeStateStatus
      reviews(first: 100) {
        nodes {
          state
          submittedAt
          author { login __typename }
        }
      }
      comments(first: 50) {
        nodes {
          databaseId
          body
          createdAt
          author { login __typename }
          reactionGroups { content viewerHasReacted }
        }
      }
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
    const pr = parsed?.data?.repository?.pullRequest || {};
    const nodes = pr?.reviewThreads?.nodes || [];
    const threads = nodes
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
    // Conversation comments: PR-level (issue) comments NOT tied to a code line and
    // NOT part of a review thread — the "non-thread" feedback the thread/review
    // signals miss entirely. `reacted_eyes` reads `viewerHasReacted` for the EYES
    // reaction from the legate token's perspective: the legate posts :eyes: when it
    // dispatches a comment-fix, so this is the human-visible, fold-independent half
    // of the dedup (the persisted comment-id set is the authoritative half — the
    // legate token shares the PR-author identity, so neither author nor reaction
    // alone is decisive).
    const commentNodes = Array.isArray(pr?.comments?.nodes) ? pr.comments.nodes : [];
    const comments = commentNodes
      .filter((c: any) => c && c.databaseId != null)
      .map((c: any) => ({
        id: c.databaseId,
        author: c.author?.login,
        author_type: c.author?.__typename,
        body_preview: String(c.body || "").slice(0, 280),
        created_at: c.createdAt,
        reacted_eyes: (Array.isArray(c.reactionGroups) ? c.reactionGroups : []).some(
          (g: any) => g?.content === "EYES" && g?.viewerHasReacted === true,
        ),
      }));
    return {
      threads,
      reviews: pr?.reviews?.nodes || [],
      comments,
      headRefOid: pr?.headRefOid || null,
      mergeStateStatus: pr?.mergeStateStatus || null,
    };
  }

  async function queryPrForBabysit(slice: any, state: any): Promise<any> {
    const request = await ghPrArgs(
      slice,
      state,
      "number,url,state,mergeable,reviewDecision,statusCheckRollup,headRefName,title,author,updatedAt",
    );
    if (request.skipped) return request;
    const summary = JSON.parse(await execText("gh", request.args, request.options));
    const graphql = await queryReviewThreads(request.owner || (await repoOwner(state)), summary.number);
    const prAuthor = summary.author?.login || "";
    const annotated = graphql.threads.map((thread: any) => ({
      ...thread,
      needs_response: thread.last_author !== prAuthor,
    }));
    const reviewSummary = summarizeReviews(graphql.reviews);
    return {
      number: summary.number,
      url: summary.url,
      state: summary.state,
      mergeable: summary.mergeable,
      // The change cursor: senseObserved stores this and compares it against the
      // next tick's cheap open-PR probe to skip an unchanged PR's detail fetch.
      updated_at: summary.updatedAt,
      head_branch: summary.headRefName,
      head_sha: graphql.headRefOid,
      merge_state_status: graphql.mergeStateStatus ? String(graphql.mergeStateStatus).toLowerCase() : null,
      title: summary.title,
      review_decision: summary.reviewDecision,
      checks: checksSummary(summary.statusCheckRollup),
      failed_checks: failedChecks(summary.statusCheckRollup),
      unresolved_threads: annotated,
      thread_count: annotated.length,
      needs_response_count: annotated.filter((thread: any) => thread.needs_response).length,
      // Non-thread (conversation) comments — the legate dispatches /smithy.fix for
      // any not yet acknowledged (:eyes:) / dispatched-for. See babysit.
      conversation_comments: graphql.comments,
      human_approval_count: reviewSummary.human_approval_count,
      changes_requested_count: reviewSummary.changes_requested_count,
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
      // #173: an escalated slice's last_action is the escalation timestamp, not a
      // fresh dispatch, so the recency floor would wrongly exclude an open PR
      // opened during an EARLIER dispatch — the exact branch-collision adopt case
      // Herald must observe so the legate can adopt from the fold. Skip the floor
      // for escalated slices; the branch-variant match below is then the sole gate.
      // The floor still scopes the implementing/babysit discovery path.
      const since = slice?.stage === "escalated" ? null : prDiscoverySince(slice);
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

  /**
   * The change-cursor probe: ONE GraphQL call listing the repo's open PRs with
   * just `number` + `updatedAt` (+ `headRefName`). `senseObserved` reads it once
   * per tick and skips the expensive per-PR detail fetch for any tracked PR whose
   * `updatedAt` hasn't advanced — collapsing the per-open-PR-per-tick `gh pr view`
   * + review-thread GraphQL fan-out that exhausts the GraphQL budget.
   *
   * Cost is ~1 point: a single connection (`pullRequests(first: 100)`). Capped at
   * 100 (ordered most-recently-updated first); a repo with >100 open PRs just
   * leaves the overflow ungated — they fall through to a by-number detail fetch,
   * the same as today, so correctness holds, only the savings taper.
   *
   * Returns `{error}` (never throws) when the owner can't be resolved or the query
   * fails, so the caller degrades to the always-fetch path instead of stranding.
   */
  async function listOpenPrs(state: any): Promise<OpenPrIndex | { error: string }> {
    const owner = await repoOwner(state);
    if (!owner) return { error: "repo owner unavailable" };
    const [repoOwnerName, repoName] = owner.split("/");
    if (!repoOwnerName || !repoName) return { error: `unparseable repo owner: ${owner}` };
    try {
      const out = await execText("gh", [
        "api",
        "graphql",
        "-F",
        `owner=${repoOwnerName}`,
        "-F",
        `name=${repoName}`,
        "-f",
        `query=query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number updatedAt headRefName }
    }
  }
}`,
      ]);
      const nodes = JSON.parse(out)?.data?.repository?.pullRequests?.nodes;
      const index: OpenPrIndex = new Map();
      if (Array.isArray(nodes)) {
        for (const node of nodes) {
          if (typeof node?.number === "number") {
            index.set(node.number, { updatedAt: node.updatedAt, headRefName: node.headRefName });
          }
        }
      }
      return index;
    } catch (err: any) {
      return { error: err?.message || String(err) };
    }
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
    // Network ops (fetch/pull) get the SSH→HTTPS-token rewrite so they work in a
    // container with no ssh client/key; `switch` is local and needs no auth.
    const auth = gitHubAuthConfigArgs(env);
    await execText("git", [...auth, "fetch", "origin", defaultBranch], { cwd: repoPath });
    await execText("git", ["switch", defaultBranch], { cwd: repoPath });
    await execText("git", [...auth, "pull", "--ff-only", "origin", defaultBranch], { cwd: repoPath });
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
      // The default-branch git sync is NOT part of the injected SenseDeps anymore
      // (#300): Herald owns it and calls the bundle's `syncDefaultBranch` directly
      // from its observe path; the legate never syncs.
      readSmithyStatus: (repoPath: string) => readSmithyStatus(repoPath),
      queryPr: (slice: any, state: any) => queryPrForBabysit(slice, state),
      discoverPr: (slice: any, state: any, _repoPath: string | undefined, sessionId: string) =>
        discoverPrForSlice(slice, state, sessionId),
      sessionOutput: (sessionId: string) => captureRecentSessionOutput(sessionId),
      listOpenPrs: (state: any) => listOpenPrs(state),
      // Per-profile staleness sweep state (default-branch-movement conflict catch).
      staleRecheck: staleRecheckForProfile(meta.profile),
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
    listOpenPrs,
    toSenseDeps,
  };
}

/** Convenience: the {@link SenseDeps} for the sense entry points, bound to a context. */
export function buildSenseIo(ctx: SenseIoContext): SenseDeps {
  return createSenseIo(ctx).toSenseDeps();
}
