import { execFileSync } from "node:child_process";

/**
 * Safety classification for a branch that a Hatchery spawn collided with at
 * `manager.launch` ("branch already exists"). Mirrors the `legate.unwedge`
 * skill's validator (`clean-stale-branch.sh`) so the autonomous self-heal (#243)
 * applies the SAME refuse/allow contract an operator would: never delete a
 * branch with an open PR (that is #173's "adopt the PR" path), and never delete
 * diverged unmerged work. A branch is safe to remove only when it is an orphan
 * ref (its HEAD is an ancestor of the default branch — no unique commits) or a
 * post-merge-stale leftover (its PR already merged).
 */
export type BranchSafetyVerdict =
  | { readonly kind: "absent" }
  | {
      readonly kind: "safe";
      readonly reason: "orphan-ref" | "post-merge-stale";
      readonly detail?: string;
    }
  | {
      readonly kind: "unsafe";
      readonly reason: "open-pr" | "diverged" | "pr-lookup-unknown";
      readonly detail?: string;
    };

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
}

/**
 * Runs a child process and reports its exit code + stdout (never throws). The
 * classifier branches on exit codes (`git merge-base --is-ancestor`,
 * `gh pr list`), so a non-zero exit is data, not an error. Injectable so the
 * classification logic is unit-testable without a real git repo / `gh`.
 */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  cwd: string,
) => CommandResult;

const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

const defaultRunner: CommandRunner = (file, args, cwd) => {
  try {
    const stdout = execFileSync(file, args as string[], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: EXEC_MAX_BUFFER,
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string };
    const stdout = Buffer.isBuffer(e.stdout)
      ? e.stdout.toString("utf-8")
      : typeof e.stdout === "string"
        ? e.stdout
        : "";
    return { code: typeof e.status === "number" ? e.status : 1, stdout };
  }
};

interface PrRecord {
  readonly number?: number;
  readonly state?: string;
}

/**
 * Classify whether `branch` is safe to delete autonomously. Re-implements the
 * `clean-stale-branch.sh` validator in TypeScript so the Hatchery self-heal can
 * call it in-process. The verdict ladder (refuse > safe), in order:
 *   1. branch absent          -> `absent` (nothing to do)
 *   2. PR list unknown        -> `unsafe:pr-lookup-unknown` (a hidden open PR
 *      might exist; refuse rather than guess)
 *   3. open PR on the branch  -> `unsafe:open-pr` (this is #173's adopt path)
 *   4. ancestor of default    -> `safe:orphan-ref` (no unique commits)
 *   5. merged PR on the branch -> `safe:post-merge-stale`
 *   6. otherwise              -> `unsafe:diverged` (unmerged unique work)
 */
export function classifyBranchSafety(
  repoRoot: string,
  branch: string,
  run: CommandRunner = defaultRunner,
): BranchSafetyVerdict {
  if (
    run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot)
      .code !== 0
  ) {
    return { kind: "absent" };
  }

  let defaultBranch = run(
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    repoRoot,
  )
    .stdout.trim()
    .replace(/^origin\//, "");
  if (!defaultBranch) {
    defaultBranch = run(
      "gh",
      ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
      repoRoot,
    ).stdout.trim();
  }

  const isAncestor =
    defaultBranch.length > 0 &&
    run("git", ["merge-base", "--is-ancestor", branch, defaultBranch], repoRoot)
      .code === 0;

  const prCall = run(
    "gh",
    ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state"],
    repoRoot,
  );
  let prsKnown = prCall.code === 0;
  let prs: PrRecord[] = [];
  if (prsKnown) {
    const raw = prCall.stdout.trim();
    try {
      prs = raw ? (JSON.parse(raw) as PrRecord[]) : [];
    } catch {
      prs = [];
      prsKnown = false;
    }
  }
  const openPrs = prs.filter((p) => p.state === "OPEN");
  const mergedPrs = prs.filter((p) => p.state === "MERGED");

  // A gh failure must NOT fall through as "no PRs" — an ancestor-of-default
  // branch could still have an open PR we couldn't see. Refuse the safe verdicts.
  if (!prsKnown) return { kind: "unsafe", reason: "pr-lookup-unknown" };
  if (openPrs.length > 0) {
    return {
      kind: "unsafe",
      reason: "open-pr",
      detail: openPrs.map((p) => "#" + p.number).join(","),
    };
  }
  if (isAncestor) return { kind: "safe", reason: "orphan-ref" };
  if (mergedPrs.length > 0) {
    return {
      kind: "safe",
      reason: "post-merge-stale",
      detail: mergedPrs.map((p) => "#" + p.number).join(","),
    };
  }
  return { kind: "unsafe", reason: "diverged" };
}

/**
 * The exact checkout path git records for the worktree currently holding
 * `branch`, or `undefined` when no worktree has it checked out. Read from
 * `git worktree list --porcelain` (git's own records) so the path is EXACT —
 * the self-heal removes only this one path and never runs a blanket
 * `git worktree prune` (#155). The worktree must be removed before
 * `git branch -D`, which refuses a branch checked out in a worktree.
 */
export function findWorktreePathForBranch(
  repoRoot: string,
  branch: string,
  run: CommandRunner = defaultRunner,
): string | undefined {
  const res = run("git", ["worktree", "list", "--porcelain"], repoRoot);
  if (res.code !== 0) return undefined;
  let currentPath: string | undefined;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      if (ref === `refs/heads/${branch}` && currentPath) return currentPath;
    } else if (line.trim() === "") {
      currentPath = undefined;
    }
  }
  return undefined;
}

/** Bounded label for the `march.self_heal.verdict` span attribute (no PR ids). */
export function verdictLabel(verdict: BranchSafetyVerdict): string {
  return verdict.kind === "absent"
    ? "absent"
    : `${verdict.kind}:${verdict.reason}`;
}

/** Human-readable verdict (with PR ids) for log bodies + escalation messages. */
export function describeVerdict(verdict: BranchSafetyVerdict): string {
  switch (verdict.kind) {
    case "absent":
      return "branch no longer exists";
    case "safe":
      return verdict.detail
        ? `safe to remove (${verdict.reason}: ${verdict.detail})`
        : `safe to remove (${verdict.reason})`;
    case "unsafe":
      return verdict.detail
        ? `unsafe to remove (${verdict.reason}: ${verdict.detail})`
        : `unsafe to remove (${verdict.reason})`;
  }
}
