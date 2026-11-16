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
 * The throttle and attempt memo live on the in-memory working state
 * (`raw.dependency_merge`), like castra-recover's counters: ephemeral, rebuilt
 * on a cold start, which is a fine time to retry. No Herald transition event is
 * emitted — these PRs are not slices and change no slice state; the action log
 * (and its span) is the record.
 */

/** Minimum gap between GitHub queries for one profile (one `gh pr list` each). */
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;

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
}

export interface DependencyMergeDeps {
  /** List the repo's open Dependabot PRs. Rejects on a gh failure. */
  listDependencyPrs: (repoPath: string) => Promise<DependencyPr[]>;
  mergePr: (input: { prNumber: number | string; headSha: string; repoPath?: string }) => Promise<{
    merged: boolean;
    mergeSha?: string;
    error?: string;
  }>;
  /** Clock seam for tests. */
  now?: () => number;
}

/** Dependabot's author login as `gh` reports it (`app/dependabot`) and as the
 *  REST/GraphQL APIs do (`dependabot[bot]` / `dependabot`). */
const DEPENDABOT_LOGINS = new Set(["app/dependabot", "dependabot[bot]", "dependabot"]);

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

/** Pure: may this PR be auto-merged? `reason` names the first failed condition. */
export function dependencyPrVerdict(pr: DependencyPr): { eligible: true } | { eligible: false; reason: string } {
  const no = (reason: string) => ({ eligible: false as const, reason });
  if (!DEPENDABOT_LOGINS.has(String(pr?.author?.login || ""))) return no("not opened by Dependabot");
  if (pr.isDraft) return no("draft");
  const files = Array.isArray(pr.files) ? pr.files : [];
  if (files.length === 0) return no("changed files unknown");
  const stray = files.find((f) => !isDependencyFile(String(f?.path || "")));
  if (stray) return no(`changes a non-dependency file (${stray.path})`);
  const checks = dependencyChecks(pr.statusCheckRollup);
  if (checks !== "PASS") return no(`checks ${checks}`);
  if (String(pr.mergeable || "").toUpperCase() !== "MERGEABLE") return no(`mergeable ${pr.mergeable || "unknown"}`);
  if (String(pr.mergeStateStatus || "").toUpperCase() !== "CLEAN") return no(`merge state ${pr.mergeStateStatus || "unknown"}`);
  if (!pr.headRefOid) return no("head SHA unknown");
  return { eligible: true };
}

interface DependencyMergeMemo {
  last_checked_at?: number;
  /** PR number → head SHA already attempted. */
  attempted?: Record<string, string>;
}

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
  return res;
}
