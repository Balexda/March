import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";

/**
 * Dependency-update auto-merge. Dependabot's version-bump PRs are not Smithy
 * slices — nothing dispatches them, no steward owns them — so babysit's merge
 * gate never sees them and they pile up until a human merges each by hand. When
 * a profile opts in (`mergePolicy.dependencyUpdates.autoMerge`), this handler
 * merges the ones that are provably just a version bump with green CI.
 *
 * A PR is merged only when ALL of these hold (see {@link dependencyPrVerdict}):
 *   - it was opened by Dependabot and is not a draft;
 *   - every changed file is a dependency manifest, a lockfile, or a GitHub
 *     Actions workflow (the files Dependabot edits to bump a version);
 *   - CI has run and passed (a PR with NO checks is refused — unlike a slice PR
 *     there is no reviewer, so green CI is the only evidence it works);
 *   - GitHub reports it mergeable with a clean merge state.
 *
 * Deliberately conservative in volume: at most ONE merge per profile per check,
 * and a check at most every {@link CHECK_INTERVAL_MS}. Merging one bump usually
 * conflicts the lockfile of the others, so Dependabot must rebase them and CI
 * must re-run before they qualify again; the next check picks them up. Each
 * (PR, head SHA) is attempted once, so a failing merge is not retried every tick
 * until Dependabot pushes a new head.
 *
 * CONFLICT LADDER (#573). Bumps conflict with each other on the lockfile, so after
 * one merges the rest go CONFLICTING. Dependabot rebases its own PRs, but not a
 * branch that carries anyone else's commit (e.g. an operator `update-branch`), so
 * such a PR would be skipped forever. For each PR that is eligible but for the
 * conflict ({@link conflictedEligible}) the handler walks
 * {@link unblockDecision}: wait {@link UNBLOCK_WAIT_MS} for Dependabot's own rebase
 * (skipped when the branch has a foreign commit) → comment `@dependabot recreate`,
 * which rebuilds the branch as a pure Dependabot commit → after up to
 * {@link MAX_RECREATES} unanswered or unsuccessful recreates, escalate once by
 * adding the {@link NEEDS_HUMAN_LABEL} label plus a reason comment. The merge gate
 * above then merges the recreated PR once CI is green; the ladder never merges.
 * The recreate count is durable (a folded `retry.counted` key, see
 * {@link recreateRetryKey}); the label is the durable escalation marker; the
 * timestamps are warm-only, so a cold start just restarts a wait.
 *
 * The throttle and attempt memo live on the in-memory working state
 * (`raw.dependency_merge`), like castra-recover's counters: ephemeral, rebuilt
 * on a cold start, which is a fine time to retry. No Herald transition event is
 * emitted for merges — these PRs are not slices and change no slice state; the
 * action log (and its span) is the record. The ladder's recreate count is the one
 * exception (`retry.counted`, which adds no new event type).
 */

/** Minimum gap between GitHub queries for one profile (one `gh pr list` each). */
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** How long each rung of the conflict ladder gives Dependabot to act. */
export const UNBLOCK_WAIT_MS = 30 * 60 * 1000;

/** `@dependabot recreate` comments per PR before the ladder escalates. */
export const MAX_RECREATES = 2;

/** Label marking a Dependabot PR the legate gave up on. While present, the ladder
 *  leaves the PR alone; the merge gate still merges it once it is clean. Removing
 *  it lets the ladder escalate again if the PR stays conflicted. */
export const NEEDS_HUMAN_LABEL = "march:needs-human";

/** Prefix of the folded `retry.counted` key holding a PR's recreate count. */
export const RECREATE_RETRY_PREFIX = "dependabot-recreate:";

/** The PR fields the verdict needs — the `gh pr list --json` shape. */
export interface DependencyPr {
  number: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  author?: { login?: string; is_bot?: boolean };
  headRefOid?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: Array<{ status?: string; conclusion?: string; state?: string }>;
  files?: Array<{ path?: string }>;
  labels?: Array<{ name?: string }>;
}

export interface DependencyMergeDeps {
  /** List the repo's open Dependabot PRs. Rejects on a gh failure. */
  listDependencyPrs: (repoPath: string) => Promise<DependencyPr[]>;
  mergePr: (input: { prNumber: number | string; headSha: string; repoPath?: string }) => Promise<{
    merged: boolean;
    mergeSha?: string;
    error?: string;
  }>;
  /**
   * The conflict ladder's GitHub seams. Optional: without them the handler only
   * merges clean PRs (the pre-#573 behaviour).
   */
  /** Author logins of every commit on the PR. Rejects on a gh failure. */
  listCommitAuthors?: (repoPath: string, prNumber: number) => Promise<string[]>;
  /** Post a PR conversation comment. Rejects on a gh failure. */
  commentOnPr?: (repoPath: string, prNumber: number, body: string) => Promise<void>;
  /** Add a label to the PR, creating the label if the repo lacks it. Rejects on a gh failure. */
  labelPr?: (repoPath: string, prNumber: number, label: string) => Promise<void>;
  /** Clock seam for tests. */
  now?: () => number;
}

/** Dependabot's author login as `gh` reports it (`app/dependabot`) and as the
 *  REST/GraphQL APIs do (`dependabot[bot]` / `dependabot`). */
export const DEPENDABOT_LOGINS = new Set(["app/dependabot", "dependabot[bot]", "dependabot"]);

/**
 * Basenames Dependabot edits when bumping a version, across the ecosystems it
 * supports. Matched on the basename so a monorepo's nested manifests qualify.
 */
const DEPENDENCY_FILE_BASENAMES = new Set([
  // npm / yarn / pnpm / bun
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
  // python
  "requirements.txt", "pyproject.toml", "poetry.lock", "Pipfile", "Pipfile.lock", "uv.lock",
  // go / rust / ruby
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "Gemfile", "Gemfile.lock",
  // jvm
  "pom.xml", "build.gradle", "build.gradle.kts", "gradle.properties", "libs.versions.toml", "gradle-wrapper.properties",
  // containers
  "Dockerfile",
]);

/** True when `path` is a file a version bump legitimately touches. */
export function isDependencyFile(path: string): boolean {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return true;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return DEPENDENCY_FILE_BASENAMES.has(base) || /\.Dockerfile$/.test(base);
}

/**
 * Reduce a status-check rollup to PASS / FAIL / PENDING / NONE. A check counts
 * as passed when it concluded SUCCESS, NEUTRAL or SKIPPED; anything still
 * running is PENDING; any other conclusion fails the PR.
 */
export function dependencyChecks(rollup: DependencyPr["statusCheckRollup"]): "PASS" | "FAIL" | "PENDING" | "NONE" {
  const checks = Array.isArray(rollup) ? rollup : [];
  if (checks.length === 0) return "NONE";
  let pending = false;
  for (const c of checks) {
    // CheckRun: status + conclusion. StatusContext: state only.
    const verdict = String(c?.conclusion || c?.state || "").toUpperCase();
    const status = String(c?.status || "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(verdict)) continue;
    if (verdict === "" || verdict === "PENDING" || verdict === "EXPECTED" || (status && status !== "COMPLETED")) {
      pending = true;
      continue;
    }
    return "FAIL";
  }
  return pending ? "PENDING" : "PASS";
}

/**
 * Pure: the conditions that make a PR a plain Dependabot version bump, shared by
 * the merge verdict and the conflict ladder so the two cannot drift. Returns the
 * first failed condition, or null when the PR is a bump.
 */
function bumpShapeProblem(pr: DependencyPr): string | null {
  if (!DEPENDABOT_LOGINS.has(String(pr?.author?.login || ""))) return "not opened by Dependabot";
  if (pr.isDraft) return "draft";
  const files = Array.isArray(pr.files) ? pr.files : [];
  if (files.length === 0) return "changed files unknown";
  const stray = files.find((f) => !isDependencyFile(String(f?.path || "")));
  if (stray) return `changes a non-dependency file (${stray.path})`;
  return null;
}

/** Pure: may this PR be auto-merged? `reason` names the first failed condition. */
export function dependencyPrVerdict(pr: DependencyPr): { eligible: true } | { eligible: false; reason: string } {
  const no = (reason: string) => ({ eligible: false as const, reason });
  const shape = bumpShapeProblem(pr);
  if (shape) return no(shape);
  const checks = dependencyChecks(pr.statusCheckRollup);
  if (checks !== "PASS") return no(`checks ${checks}`);
  if (String(pr.mergeable || "").toUpperCase() !== "MERGEABLE") return no(`mergeable ${pr.mergeable || "unknown"}`);
  if (String(pr.mergeStateStatus || "").toUpperCase() !== "CLEAN") return no(`merge state ${pr.mergeStateStatus || "unknown"}`);
  if (!pr.headRefOid) return no("head SHA unknown");
  return { eligible: true };
}

/** True when GitHub reports a merge conflict. `UNKNOWN` (still computing) is not one. */
export function isConflicted(pr: DependencyPr): boolean {
  return (
    String(pr.mergeable || "").toUpperCase() === "CONFLICTING" ||
    String(pr.mergeStateStatus || "").toUpperCase() === "DIRTY"
  );
}

/**
 * Pure: is this PR a Dependabot bump that the merge gate would take but for a
 * merge conflict? CI is ignored — the checks on a conflicted head are stale, and
 * the merge gate re-checks them on the head Dependabot produces.
 */
export function conflictedEligible(pr: DependencyPr): boolean {
  return bumpShapeProblem(pr) === null && !!pr.headRefOid && isConflicted(pr);
}

export type UnblockDecision =
  | { kind: "skip" }
  | { kind: "wait" }
  | { kind: "recreate"; reason: string }
  | { kind: "escalate"; reason: string };

export interface UnblockInput {
  labels: string[];
  /** Current head SHA. */
  sha: string;
  /** When this PR was first seen conflicted at its current head (epoch ms). */
  conflictSince: number;
  /** `@dependabot recreate` comments already posted for this PR (durable). */
  recreates: number;
  /** The last recreate: the head it was posted against and when. */
  lastRecreate?: { sha: string; at: number };
  /** The branch carries a commit not authored by Dependabot. */
  foreign: boolean;
  now: number;
}

/**
 * Pure: the next rung of the conflict ladder for one conflicted, otherwise
 * eligible Dependabot PR.
 *
 *   skip     — already escalated (labelled); a human owns it until the label goes.
 *   wait     — give Dependabot time: it rebases a pure-Dependabot branch itself.
 *   recreate — comment `@dependabot recreate`: the branch has a foreign commit
 *              (Dependabot will not rebase it), or Dependabot left it conflicted
 *              for {@link UNBLOCK_WAIT_MS}.
 *   escalate — Dependabot ignored a recreate for {@link UNBLOCK_WAIT_MS}, or the
 *              PR is still conflicted after {@link MAX_RECREATES} of them.
 */
export function unblockDecision(input: UnblockInput): UnblockDecision {
  if (input.labels.includes(NEEDS_HUMAN_LABEL)) return { kind: "skip" };
  const waited = input.now - input.conflictSince >= UNBLOCK_WAIT_MS;
  const minutes = Math.round(UNBLOCK_WAIT_MS / 60_000);

  if (input.recreates === 0) {
    if (input.foreign) return { kind: "recreate", reason: "branch has commits not authored by Dependabot" };
    if (waited) return { kind: "recreate", reason: `conflicted for ${minutes} min without a Dependabot rebase` };
    return { kind: "wait" };
  }

  // A recreate was posted. If the head has not moved, Dependabot has not acted.
  const last = input.lastRecreate;
  if (!last || last.sha === input.sha) {
    if (last && input.now - last.at >= UNBLOCK_WAIT_MS) {
      return { kind: "escalate", reason: `Dependabot did not act on @dependabot recreate within ${minutes} min` };
    }
    return { kind: "wait" };
  }

  // Dependabot rebuilt the branch, but it is conflicted again.
  if (input.recreates < MAX_RECREATES) {
    if (input.foreign) return { kind: "recreate", reason: "branch has commits not authored by Dependabot" };
    if (waited) return { kind: "recreate", reason: `conflicted again for ${minutes} min after a recreate` };
    return { kind: "wait" };
  }
  if (waited) {
    return { kind: "escalate", reason: `still conflicted after ${input.recreates} @dependabot recreate attempts` };
  }
  return { kind: "wait" };
}

interface DependencyMergeMemo {
  last_checked_at?: number;
  /** PR number → head SHA already attempted. */
  attempted?: Record<string, string>;
  /** PR number → head and time it was first seen conflicted at that head. */
  conflict?: Record<string, { sha: string; since: number }>;
  /** PR number → head and time of the last `@dependabot recreate`. */
  recreate?: Record<string, { sha: string; at: number }>;
  /** `<pr>@<sha>` → the branch has a non-Dependabot commit. */
  foreign?: Record<string, boolean>;
}

/** Durable (folded) recreate-count key for a PR. */
export function recreateRetryKey(prNumber: number | string): string {
  return RECREATE_RETRY_PREFIX + prNumber;
}

function recreateCount(raw: any, prNumber: number | string): number {
  const v = raw?.transient_retry_counts?.[recreateRetryKey(prNumber)];
  return Number.isFinite(v) ? v : 0;
}

function setRecreateCount(ctx: HandlerContext, raw: any, prNumber: number | string, count: number): void {
  if (!raw.transient_retry_counts || typeof raw.transient_retry_counts !== "object") raw.transient_retry_counts = {};
  raw.transient_retry_counts[recreateRetryKey(prNumber)] = count;
  ctx.emitTransition?.({ type: "retry.counted", key: recreateRetryKey(prNumber), count });
}

const errMsg = (err: any): string => err?.message || String(err);

/** Whether the profile's merge policy opts in. */
export function enabled(state: LoopState): boolean {
  return state.mergePolicy?.dependencyUpdates?.autoMerge === true;
}

export async function apply(
  ctx: HandlerContext,
  state: LoopState,
  deps: DependencyMergeDeps | undefined,
): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  if (!deps || !enabled(state) || !state.repoPath) return res;
  if (!state.raw || typeof state.raw !== "object") return res;
  const memo: DependencyMergeMemo = (state.raw.dependency_merge ??= {});
  const now = (deps.now ?? Date.now)();
  if (memo.last_checked_at !== undefined && now - memo.last_checked_at < CHECK_INTERVAL_MS) return res;
  memo.last_checked_at = now;

  let prs: DependencyPr[];
  try {
    prs = await deps.listDependencyPrs(state.repoPath);
  } catch (err: any) {
    res.failures.push({ action: "dependency-merge-list-failed", detail: err?.message || String(err) });
    return res;
  }

  const attempted = (memo.attempted ??= {});
  // Forget PRs that are no longer open so the memo can't grow without bound.
  const open = new Set(prs.map((pr) => String(pr.number)));
  for (const key of Object.keys(attempted)) if (!open.has(key)) delete attempted[key];

  // Oldest first: the lowest PR number is the bump that has waited longest.
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    if (!dependencyPrVerdict(pr).eligible) continue;
    const sha = String(pr.headRefOid);
    if (attempted[String(pr.number)] === sha) continue;
    // Mark BEFORE awaiting so a failed attempt is not retried against the same head.
    attempted[String(pr.number)] = sha;
    let result: { merged: boolean; mergeSha?: string; error?: string };
    try {
      result = await deps.mergePr({ prNumber: pr.number, headSha: sha, repoPath: state.repoPath });
    } catch (err: any) {
      result = { merged: false, error: err?.message || String(err) };
    }
    if (result.merged) {
      res.actions.push({
        action: "dependency-auto-merge",
        pr: { number: pr.number, url: pr.url },
        detail: `squash-merged Dependabot PR #${pr.number} (${pr.title || "untitled"}, sha=${sha})`,
      });
      const recreates = recreateCount(state.raw, pr.number);
      if (recreates > 0) {
        res.actions.push({
          action: "dependency-unblock-resolved",
          pr: { number: pr.number, url: pr.url },
          detail: `Dependabot PR #${pr.number} merged after ${recreates} @dependabot recreate request(s)`,
        });
      }
    } else {
      res.failures.push({
        action: "dependency-auto-merge-failed",
        pr: { number: pr.number, url: pr.url },
        detail: `auto-merge of Dependabot PR #${pr.number} failed: ${result.error || "unknown error"}`,
      });
    }
    // One merge attempt per check: the rest need a rebase + fresh CI first.
    break;
  }

  pruneLadder(ctx, state.raw, memo, open);
  await unblockConflicted(ctx, state, deps, memo, prs, now, res);
  return res;
}

/**
 * Forget ladder state for PRs that are no longer open: drop the warm entries and
 * zero the durable recreate count (a zero count reads as "never recreated").
 */
function pruneLadder(ctx: HandlerContext, raw: any, memo: DependencyMergeMemo, open: Set<string>): void {
  for (const map of [memo.conflict, memo.recreate]) {
    if (!map) continue;
    for (const key of Object.keys(map)) if (!open.has(key)) delete map[key];
  }
  if (memo.foreign) {
    for (const key of Object.keys(memo.foreign)) if (!open.has(key.split("@")[0])) delete memo.foreign[key];
  }
  const counts = raw.transient_retry_counts;
  if (!counts || typeof counts !== "object") return;
  for (const [key, value] of Object.entries(counts)) {
    if (!key.startsWith(RECREATE_RETRY_PREFIX)) continue;
    const prNumber = key.slice(RECREATE_RETRY_PREFIX.length);
    if (!open.has(prNumber) && Number(value) > 0) setRecreateCount(ctx, raw, prNumber, 0);
  }
}

/**
 * The conflict ladder (#573): for every conflicted, otherwise eligible Dependabot
 * PR, wait for Dependabot's own rebase, then ask it to `recreate` the branch,
 * then escalate with a label + comment. A recreated branch is pure Dependabot
 * again, so the merge gate above takes it once CI is green.
 */
async function unblockConflicted(
  ctx: HandlerContext,
  state: LoopState,
  deps: DependencyMergeDeps,
  memo: DependencyMergeMemo,
  prs: DependencyPr[],
  now: number,
  res: HandlerResult,
): Promise<void> {
  if (!deps.commentOnPr || !deps.labelPr) return;
  const repoPath = state.repoPath as string;
  const conflict = (memo.conflict ??= {});
  const recreate = (memo.recreate ??= {});
  const foreignBySha = (memo.foreign ??= {});

  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const key = String(pr.number);
    if (!conflictedEligible(pr)) {
      // Healed (or no longer a candidate): restart the wait if it conflicts again.
      delete conflict[key];
      continue;
    }
    const labels = (pr.labels ?? []).map((l) => String(l?.name || ""));
    // Escalated: a human owns it. Skip before spending a GitHub call on it.
    if (labels.includes(NEEDS_HUMAN_LABEL)) continue;
    const sha = String(pr.headRefOid);
    if (conflict[key]?.sha !== sha) conflict[key] = { sha, since: now };
    const recreates = recreateCount(state.raw, pr.number);
    // Cold start: the count survived but the warm timestamp did not. Restart the
    // window from now, which only lengthens the wait.
    if (recreates > 0 && !recreate[key]) recreate[key] = { sha, at: now };

    const foreignKey = `${key}@${sha}`;
    if (foreignBySha[foreignKey] === undefined && deps.listCommitAuthors) {
      try {
        const authors = await deps.listCommitAuthors(repoPath, pr.number);
        foreignBySha[foreignKey] = authors.some((login) => !DEPENDABOT_LOGINS.has(login));
      } catch {
        // Unknown authorship is treated as pure Dependabot and not cached, so the
        // next check asks again; the wait timer still moves the ladder on.
      }
    }

    const decision = unblockDecision({
      labels,
      sha,
      conflictSince: conflict[key].since,
      recreates,
      lastRecreate: recreate[key],
      foreign: foreignBySha[foreignKey] === true,
      now,
    });
    const prRef = { number: pr.number, url: pr.url };

    if (decision.kind === "recreate") {
      try {
        await deps.commentOnPr(repoPath, pr.number, "@dependabot recreate");
      } catch (err) {
        res.failures.push({
          action: "dependency-recreate-failed",
          pr: prRef,
          detail: `could not ask Dependabot to recreate PR #${pr.number}: ${errMsg(err)}`,
        });
        continue;
      }
      recreate[key] = { sha, at: now };
      setRecreateCount(ctx, state.raw, pr.number, recreates + 1);
      res.actions.push({
        action: "dependency-recreate-requested",
        pr: prRef,
        detail:
          `asked Dependabot to recreate conflicted PR #${pr.number} ` +
          `(${decision.reason}; request ${recreates + 1}/${MAX_RECREATES}, sha=${sha})`,
      });
    } else if (decision.kind === "escalate") {
      // Label first: it is the durable "already escalated" marker, so a failed
      // comment after it does not lead to a second escalation.
      try {
        await deps.labelPr(repoPath, pr.number, NEEDS_HUMAN_LABEL);
      } catch (err) {
        res.failures.push({
          action: "dependency-unblock-escalate-failed",
          pr: prRef,
          detail: `could not label conflicted Dependabot PR #${pr.number} for escalation: ${errMsg(err)}`,
        });
        continue;
      }
      let commentNote = "";
      try {
        await deps.commentOnPr(repoPath, pr.number, escalationComment(decision.reason));
      } catch (err) {
        commentNote = `; reason comment failed: ${errMsg(err)}`;
      }
      res.failures.push({
        action: "dependency-unblock-escalated",
        pr: prRef,
        detail: `escalated conflicted Dependabot PR #${pr.number} (${decision.reason})${commentNote}`,
      });
    }
  }
}

function escalationComment(reason: string): string {
  return (
    `March legate could not unblock this Dependabot PR automatically: ${reason}.\n\n` +
    `Resolve the merge conflict or close the PR. Once it is conflict-free with green CI, ` +
    `the legate merges it as usual. While the \`${NEEDS_HUMAN_LABEL}\` label is present ` +
    `the legate will not comment on this PR again.`
  );
}
