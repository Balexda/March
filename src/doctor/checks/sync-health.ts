import type { DoctorContext } from "../context.js";
import type { CheckResult, Finding } from "../types.js";

/**
 * Sync health — per-profile default branch behind origin (#299/#300).
 *
 * When the local default branch lags the remote, merged cut PRs never surface
 * to the legate and the loop stalls on work that is actually done. We compare
 * the profile repo's local default-branch SHA against `git ls-remote origin`
 * (a read-only network query — no fetch, no working-tree mutation), and name
 * `git pull` as the remedy.
 *
 * The profile's `repoPath` comes from Herald's registry. When that path isn't on
 * this host (the stack runs elsewhere) the check reports "unverified" rather than
 * a false pass — doctor talks to services, not a source checkout.
 */

export async function checkSyncHealth(ctx: DoctorContext): Promise<CheckResult> {
  const findings: Finding[] = [];

  for (const profile of ctx.profiles) {
    const repoPath = profile.repoPath;
    if (!repoPath || !ctx.pathExists(repoPath)) {
      findings.push({
        check: "sync-health",
        title: profile.profile,
        severity: "warn",
        detail: `repo ${repoPath ?? "(unset)"} is not on this host — branch sync unverified`,
      });
      continue;
    }

    // Resolve the default branch: prefer origin/HEAD, fall back to the checked-out branch.
    const originHead = ctx.git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const branch =
      (originHead?.startsWith("origin/") ? originHead.slice("origin/".length) : null) ??
      ctx.git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch || branch === "HEAD") {
      findings.push({
        check: "sync-health",
        title: profile.profile,
        severity: "warn",
        detail: "could not determine the default branch (git unavailable or detached HEAD)",
      });
      continue;
    }

    const localSha = ctx.git(repoPath, ["rev-parse", branch]);
    const remoteLine = ctx.git(repoPath, ["ls-remote", "origin", branch]);
    const remoteSha = remoteLine ? remoteLine.split(/\s+/)[0] : null;

    if (!localSha || !remoteSha) {
      findings.push({
        check: "sync-health",
        title: profile.profile,
        severity: "warn",
        detail: `could not compare ${branch} against origin (git/network error)`,
      });
      continue;
    }

    if (localSha === remoteSha) {
      findings.push({
        check: "sync-health",
        title: profile.profile,
        severity: "pass",
        detail: `${branch} is up to date with origin (${shortSha(localSha)})`,
      });
      continue;
    }

    // Local differs from remote. If local is an ancestor of remote, it is behind
    // (the #299/#300 class). Otherwise it has unpushed local commits — not a
    // sync wedge, so report it as informational.
    const behind =
      ctx.git(repoPath, ["merge-base", "--is-ancestor", localSha, remoteSha]) !== null;
    if (behind) {
      findings.push({
        check: "sync-health",
        title: profile.profile,
        severity: "warn",
        detail: `${branch} is behind origin (local ${shortSha(localSha)} ≠ origin ${shortSha(remoteSha)}) — merged work may not surface`,
        remedy: `git -C ${repoPath} pull (or set MARCH_HERALD_SYNC=1 so Herald owns the sync)`,
      });
    } else {
      findings.push({
        check: "sync-health",
        title: profile.profile,
        severity: "warn",
        detail: `${branch} has diverged from origin (local ${shortSha(localSha)}, origin ${shortSha(remoteSha)})`,
        remedy: `inspect git -C ${repoPath} status`,
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      check: "sync-health",
      title: "sync",
      severity: "pass",
      detail: "no profiles in scope to check",
    });
  }

  return { check: "sync-health", findings };
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}
