import { hasMarchReplyMarker } from "./march-bot.js";
import { createGitHubRead, type GitHubReadClient } from "./github-read.js";
import { TesseraClientError } from "../tessera/client.js";
import { isBotActor, summarizeCodeRabbit, type CodeRabbitStanding } from "./coderabbit-review.js";
import { resolveOriginRepo, sameGitHubRepo } from "../shared/github-remote.js";
import { execFile, spawn } from "node:child_process";
import { CastraClient } from "../castra/client.js";
import { gitHubAuthConfigArgs } from "../spawn/git-auth.js";
import type { LoopMeta } from "../legate/loop/meta.js";
import type { OpenPrIndex, SenseDeps, StaleRecheckTracker } from "../legate/loop/state/sense.js";
import { createStaleRecheckTracker } from "../legate/loop/state/sense.js";
import { parseCodexReviewState, type CodexReviewState } from "./codex-review.js";
import { classifyReviewerComment, type ReviewerNotice, codeRabbitNoticeHead } from "./review-bot-comments.js";
import { readSmithyStatus } from "./smithy-status.js";
import { normalizeBotLogin, selfBotLogin } from "../herald/profiles/merge-policy.js";

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
  /** When set, run GitHub I/O with scoped app/read entitlements. */
  readonly tessera?: GitHubReadClient;
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

// `gitHubAuthConfigArgs` (the SSH→HTTPS-token rewrite, #300/#301) moved to the
// shared leaf util `src/spawn/git-auth.ts` so the Hatchery spawn base-pin (#460)
// can fetch the same way without dragging this heavy observe module into the
// hatchery graph. Imported above for internal use; re-exported here so existing
// importers (and tests) are unchanged.
export { gitHubAuthConfigArgs };

/**
 * The shared observation I/O bundle. The legate loop uses {@link toSenseDeps}
 * for Stage 1 and calls {@link listSessions} / {@link queryPrForBabysit} /
 * {@link prMatchesSliceBranch} directly from its dispatch/recovery paths. Herald
 * uses {@link toSenseDeps} to feed `senseObserved` AND calls {@link
 * syncDefaultBranch} from its observe path — Herald owns the default-branch git
 * sync (#300; always on for every active profile, #601), so the sync is no
 * longer part of SenseDeps.
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

/** Output cap for one command (stdout + stderr), as execFile's `maxBuffer`. */
const EXEC_MAX_BUFFER = 32 * 1024 * 1024;

/** Upper bound for each git/gh step of the default-branch sync (#601 review). */
export const SYNC_STEP_TIMEOUT_MS = 120_000;

// Async command runner (mirrors the loop's former execFileSync seam): rejects on
// non-zero exit with execFileSync-shaped errors (message folds in stderr, plus
// .stdout/.stderr) so the recovery parsers that read failure text still work.
function execText(
  command: string,
  args: string[],
  options: Record<string, unknown> = {},
): Promise<string> {
  if (typeof options.timeout === "number" && options.timeout > 0 && process.platform !== "win32") {
    return execTextInGroup(command, args, options);
  }
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf-8", maxBuffer: EXEC_MAX_BUFFER, ...options },
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

/**
 * Timed variant of {@link execText}: runs the child as the leader of its own
 * process group and, on timeout, signals the whole group (#601 review). Killing
 * only the direct child is not enough: `git fetch`/`pull` start helpers
 * (`git-remote-https`, `fetch-pack`) that inherit the stdout/stderr pipes, so they
 * would outlive the kill and hold the call open past its timeout. Same
 * resolve/reject contract as `execText` (message folds in stderr, plus
 * `.stdout`/`.stderr`; a timeout sets `.killed` and `.signal`).
 */
export function execTextInGroup(
  command: string,
  args: string[],
  options: Record<string, unknown>,
): Promise<string> {
  const timeout = options.timeout as number;
  const killSignal = (options.killSignal as NodeJS.Signals | undefined) ?? "SIGKILL";
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    // Node's own timeout kills the direct child; the timer below (same delay,
    // registered just after, so it fires in the same timers phase) then kills
    // the rest of the group and settles without waiting for the pipes to close.
    const child = spawn(command, args, {
      cwd: options.cwd as string | undefined,
      env: options.env as NodeJS.ProcessEnv | undefined,
      timeout,
      killSignal,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const fail = (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err.stdout = stdout;
      err.stderr = stderr;
      if (stderr && !String(err.message).includes(stderr)) err.message = err.message + "\n" + stderr;
      reject(err);
    };
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, killSignal);
      } catch {
        // The group already exited.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(() => {
      killGroup();
      fail(Object.assign(new Error(`Command failed: ${command} ${args.join(" ")} (timed out after ${timeout}ms)`), {
        killed: true,
        signal: killSignal,
      }));
    }, timeout);
    const maxBuffer = typeof options.maxBuffer === "number" ? options.maxBuffer : EXEC_MAX_BUFFER;
    let bytes = 0;
    const collect = (append: (chunk: string) => void) => (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBuffer) {
        killGroup();
        fail(Object.assign(new Error(`Command failed: ${command} ${args.join(" ")} (output exceeded ${maxBuffer} bytes)`), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        }));
        return;
      }
      append(chunk);
    };
    child.stdout?.setEncoding("utf-8").on("data", collect((chunk) => { stdout += chunk; }));
    child.stderr?.setEncoding("utf-8").on("data", collect((chunk) => { stderr += chunk; }));
    child.on("error", fail);
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        clearTimeout(timer);
        resolve(stdout);
        return;
      }
      fail(Object.assign(new Error(`Command failed: ${command} ${args.join(" ")}`), { code, signal }));
    });
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

/** Preserve the legacy aggregate counts for older snapshot consumers. */
export function summarizeReviews(
  reviewNodes: any,
): { human_approval_count: number; changes_requested_count: number; bot_approval_count: number } {
  const nodes = Array.isArray(reviewNodes) ? reviewNodes : [];
  const isBot = (node: any): boolean => isBotActor(node?.author);
  // Latest meaningful review per login (by submittedAt). COMMENTED / PENDING /
  // DISMISSED reviews are dropped first, so a later comment does not hide an
  // earlier approval and a dismissed approval does not count.
  const latestPerLogin = (subset: any[]): any[] => {
    const latest = new Map<string, any>();
    for (const node of subset
      .filter((n) => !["COMMENTED", "PENDING", "DISMISSED"].includes(String(n?.state)))
      .sort((a, b) => String(a?.submittedAt).localeCompare(String(b?.submittedAt)))) {
      latest.set(String(node?.author?.login || ""), node);
    }
    return [...latest.values()];
  };
  let approvals = 0;
  let changesRequested = 0;
  for (const node of latestPerLogin(nodes.filter((node) => !isBot(node)))) {
    if (node?.state === "APPROVED") approvals++;
    else if (node?.state === "CHANGES_REQUESTED") changesRequested++;
  }
  let botApprovals = 0;
  for (const node of latestPerLogin(nodes.filter(isBot))) {
    if (node?.state === "APPROVED") botApprovals++;
  }
  return {
    human_approval_count: approvals,
    changes_requested_count: changesRequested,
    bot_approval_count: botApprovals,
  };
}

/** Policy-free verdict carried on an observed PR snapshot. */
export interface ReviewObservation {
  login: string;
  author_kind: "human" | "bot";
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  commit_sha: string | null;
  submitted_at: string;
}

function observeReviews(
  nodes: readonly any[],
  marchLogins: ReadonlySet<string>,
): { observations: ReviewObservation[]; complete: boolean } {
  const latest = new Map<string, ReviewObservation>();
  let complete = true;
  for (const node of nodes) {
    const author = node?.author;
    const state = node?.state;
    const login = typeof author?.login === "string" ? normalizeBotLogin(author.login) : "";
    if (!login || typeof node.submittedAt !== "string" || !node.submittedAt) {
      // A blocker whose author or time is unknown can be neither attributed nor
      // superseded, so it leaves the evidence incomplete rather than vanishing.
      // An unattributable approval is simply not counted.
      if (state === "CHANGES_REQUESTED") complete = false;
      continue;
    }
    if (marchLogins.has(login)) continue;
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "DISMISSED" && state !== "COMMENTED") continue;
    const authorKind = isBotActor({ ...author, login: author.login.toLowerCase() }) ? "bot" : "human";
    // A bare user login can match the slug of a separate GitHub App.
    const key = `${login}:${authorKind}`;
    const prior = latest.get(key);
    // A comment is only a fallback for a reviewer with no decisive verdict.
    if (prior) {
      const samePriority = (state === "COMMENTED") === (prior.state === "COMMENTED");
      if (samePriority ? prior.submitted_at > node.submittedAt : state === "COMMENTED") continue;
    }
    latest.set(key, {
      login,
      author_kind: authorKind,
      state,
      commit_sha: typeof node.commit?.oid === "string" ? node.commit.oid : null,
      submitted_at: node.submittedAt,
    });
  }
  const observations = [...latest.values()]
    .sort((a, b) => a.login.localeCompare(b.login) || a.author_kind.localeCompare(b.author_kind));
  return { observations, complete };
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
/** Review fields shared by the first query and each follow-up page. */
const REVIEW_PAGE_FIELDS = `pageInfo { hasNextPage endCursor }
        nodes {
          state
          submittedAt
          commit { oid }
          author { login __typename }
        }`;

/** Timeout for an ambient `gh api graphql` call (the Tessera path sets its own). */
const GRAPHQL_EXEC_OPTIONS = { timeout: 30_000, killSignal: "SIGKILL" } as const;

/** Safety bound on follow-up review pages (100 reviews each) per PR per tick.
 *  Normal PRs need none; this only stops a runaway walk. Past it the evidence is
 *  marked incomplete and the review gates fail closed. */
const MAX_EXTRA_REVIEW_PAGES = 100;

function reviewPageArgs(owner: string, name: string, pr: unknown, cursor: string): string[] {
  return [
    "api",
    "graphql",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `pr=${pr}`,
    "-f",
    `cursor=${cursor}`,
    "-f",
    `query=query($owner: String!, $name: String!, $pr: Int!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      headRefOid
      reviews(first: 100, after: $cursor) {
        ${REVIEW_PAGE_FIELDS}
      }
    }
  }
}`,
  ];
}

export function createSenseIo(ctx: SenseIoContext): SenseIo {
  const meta = ctx.meta;
  const env = ctx.env ?? process.env;
  const now = ctx.now ?? (() => new Date().toISOString());
  const warn = ctx.warn;
  const github = ctx.tessera && createGitHubRead(ctx.tessera, env, execText);

  function gh(args: string[], options: Record<string, unknown>, owner: string | null, sliceId?: string) {
    if (!github) return execText("gh", args, options);
    return github.gh(owner, args, sliceId);
  }
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

  /** Sentinel: state names a different repository than origin — observe nothing. */
  const OWNER_MISMATCH = Symbol("owner-mismatch");

  async function repoOwner(state: any): Promise<string | null> {
    const owner = await resolveOwner(state);
    return owner === OWNER_MISMATCH ? null : owner;
  }

  async function resolveOwner(state: any): Promise<string | null | typeof OWNER_MISMATCH> {
    const configured = state?.repo?.owner_with_name;
    const repoPath = state?.repo?.path || meta.repo?.path;
    const hasConfigured = typeof configured === "string" && configured.length > 0;
    const hasPath = typeof repoPath === "string" && repoPath.length > 0;
    // Don't cache a "no path" miss — it's a caller/config gap, not a resolved fact.
    if (!hasPath) return hasConfigured ? configured : null;
    if (ownerCache === undefined) {
      // The checkout's `origin` is the repository Legate mutates
      // (src/shared/github-remote.ts); observe the same one. `gh repo view` is
      // only a fallback for a non-GitHub-shaped origin — it may pick another
      // remote (e.g. `upstream`), but Legate then refuses to mutate.
      const origin = await resolveOriginRepo(repoPath);
      if (origin) {
        ownerCache = origin;
      } else if (hasConfigured) {
        return configured;
      } else if (github) {
        // Tessera-scoped observation never falls back to the ambient gh login.
        ownerCache = null;
        return null;
      } else {
        try {
          const out = await execText("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
            cwd: repoPath, timeout: 30_000, killSignal: "SIGKILL",
          });
          ownerCache = out.trim() || null;
        } catch {
          ownerCache = null;
        }
        return ownerCache;
      }
    }
    if (hasConfigured && ownerCache && !sameGitHubRepo(configured, ownerCache)) {
      // A PR read from one repository must never be acted on in another.
      warn?.(`repo owner mismatch: state names ${configured} but origin is ${ownerCache}; skipping observation`);
      return OWNER_MISMATCH;
    }
    return ownerCache ?? (hasConfigured ? configured : null);
  }

  async function ghPrArgs(slice: any, state: any, fields: string): Promise<any> {
    const number = prNumber(slice);
    if (!number) return { skipped: true, reason: "missing_pr_number" };
    const args = ["pr", "view", number, "--json", fields];
    const owner = await resolveOwner(state);
    // Never fall back to the checkout's gh default repo on a mismatch.
    if (owner === OWNER_MISMATCH) return { skipped: true, reason: "repo_owner_mismatch" };
    if (typeof owner === "string" && owner.length > 0) {
      args.push("-R", github ? `github.com/${owner}` : owner);
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
    sliceId: string | undefined,
    prAuthor: string,
  ): Promise<{
    threads: any[];
    reviews: any[];
    reviewObservations: ReviewObservation[];
    comments: any[];
    reviewerNotices: ReviewerNotice[];
    codexReview: CodexReviewState | null;
    headRefOid: string | null;
    mergeStateStatus: string | null;
    /** Whether every review page was read for the observed head. */
    reviewsComplete: boolean;
    /** `undefined` when the query failed: unknown, never "CodeRabbit has not reviewed". */
    coderabbit: CodeRabbitStanding | null | undefined;
  }> {
    const empty = {
      threads: [],
      reviews: [],
      reviewObservations: [],
      comments: [],
      reviewerNotices: [],
      codexReview: null,
      headRefOid: null,
      mergeStateStatus: null,
      coderabbit: undefined,
      reviewsComplete: false,
    };
    if (!owner) return empty;
    const [repoOwnerName, repoName] = owner.split("/");
    if (!repoOwnerName || !repoName) return empty;
    const args = [
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
      // review verdicts with their author types and commit SHAs.
      `query=query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      headRefOid
      mergeStateStatus
      reviews(first: 100) {
        ${REVIEW_PAGE_FIELDS}
      }
      comments(last: 50) {
        nodes {
          databaseId
          body
          createdAt
          url
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
              author { login __typename }
              createdAt
            }
          }
        }
      }
    }
  }
}`,
    ];
    const runGraphql = async (graphqlArgs: string[]): Promise<{ output: string; appLogin?: string }> => github
      ? await github.ghWithIdentity(owner, graphqlArgs, sliceId)
      // Bound the ambient-gh path like the Tessera one: a hung child must fail
      // (marking any follow-up page incomplete) rather than stall observation.
      : { output: await gh(graphqlArgs, GRAPHQL_EXEC_OPTIONS, owner, sliceId), appLogin: undefined };
    const { output, appLogin } = await runGraphql(args);
    const normalizedAppLogin = appLogin?.toLowerCase();
    const isApp = (author: { login?: string; __typename?: string } | undefined) => {
      const login = author?.login?.toLowerCase();
      if (!login || !normalizedAppLogin) return false;
      // GraphQL can return the bare app slug for a Bot actor.
      return login === normalizedAppLogin || (author?.__typename === "Bot" && `${login}[bot]` === normalizedAppLogin);
    };
    const isMarchReply = (comment: any) => isApp(comment.author) || hasMarchReplyMarker(comment.body);
    const parsed = JSON.parse(output);
    const pr = parsed?.data?.repository?.pullRequest || {};
    // Follow the review cursor so >100-review PRs still yield complete evidence.
    // Each extra page re-reads headRefOid: if the head moved mid-walk the pages
    // describe different heads, so the evidence stays marked incomplete.
    const hasFirstPage = Array.isArray(pr?.reviews?.nodes);
    const reviewNodes: any[] = hasFirstPage ? [...pr.reviews.nodes] : [];
    let reviewPage = hasFirstPage ? pr.reviews.pageInfo : undefined;
    let reviewsComplete = reviewPage?.hasNextPage === false;
    const seenCursors = new Set<string>();
    for (let page = 0; reviewPage?.hasNextPage === true && page < MAX_EXTRA_REVIEW_PAGES; page++) {
      const cursor = reviewPage.endCursor;
      if (typeof cursor !== "string" || !cursor || seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
      try {
        const next = JSON.parse((await runGraphql(reviewPageArgs(repoOwnerName, repoName, prNumberValue, cursor))).output)
          ?.data?.repository?.pullRequest;
        if (!next || next.headRefOid !== pr?.headRefOid) break;
        if (!Array.isArray(next.reviews?.nodes)) break;
        reviewNodes.push(...next.reviews.nodes);
        reviewPage = next.reviews?.pageInfo;
        reviewsComplete = reviewPage?.hasNextPage === false;
      } catch {
        // A failed follow-up page leaves the evidence incomplete (fail closed).
        reviewsComplete = false;
        break;
      }
    }
    const nodes = pr?.reviewThreads?.nodes || [];
    const threads = nodes
      .filter((thread: any) => thread && thread.isResolved === false)
      .map((thread: any) => {
        const comments = Array.isArray(thread.comments?.nodes)
          ? [...thread.comments.nodes].sort((a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)))
          : [];
        const first = comments[0] || {};
        const last = comments[comments.length - 1] || first;
        const lastIsMarch = isMarchReply(last);
        return {
          id: first.databaseId,
          path: first.path,
          line: first.line,
          author: first.author?.login,
          body_preview: String(first.body || "").slice(0, 140),
          last_author: last.author?.login,
          last_comment_at: last.createdAt,
          comment_count: comments.length,
          ...(lastIsMarch ? { last_comment_is_march: true } : {}),
          needs_response: !lastIsMarch && (appLogin ? comments.length > 0 : last.author?.login !== prAuthor),
          comment_ids: comments.filter((comment: any) => !isMarchReply(comment))
            .map((comment: any) => comment.databaseId).filter((id: any) => id != null),
        };
      });
    // Conversation comments: PR-level (issue) comments NOT tied to a code line and
    // NOT part of a review thread — the "non-thread" feedback the thread/review
    // signals miss entirely. We sample the NEWEST 50 (`last: 50`): on a long-running
    // PR the most recent reviewer feedback is what matters, and `first: 50` would
    // pin us to the oldest comments and never surface a fresh request. `reacted_eyes`
    // reads `viewerHasReacted` for the EYES reaction from the legate token's
    // perspective: the legate posts :eyes: when it dispatches a comment-fix, so this
    // is a human-visible acknowledgement alongside durable comment-id dedup.
    const commentNodes = Array.isArray(pr?.comments?.nodes) ? pr.comments.nodes : [];
    let codexReview: CodexReviewState | null = null;
    const reviewerNotices: ReviewerNotice[] = [];
    const comments = commentNodes.flatMap((c: any) => {
      if (!c || isMarchReply(c)) return [];
      const body = String(c.body || "");
      const classification = classifyReviewerComment({
        author: c.author?.login,
        authorType: c.author?.__typename,
        body,
        createdAt: c.createdAt,
      });
      if ("reviewer" in classification && classification.reviewer && typeof c.createdAt === "string") {
        reviewerNotices.push({
          reviewer: classification.reviewer,
          kind: classification.kind,
          ...(classification.kind === "in_progress" ? { head_sha: codeRabbitNoticeHead(body) } : {}),
          created_at: c.createdAt,
          ...(classification.resetAt ? { reset_at: classification.resetAt } : {}),
        });
      }
      // Preserve Codex's newest verified summary as its legacy review state.
      if ("reviewer" in classification && classification.reviewer === "codex") codexReview = parseCodexReviewState(body);
      if (classification.kind !== "feedback" || c.databaseId == null) return [];
      return [{
        id: c.databaseId,
        author: c.author?.login,
        author_type: c.author?.__typename,
        // Bounded to keep the /smithy.fix prompt + fold entry small; `url` (and
        // `truncated`) let the worker read the rest, so a long request stays
        // actionable instead of being silently clipped.
        body_preview: body.slice(0, 280),
        truncated: body.length > 280,
        url: c.url,
        created_at: c.createdAt,
        reacted_eyes: (Array.isArray(c.reactionGroups) ? c.reactionGroups : []).some(
          (g: any) => g?.content === "EYES" && g?.viewerHasReacted === true,
        ),
      }];
    });
    const observed = observeReviews(reviewNodes, new Set([
      selfBotLogin(env),
      ...(appLogin ? [normalizeBotLogin(appLogin)] : []),
    ]));
    if (!observed.complete) reviewsComplete = false;
    return {
      threads,
      reviews: reviewNodes.filter((review: any) => !isApp(review?.author)),
      reviewObservations: observed.observations,
      comments,
      reviewerNotices,
      codexReview,
      headRefOid: pr?.headRefOid || null,
      mergeStateStatus: pr?.mergeStateStatus || null,
      // Read from the unfiltered comment nodes: a `@coderabbitai review` request is
      // the evidence that the head was already put forward.
      coderabbit: summarizeCodeRabbit(reviewNodes, commentNodes, reviewsComplete),
      reviewsComplete,
    };
  }

  async function queryPrForBabysit(slice: any, state: any, discovery = false): Promise<any> {
    const request = await ghPrArgs(
      slice,
      state,
      "number,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup,headRefName,title,author,updatedAt" + (github && discovery ? ",isCrossRepository" : ""),
    );
    if (request.skipped) return request;
    const summary = JSON.parse(await gh(request.args, request.options, request.owner, slice.id));
    if (github && discovery && summary.isCrossRepository !== false) return null;
    const graphql = await queryReviewThreads(
      request.owner || (await repoOwner(state)), summary.number, slice.id, summary.author?.login || "",
    );
    const annotated = graphql.threads;
    const reviewSummary = summarizeReviews(graphql.reviews);
    return {
      number: summary.number,
      url: summary.url,
      state: summary.state,
      is_draft: summary.isDraft,
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
      // actionable feedback that has yet to be acknowledged or dispatched.
      conversation_comments: graphql.comments,
      reviewer_notices: graphql.reviewerNotices,
      // Codex's code-review state (reviewed commit, status, unresolved findings),
      // or null when the sampled comments hold no Codex summary with a readable
      // state. Nothing gates on it yet: it is the per-commit signal a merge gate
      // can wait on, by comparing `commit_sha` with `head_sha`.
      codex_review: graphql.codexReview,
      human_approval_count: reviewSummary.human_approval_count,
      changes_requested_count: reviewSummary.changes_requested_count,
      bot_approval_count: reviewSummary.bot_approval_count,
      reviews: graphql.reviewObservations,
      // False when some review pages were not read, so the gate treats the
      // review evidence as incomplete.
      reviews_complete: graphql.reviewsComplete,
      // CodeRabbit's review standing: what the legate's opt-in CodeRabbit review
      // request reads. See coderabbit-review.ts.
      coderabbit: graphql.coderabbit,
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
        addBranchVariants(branches, await execText("git", ["-C", slice.worktree_path, "branch", "--show-current"], { timeout: 5_000 }));
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
      const output = sessionId ? await castra().sessionOutput(meta.profile, sessionId) : "";
      const matches = output.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/([0-9]+)/g) || [];
      if (matches.length > 0) {
        const url = matches[matches.length - 1];
        const number = url.split("/").pop();
        const owner = github ? await repoOwner(state) : null;
        if (!github || (owner && url.toLowerCase().startsWith(`https://github.com/${owner.toLowerCase()}/pull/`))) {
          const pr = await queryPrForBabysit({ id: slice.id, pr: { number } }, state, true);
          if (pr && !pr.skipped && await prMatchesSliceBranch(slice, pr)) return pr;
          if (!github) return null;
        }
      }
    } catch (err) {
      if (err instanceof TesseraClientError) throw err;
      // fall through to branch-based lookup
    }
    try {
      const owner = await resolveOwner(state);
      if (owner === OWNER_MISMATCH) return null;
      const args = ["pr", "list", ...(github ? [] : ["--author", "@me"]), "--state", "open", "--json",
        "number,url,state,mergeable,headRefName,title,statusCheckRollup,createdAt" + (github ? ",isCrossRepository" : "")];
      if (owner) args.push("-R", github ? `github.com/${owner}` : owner);
      const options = owner ? {} : { cwd: repoPath };
      const expected = github ? await expectedPrBranches(slice) : undefined;
      const list = [];
      if (expected) {
        for (const branch of expected) {
          const results = JSON.parse(await gh([...args, "--head", branch, "--limit", "100"], options, owner, slice.id));
          list.push(...results);
        }
      } else {
        list.push(...JSON.parse(await gh(args, options, owner, slice.id)));
      }
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
        candidates.map((candidate: any) =>
          expected
            ? candidate.isCrossRepository === false && expected.has(candidate.headRefName)
            : prMatchesSliceBranch(slice, candidate)),
      );
      const branchMatches = candidates.filter((_candidate: any, i: number) => matchFlags[i]);
      const chosen = branchMatches
        .sort((a: any, b: any) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
      if (!chosen) return null;
      return await queryPrForBabysit({ id: slice.id, pr: { number: chosen.number } }, state, true);
    } catch (err) {
      if (github) throw err;
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
   * Except for scoped issuance failures, returns `{error}` when the owner can't be resolved or the query
   * fails, so the caller degrades to the always-fetch path instead of stranding.
   */
  async function listOpenPrs(state: any): Promise<OpenPrIndex | { error: string }> {
    const resolved = await resolveOwner(state);
    if (resolved === OWNER_MISMATCH) return { error: "repo owner unavailable" };
    const owner = resolved;
    if (!owner && !github) return { error: "repo owner unavailable" };
    const [repoOwnerName, repoName] = owner?.split("/") ?? [];
    if (owner && (!repoOwnerName || !repoName)) return { error: `unparseable repo owner: ${owner}` };
    try {
      const out = await gh([
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
      ], {}, owner);
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
      if (err instanceof TesseraClientError) throw err;
      return { error: err?.message || String(err) };
    }
  }

  async function syncDefaultBranch(state: any): Promise<SyncResult> {
    const repoPath = state?.repo?.path || meta.repo?.path;
    if (typeof repoPath !== "string" || repoPath.length === 0) {
      throw new Error("repo path is missing");
    }
    const owner = github ? await repoOwner(state) : null;
    const localOptions = github
      ? { cwd: repoPath, env, timeout: 5_000 }
      : { cwd: repoPath, timeout: SYNC_STEP_TIMEOUT_MS, killSignal: "SIGKILL" as const };
    let defaultBranch = state?.repo?.default_branch;
    if (!defaultBranch) {
      try {
        defaultBranch = (await execText("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], localOptions))
          .trim()
          .replace(/^origin\//, "");
      } catch {
        const target = github ? [`github.com/${owner}`] : [];
        defaultBranch = (await gh(["repo", "view", ...target, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], localOptions, owner)).trim();
      }
    }
    if (!defaultBranch) throw new Error("could not determine default branch");
    if (github) {
      const head = `refs/heads/${defaultBranch}`;
      await execText("git", ["check-ref-format", head], localOptions);
      await github.git(owner, repoPath, ["fetch", "--no-recurse-submodules"], `+${head}:refs/remotes/origin/${defaultBranch}`);
      await execText("git", ["switch", "--", defaultBranch], localOptions);
      await github.git(owner, repoPath, ["pull", "--ff-only", "--no-rebase", "--no-recurse-submodules"], head);
    } else {
      const auth = gitHubAuthConfigArgs(env);
      // Bound each step: Herald runs this inline in its observe tick, and a hung
      // fetch (DNS, stalled TLS) would otherwise block every later tick.
      await execText("git", [...auth, "fetch", "origin", defaultBranch], localOptions);
      await execText("git", ["switch", defaultBranch], localOptions);
      await execText("git", [...auth, "pull", "--ff-only", "origin", defaultBranch], localOptions);
    }
    if (state?.repo && !state.repo.default_branch) state.repo.default_branch = defaultBranch;
    return {
      default_branch: defaultBranch,
      synced: true,
      head: (await execText("git", ["rev-parse", "HEAD"], localOptions)).trim(),
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
