import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createCastraClientFromEnv } from "../../castra/client.js";
import type { CastraSession } from "../../castra/types.js";
import type { SessionRepository } from "./repository.js";
import type { SessionRecord } from "./types.js";

/**
 * Steward removal — the Brood↔Castra reconciliation that closes the steward-leak
 * (issue #304).
 *
 * Brood tracks a steward by the agent-deck session id captured at LAUNCH. But the
 * legate relaunches a vanished steward (crash/removal) under a FRESH Castra
 * session id without updating Brood, so the tracked id goes stale. Castra's
 * `remove` is tolerant — a missing id returns `{ removed: false }`, not an error —
 * so removing by the stale id silently "succeeds" while the real session keeps
 * running in Castra. Brood then marks the row `torndown` and the steward leaks
 * forever (Brood=torndown, Castra=waiting/error).
 *
 * The fix here is to make removal **worktree-centric and verifying** rather than
 * trusting a single tracked id: resolve the real live session(s) for a steward by
 * its EXACT worktree path (the #155 load-bearing field) against Castra's session
 * list, remove those by their real id, and report `absent` only when Castra
 * genuinely has no session for that worktree. Teardown marks `torndown` only on
 * `removed`/`absent`; `failed` defers + retries.
 */

/**
 * The slice of the Castra client that steward removal needs. A named interface so
 * teardown/sweep depend on the capability, not the concrete client, and tests can
 * inject a fake. {@link createCastraClientFromEnv}'s client satisfies it
 * structurally.
 */
export interface CastraStewardGateway {
  listSessions(profile: string, group?: string): Promise<CastraSession[]>;
  removeSession(req: {
    profile: string;
    sessionId: string;
    pruneWorktree: boolean;
    traceKey?: string;
  }): Promise<{ removed: boolean }>;
}

/** Construct the default Castra-backed gateway from environment configuration. */
export function defaultStewardGateway(
  env: NodeJS.ProcessEnv = process.env,
): CastraStewardGateway {
  return createCastraClientFromEnv(env);
}

/**
 * Outcome of a steward removal:
 *   - `removed` — at least one matching Castra session was found and removed.
 *   - `absent`  — Castra has no session for this steward (verified gone). Safe to
 *                 mark `torndown`.
 *   - `failed`  — Castra was unreachable or a removal call errored. The session
 *                 may still be live, so teardown must DEFER (not mark torndown).
 */
export type StewardRemovalOutcome = "removed" | "absent" | "failed";

export interface StewardRemovalResult {
  readonly outcome: StewardRemovalOutcome;
  readonly detail?: string;
  /** Real Castra session ids removed (for logging/telemetry). */
  readonly removedIds: readonly string[];
}

/** Identity of the steward to remove, resolved from the Brood registry. */
export interface StewardIdentity {
  /** The tracked agent-deck session id (may be stale after a relaunch). */
  readonly sessionId: string;
  readonly profile?: string;
  /** EXACT worktree path — the primary match key (#155). */
  readonly worktreePath?: string;
  readonly branch?: string;
}

/**
 * Does this live Castra session belong to the steward we are removing? Matched by
 * EXACT worktree path first (the #155-safe key — one steward per worktree), then
 * the tracked session id, then the branch when no worktree is known. The id and
 * branch fallbacks cover steward rows registered before a worktree was recorded.
 */
function sessionMatchesSteward(
  session: CastraSession,
  steward: StewardIdentity,
): boolean {
  if (steward.worktreePath && session.worktreePath === steward.worktreePath) {
    return true;
  }
  if (session.sessionId === steward.sessionId) return true;
  if (!steward.worktreePath && steward.branch && session.branch === steward.branch) {
    return true;
  }
  return false;
}

/**
 * Remove a steward from Castra by resolving its real session id(s) from the live
 * session list, not the (possibly stale) tracked id. Returns `absent` only when
 * Castra is reachable AND reports no session for this steward's worktree — that is
 * the verified-gone signal teardown needs before marking `torndown`. Any
 * unreachable-Castra / failed-removal path returns `failed` so teardown defers
 * rather than leaking.
 */
export async function removeStewardViaCastra(
  gateway: CastraStewardGateway,
  steward: StewardIdentity,
): Promise<StewardRemovalResult> {
  const profile = steward.profile ?? "";

  let sessions: CastraSession[];
  try {
    sessions = await gateway.listSessions(profile);
  } catch (err) {
    // Cannot verify the steward's absence — DEFER rather than mark torndown.
    return { outcome: "failed", detail: `castra list failed: ${message(err)}`, removedIds: [] };
  }

  const targets = sessions.filter((s) => sessionMatchesSteward(s, steward));
  if (targets.length === 0) {
    // Reachable + no matching session → verified gone.
    return { outcome: "absent", detail: "no matching castra session", removedIds: [] };
  }

  const removedIds: string[] = [];
  for (const target of targets) {
    try {
      const res = await gateway.removeSession({
        profile,
        sessionId: target.sessionId,
        pruneWorktree: false,
      });
      // `removed:false` here means the session vanished between list and remove
      // (a benign race) — still verified gone for that id.
      if (res.removed) removedIds.push(target.sessionId);
    } catch (err) {
      // A real removal failure: the session is still live. Defer + retry.
      return {
        outcome: "failed",
        detail: `castra remove "${target.sessionId}" failed: ${message(err)}`,
        removedIds,
      };
    }
  }

  return {
    outcome: "removed",
    detail: removedIds.length ? `removed ${removedIds.join(", ")}` : "already gone",
    removedIds,
  };
}

// ---------------------------------------------------------------------------
// Orphan sweep — reaping leaked stewards Brood never tracked (#304, ask 3)
// ---------------------------------------------------------------------------

/**
 * The deciding insight that the worktree-keyed teardown removal alone CANNOT
 * close the leak: a relaunch makes a brand-new steward with a NEW worktree hash
 * AND a new session id, and never tells Brood. So the live orphan's worktree
 * (e.g. `…-screens-and-flows-as-ui-898689c7`) matches NO Brood row — the
 * torndown record for that slice points at the FIRST attempt's worktree
 * (`…-d4143794`). Keying the sweep off Brood's torndown rows therefore reaps
 * zero and the leak persists.
 *
 * The sweep here instead reaps **true orphans**: any live Castra steward session
 * for which Brood has NO *active* (non-torndown) record — gated so a session is
 * only reaped when its work is GENUINELY DONE. "Done" = its branch maps to a
 * GitHub PR that is MERGED or CLOSED, or its worktree no longer exists on disk.
 * A live steward on an OPEN PR is never reaped; an indeterminate state (no PR,
 * `gh` unavailable, no repo root) is left alone rather than guessed.
 */

/** PR state for a branch as reported by the forge, plus the no-PR / unknown cases. */
export type BranchPrState = "open" | "merged" | "closed" | "none" | "unknown";

/**
 * The two forge/disk reads the orphan gate needs, behind a seam so the sweep is
 * unit-testable without a real network / filesystem. {@link defaultOrphanGate}
 * uses `fs.existsSync` and the GitHub REST API (token, NOT `gh`).
 */
export interface OrphanGate {
  /** True when the steward's worktree still exists on disk (best-effort). */
  worktreeExists(worktreePath: string): boolean;
  /** PR state for `branch`, resolved from the origin remote at `repoRoot`. */
  branchPrState(branch: string, repoRoot: string): Promise<BranchPrState>;
}

const GIT_MAX_BUFFER = 16 * 1024 * 1024;
/** Keep the forge lookup snappy — a hung api.github.com must not stall the sweep. */
const GITHUB_API_TIMEOUT_MS = 10_000;

type FetchImpl = typeof fetch;

/**
 * Parse `owner/repo` from a GitHub origin remote URL — the scp-short
 * (`git@github.com:owner/repo.git`), `https://github.com/owner/repo(.git)`, and
 * `ssh://git@github.com/owner/repo` forms. Returns undefined for a non-GitHub
 * remote (no forge lookup possible → the gate reports `unknown`, never reaps).
 */
export function parseGitHubSlug(
  remoteUrl: string,
): { owner: string; repo: string } | undefined {
  const m = remoteUrl.trim().match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return undefined;
  return { owner: m[1], repo: m[2] };
}

const FEATURE_PREFIX = "feature/";

/**
 * The head-branch variants to query GitHub for, because the LOCAL branch a
 * steward/Castra session carries is NOT always the pushed PR head. The workers
 * push `smithy/<verb>/…` branches under a `feature/` prefix
 * (`feature/smithy/<verb>/…`), so a head query by the raw local name finds no PR
 * and a merged orphan would never be reaped. Try the name as-is, plus the
 * `feature/`-prefixed form, plus the `feature/`-stripped form — deduped, order
 * preserved (as-is first).
 */
export function candidateHeadBranches(branch: string): string[] {
  const variants = [branch];
  if (branch.startsWith(FEATURE_PREFIX)) {
    variants.push(branch.slice(FEATURE_PREFIX.length));
  } else {
    variants.push(`${FEATURE_PREFIX}${branch}`);
  }
  return [...new Set(variants.filter((b) => b.length > 0))];
}

/** PRs for a single exact `owner:head` query, plus whether the request errored. */
async function fetchPullsForHead(opts: {
  owner: string;
  repo: string;
  head: string;
  token: string;
  fetchImpl: FetchImpl;
}): Promise<{ prs: Array<{ state?: string; merged_at?: string | null }>; errored: boolean }> {
  const head = `${opts.owner}:${opts.head}`;
  const url =
    `https://api.github.com/repos/${encodeURIComponent(opts.owner)}/` +
    `${encodeURIComponent(opts.repo)}/pulls` +
    `?head=${encodeURIComponent(head)}&state=all&per_page=100`;

  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "march-brood",
      },
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
  } catch {
    return { prs: [], errored: true };
  }
  if (!res.ok) return { prs: [], errored: true };
  try {
    const body = await res.json();
    if (!Array.isArray(body)) return { prs: [], errored: true };
    return { prs: body as Array<{ state?: string; merged_at?: string | null }>, errored: false };
  } catch {
    return { prs: [], errored: true };
  }
}

/**
 * Query GitHub's REST API for the PR state of a head branch WITHOUT `gh` (the
 * brood image ships no `gh`, mirroring the #301 Herald fix that dropped a tool
 * dependency for a token). Lists pulls across every {@link candidateHeadBranches}
 * variant (the worker `feature/` prefix mismatch) and folds the union: any open →
 * `open`; else any merged (`merged_at` set) → `merged`; else any closed →
 * `closed`. With no PRs found and no request error → `none`; with no PRs but a
 * request error → `unknown`, so an open PR we could not see is never reaped.
 */
export async function fetchBranchPrState(opts: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  fetchImpl?: FetchImpl;
}): Promise<BranchPrState> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const prs: Array<{ state?: string; merged_at?: string | null }> = [];
  let errored = false;
  for (const head of candidateHeadBranches(opts.branch)) {
    const res = await fetchPullsForHead({
      owner: opts.owner,
      repo: opts.repo,
      head,
      token: opts.token,
      fetchImpl,
    });
    if (res.errored) errored = true;
    else prs.push(...res.prs);
  }

  if (prs.some((p) => p.state === "open")) return "open";
  if (prs.some((p) => Boolean(p.merged_at))) return "merged";
  if (prs.some((p) => p.state === "closed")) return "closed";
  return errored ? "unknown" : "none";
}

/** The origin remote URL of the repo at `repoRoot`, or undefined on any error. */
function gitOriginRemote(repoRoot: string): string | undefined {
  try {
    return execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: GIT_MAX_BUFFER,
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The default disk/forge-backed gate. Worktree existence is `fs.existsSync`; PR
 * state is the GitHub REST API authenticated with `GH_TOKEN`/`GITHUB_TOKEN` (the
 * same token the rest of the stack uses) — NO `gh` binary, so it works in the
 * tool-less brood container. With no token (or a non-GitHub remote) the PR lookup
 * reports `unknown` and the gate never reaps on the PR signal.
 */
export function defaultOrphanGate(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchImpl = fetch,
): OrphanGate {
  const token = (env.GH_TOKEN || env.GITHUB_TOKEN || "").trim();
  return {
    worktreeExists(worktreePath) {
      try {
        return existsSync(worktreePath);
      } catch {
        // An fs error is not proof of absence — err toward "exists" so a flaky
        // stat never causes a false reap of live work.
        return true;
      }
    },
    async branchPrState(branch, repoRoot) {
      if (!token) return "unknown";
      const remote = gitOriginRemote(repoRoot);
      if (!remote) return "unknown";
      const slug = parseGitHubSlug(remote);
      if (!slug) return "unknown";
      return fetchBranchPrState({ ...slug, branch, token, fetchImpl });
    },
  };
}

/** Whether an orphan steward's slice is finished, in flight, or indeterminate. */
export type OrphanWorkState = "done" | "in-progress" | "unknown";

export interface OrphanVerdict {
  readonly state: OrphanWorkState;
  /** Low-cardinality reason for logging/telemetry (e.g. `pr-merged`, `open-pr`). */
  readonly reason: string;
}

/**
 * Knobs the durable auto-reconciler (issue #304/#308 follow-up) passes through
 * the sweep. All optional — the empty default reproduces the conservative
 * break-glass behavior exactly, so the manual `march brood sweep` is unchanged.
 *
 * The auto-reconciler turns these on from env (two independent flags): the
 * dead-orphan criterion (`deadOrphanAgeMs`) and open-PR adoption (`adopt`) are
 * gated separately, and `reap: false` lets an adopt-only run leave confirmed-done
 * orphans untouched.
 */
export interface ReapOptions {
  /**
   * Remove confirmed-done orphans (pr-merged / pr-closed / worktree-gone /
   * dead-orphan). `undefined` is treated as `true` (the historical default); the
   * auto-reconciler sets `false` for an adopt-only pass.
   */
  readonly reap?: boolean;
  /**
   * Enable the age-gated dead-orphan criterion when set (milliseconds). A
   * non-running orphan past this age whose KNOWN branch the forge confirms has no
   * PR (`no-pr`) is judged `done`. Branchless sessions stay `unknown` (an empty
   * branch is ambiguous, not proof of no PR). `undefined` disables the criterion
   * entirely — the conservative default.
   */
  readonly deadOrphanAgeMs?: number;
  /**
   * Adopt untracked LIVE open-PR stewards INTO Brood (register them) instead of
   * skipping them, so the legate manages/merges them — the #304/#308 source fix
   * for the manual-merge backlog. Off by default.
   */
  readonly adopt?: boolean;
  /** Clock injection for the age comparison (tests). Defaults to `Date.now()`. */
  readonly now?: number;
}

/**
 * agent-deck statuses that mark a session as NOT actively working — the only
 * states a dead orphan may be in. `running` (busy) and `idle` are excluded, and
 * an empty status (agent-deck reported none) is treated as unknown → never dead.
 * Deliberately narrow: the dead-orphan reap must not race a session that is
 * merely between turns.
 */
const NON_RUNNING_STATUSES = new Set(["waiting", "error", "stopped"]);

/**
 * Is this untracked session a *dead orphan* — old enough, in a non-running
 * agent-deck status, and (the caller has already established) carrying no open
 * PR? Disabled (always false) unless `options.deadOrphanAgeMs` is set, so the
 * criterion is opt-in.
 */
function isDeadOrphan(session: CastraSession, options: ReapOptions): boolean {
  if (options.deadOrphanAgeMs === undefined) return false;
  if (!NON_RUNNING_STATUSES.has(session.status.trim().toLowerCase())) return false;
  const created = Date.parse(session.createdAt);
  if (Number.isNaN(created)) return false; // no trustworthy age → never reap
  const now = options.now ?? Date.now();
  return now - created > options.deadOrphanAgeMs;
}

/**
 * Decide whether a leaked Castra steward session's work is genuinely done, and
 * is therefore safe to reap. Conservative by construction: only `worktree-gone`
 * and a MERGED/CLOSED PR are unconditionally "done"; an OPEN PR is `in-progress`
 * (never reap); everything we cannot verify is `unknown` (left alone).
 *
 * The age-gated dead-orphan criterion (opt-in via `options.deadOrphanAgeMs`)
 * upgrades only `no-pr` (a KNOWN branch the forge confirms has no PR) to `done`
 * when the session is old + non-running ({@link isDeadOrphan}). `no-branch`,
 * `pr-lookup-unknown`, and `no-repo-root` stay `unknown`: a branch we could not
 * read or a PR we could not see must never be reaped on age.
 */
export async function classifyOrphanWork(
  session: CastraSession,
  repoRoot: string | undefined,
  gate: OrphanGate,
  options: ReapOptions = {},
): Promise<OrphanVerdict> {
  if (session.worktreePath && !gate.worktreeExists(session.worktreePath)) {
    return { state: "done", reason: "worktree-gone" };
  }
  if (!session.branch) {
    // `branch === ""` is AMBIGUOUS per the CastraSession contract — it means the
    // branch is UNKNOWN (detached HEAD, a non-git dir, a transient `git`
    // derivation failure, or an infra session like a conductor), NOT provably
    // "no branch / no PR". It therefore never proves a slice is done, so it is
    // never age-reaped: an open PR whose branch we could not read must survive.
    // Only worktree-gone (above) or a forge-confirmed no-PR on a KNOWN branch
    // (below) can mark an orphan done.
    return { state: "unknown", reason: "no-branch" };
  }
  if (!repoRoot) return { state: "unknown", reason: "no-repo-root" };

  switch (await gate.branchPrState(session.branch, repoRoot)) {
    case "open":
      return { state: "in-progress", reason: "open-pr" };
    case "merged":
      return { state: "done", reason: "pr-merged" };
    case "closed":
      return { state: "done", reason: "pr-closed" };
    case "none":
      return isDeadOrphan(session, options)
        ? { state: "done", reason: "dead-orphan" }
        : { state: "unknown", reason: "no-pr" };
    default:
      return { state: "unknown", reason: "pr-lookup-unknown" };
  }
}

/** A leaked Castra session reaped by {@link sweepLeakedStewards}. */
export interface SweptSession {
  readonly sessionId: string;
  readonly profile: string;
  readonly worktreePath: string;
  readonly branch: string;
  /** Why its work was judged done (`worktree-gone` | `pr-merged` | `pr-closed`). */
  readonly reason: string;
}

/** A live session the sweep deliberately left in place, and why. */
export interface SkippedSession {
  readonly sessionId: string;
  readonly profile: string;
  /** `tracked` | `open-pr` | `no-pr` | `pr-lookup-unknown` | `no-branch` | `no-repo-root`. */
  readonly reason: string;
}

/**
 * An untracked LIVE open-PR steward the sweep ADOPTED into Brood (registered)
 * rather than skipping, so the legate manages/merges it — the #304/#308 source
 * fix for the manual-merge backlog. Only produced when `ReapOptions.adopt` is on.
 */
export interface AdoptedSession {
  readonly sessionId: string;
  readonly profile: string;
  readonly worktreePath: string;
  readonly branch: string;
}

/** A profile whose sweep could not be completed (e.g. Castra unreachable). */
export interface SweepFailure {
  readonly profile: string;
  readonly sessionId: string;
  readonly detail: string;
}

export interface SweepResult {
  readonly scannedProfiles: readonly string[];
  readonly reaped: readonly SweptSession[];
  /** Untracked open-PR stewards registered INTO Brood (only when `adopt` on). */
  readonly adopted: readonly AdoptedSession[];
  readonly skipped: readonly SkippedSession[];
  readonly failures: readonly SweepFailure[];
}

/** Resolve a record's worktree/branch, falling back to its parent spawn. */
function resolveStewardWorkspace(
  store: SessionRepository,
  record: SessionRecord,
): { worktreePath?: string; branch?: string } {
  if (record.worktreePath) {
    return { worktreePath: record.worktreePath, branch: record.branch };
  }
  const parent = record.parentId ? store.get(record.parentId) : undefined;
  return {
    worktreePath: parent?.worktreePath,
    branch: record.branch ?? parent?.branch,
  };
}

/**
 * Per-profile view of what Brood still considers LIVE — used to recognize which
 * Castra sessions are legitimately tracked (and so must never be reaped) — plus
 * a repo root to run forge lookups from.
 */
interface ProfileSweepIndex {
  readonly activeIds: Set<string>;
  readonly activeWorktrees: Set<string>;
  readonly activeBranches: Set<string>;
  repoRoot?: string;
}

/**
 * Build the per-profile index of what Brood still considers LIVE. Enumerates
 * every profile Brood has seen (active OR torndown rows): the torndown rows carry
 * the `repoPath` forge lookups run from, and the profile set is what callers scan
 * Castra for. Only NON-torndown records mark a Castra session as legitimately
 * tracked. Shared by the manual sweep and the periodic reconciliation observer so
 * both classify "is this live Castra session tracked?" identically.
 */
export function indexActiveByProfile(
  store: SessionRepository,
): Map<string, ProfileSweepIndex> {
  const records = store.list({});

  const byProfile = new Map<string, ProfileSweepIndex>();
  const indexFor = (profile: string): ProfileSweepIndex => {
    let index = byProfile.get(profile);
    if (!index) {
      index = {
        activeIds: new Set(),
        activeWorktrees: new Set(),
        activeBranches: new Set(),
      };
      byProfile.set(profile, index);
    }
    return index;
  };

  for (const record of records) {
    const index = indexFor(record.profile ?? "");
    if (record.repoPath && !index.repoRoot) index.repoRoot = record.repoPath;
    // Only NON-torndown records mark a Castra session as legitimately tracked.
    if (record.status === "torndown") continue;
    if (record.id) index.activeIds.add(record.id);
    if (record.agentDeckSessionId) index.activeIds.add(record.agentDeckSessionId);
    const { worktreePath, branch } = resolveStewardWorkspace(store, record);
    if (worktreePath) index.activeWorktrees.add(worktreePath);
    if (branch) index.activeBranches.add(branch);
  }

  return byProfile;
}

/**
 * Is this live Castra session owned by an *active* (non-torndown) Brood record?
 * Matched the same three ways the sweep matches — exact session id, exact
 * worktree path (#155), or branch — so the reconciliation gauge and the reaper
 * agree on what "tracked" means.
 */
function sessionIsTrackedLive(
  session: CastraSession,
  index: ProfileSweepIndex,
): boolean {
  return (
    index.activeIds.has(session.sessionId) ||
    (!!session.worktreePath && index.activeWorktrees.has(session.worktreePath)) ||
    (!!session.branch && index.activeBranches.has(session.branch))
  );
}

/** One profile's live-Castra-vs-Brood-tracked reconciliation counts. */
export interface ReconciliationObservation {
  readonly profile: string;
  /** Live Castra sessions Castra reported for this profile. */
  readonly castraLive: number;
  /** Of those, how many an active Brood record owns. */
  readonly trackedActive: number;
  /** Of those, how many have NO active Brood record (the leak: live but untracked). */
  readonly orphans: number;
}

/**
 * Read-only reconciliation: for every profile Brood knows, compare Castra's live
 * session list against Brood's active records and count how many live sessions
 * are tracked vs orphaned. This is the divergence the dashboards/alerts read —
 * `orphans > 0` is the "Castra has N stewards, Brood tracks 0" wedge that renders
 * a stalled loop as green. NEVER mutates Castra or Brood (the reaping is
 * {@link sweepLeakedStewards}); a profile whose Castra list fails is skipped so
 * one unreachable profile cannot poison the others' gauges.
 */
export async function observeReconciliation(
  store: SessionRepository,
  gateway: CastraStewardGateway,
): Promise<ReconciliationObservation[]> {
  const byProfile = indexActiveByProfile(store);
  const out: ReconciliationObservation[] = [];
  for (const [profile, index] of byProfile) {
    let sessions: CastraSession[];
    try {
      sessions = await gateway.listSessions(profile);
    } catch {
      // Skip — an unreachable profile must not emit a misleading zero/spike.
      continue;
    }
    let trackedActive = 0;
    for (const session of sessions) {
      if (sessionIsTrackedLive(session, index)) trackedActive++;
    }
    out.push({
      profile,
      castraLive: sessions.length,
      trackedActive,
      orphans: sessions.length - trackedActive,
    });
  }
  return out;
}

/**
 * Reap leaked Castra stewards (issue #304, ask 3). For every profile Brood knows
 * about, list Castra's live sessions and reap each TRUE ORPHAN — a session with
 * no *active* (non-torndown) Brood record — whose work is genuinely done per
 * {@link classifyOrphanWork} (PR merged/closed, worktree gone, or — when the
 * dead-orphan criterion is enabled — an old non-running orphan with no open PR).
 * Sessions an active Brood record still owns are skipped (teardown handles
 * those); a live steward on an open PR or any state we cannot verify is left
 * untouched.
 *
 * With `options.adopt` on, an untracked LIVE open-PR steward is ADOPTED into
 * Brood (registered) instead of being skipped, so the legate manages/merges it —
 * the #304/#308 source fix for the manual-merge backlog. With `options.reap`
 * `false` (an adopt-only pass) a confirmed-done orphan is left in place rather
 * than removed. The default `{}` reproduces the conservative break-glass behavior
 * exactly (reap confirmed-done, skip open-PR, no dead-orphan reap).
 *
 * Idempotent and best-effort: a profile whose Castra list fails is recorded as a
 * failure and the others still run.
 */
export async function sweepLeakedStewards(
  store: SessionRepository,
  gateway: CastraStewardGateway,
  gate: OrphanGate = defaultOrphanGate(),
  options: ReapOptions = {},
): Promise<SweepResult> {
  const byProfile = indexActiveByProfile(store);
  const reapEnabled = options.reap !== false; // undefined → historical default (reap)

  const reaped: SweptSession[] = [];
  const adopted: AdoptedSession[] = [];
  const skipped: SkippedSession[] = [];
  const failures: SweepFailure[] = [];

  for (const [profile, index] of byProfile) {
    let sessions: CastraSession[];
    try {
      sessions = await gateway.listSessions(profile);
    } catch (err) {
      failures.push({ profile, sessionId: "*", detail: `castra list failed: ${message(err)}` });
      continue;
    }
    for (const session of sessions) {
      // Owned by a live Brood record → teardown's job, never the sweep's.
      if (sessionIsTrackedLive(session, index)) {
        skipped.push({ sessionId: session.sessionId, profile, reason: "tracked" });
        continue;
      }

      const verdict = await classifyOrphanWork(session, index.repoRoot, gate, options);

      // Untracked open-PR steward: adopt it into Brood so the legate can
      // manage/merge it (the manual-merge-backlog source fix), else leave it.
      if (verdict.state === "in-progress") {
        if (options.adopt) {
          try {
            adoptOpenPrSteward(store, session, profile, index.repoRoot);
            adopted.push({
              sessionId: session.sessionId,
              profile,
              worktreePath: session.worktreePath,
              branch: session.branch,
            });
          } catch (err) {
            failures.push({ profile, sessionId: session.sessionId, detail: `adopt failed: ${message(err)}` });
          }
        } else {
          skipped.push({ sessionId: session.sessionId, profile, reason: verdict.reason });
        }
        continue;
      }

      if (verdict.state !== "done") {
        skipped.push({ sessionId: session.sessionId, profile, reason: verdict.reason });
        continue;
      }

      // Confirmed done — but an adopt-only pass (reap disabled) leaves it.
      if (!reapEnabled) {
        skipped.push({ sessionId: session.sessionId, profile, reason: verdict.reason });
        continue;
      }

      try {
        await gateway.removeSession({
          profile,
          sessionId: session.sessionId,
          pruneWorktree: false,
        });
        reaped.push({
          sessionId: session.sessionId,
          profile,
          worktreePath: session.worktreePath,
          branch: session.branch,
          reason: verdict.reason,
        });
      } catch (err) {
        failures.push({ profile, sessionId: session.sessionId, detail: message(err) });
      }
    }
  }

  return { scannedProfiles: [...byProfile.keys()], reaped, adopted, skipped, failures };
}

/**
 * Register an untracked live open-PR steward into Brood so the legate manages and
 * merges it. Mirrors the legate relaunch handler's `reconcileBrood` register
 * (`src/legate/loop/handlers/relaunch.ts`): the steward row is keyed by the
 * agent-deck session id, carries its worktree/branch, and threads the spawn id
 * from Castra's session metadata as `parentId` (#308) when present so terminal
 * teardown still resolves/archives the spawn+steward group.
 */
function adoptOpenPrSteward(
  store: SessionRepository,
  session: CastraSession,
  profile: string,
  repoRoot: string | undefined,
): void {
  const spawnId = session.metadata?.spawnId;
  store.register({
    id: session.sessionId,
    kind: "steward",
    status: "running",
    agentDeckSessionId: session.sessionId,
    profile,
    ...(spawnId ? { parentId: spawnId } : {}),
    ...(repoRoot ? { repoPath: repoRoot } : {}),
    ...(session.branch ? { branch: session.branch } : {}),
    ...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
    ...(session.group ? { group: session.group } : {}),
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
