import type { SessionRecord } from "../../brood/service/types.js";
import type { CastraSession } from "../../castra/types.js";
import type { DoctorContext } from "../context.js";
import type { CheckResult, Finding } from "../types.js";

/**
 * Worktree/branch hygiene — orphan worktrees a failed teardown left behind.
 *
 * Brood owns teardown by exact tracked path (never a blanket prune), so a
 * teardown that died mid-way leaves a worktree on disk with no live session.
 * We cross Brood's tracked worktree paths against the live Castra sessions: a
 * path that still EXISTS on disk but belongs to no active/live session is an
 * orphan. Doctor only diagnoses — the operator runs `march brood teardown` /
 * `march brood sweep`.
 *
 * Paths that aren't on this host (the stack runs elsewhere) can't be checked;
 * those are reported as "unverified" rather than counted as orphans.
 */

export async function checkWorktreeHygiene(ctx: DoctorContext): Promise<CheckResult> {
  const findings: Finding[] = [];

  let broodRecords: SessionRecord[];
  try {
    broodRecords = await ctx.brood.list();
  } catch (err) {
    findings.push({
      check: "worktree-hygiene",
      title: "Brood",
      severity: "fail",
      detail: `could not list Brood sessions: ${err instanceof Error ? err.message : String(err)}`,
      remedy: "verify the stack is up (`march status`) and MARCH_BROOD_URL is set",
    });
    return { check: "worktree-hygiene", findings };
  }

  for (const profile of ctx.profiles) {
    let liveWorktrees: Set<string>;
    try {
      const sessions = await ctx.castra.listSessions(profile.profile);
      liveWorktrees = new Set(
        sessions.map((s: CastraSession) => s.worktreePath).filter((w): w is string => !!w),
      );
    } catch {
      // No live view — fall back to an empty set; a tracked worktree with no
      // active Brood record and no Castra session is still an orphan candidate.
      liveWorktrees = new Set();
    }

    const records = broodRecords.filter((r) => (r.profile ?? "") === profile.profile);
    const activeWorktrees = new Set(
      records
        .filter((r) => r.status !== "torndown")
        .map((r) => r.worktreePath)
        .filter((w): w is string => !!w),
    );

    const orphans: string[] = [];
    let unverified = 0;
    const seen = new Set<string>();
    for (const r of records) {
      const wt = r.worktreePath;
      if (!wt || seen.has(wt)) continue;
      seen.add(wt);
      // A worktree backing a live Castra session or an active Brood record is
      // legitimately in use.
      if (liveWorktrees.has(wt) || activeWorktrees.has(wt)) continue;
      if (!ctx.pathExists(wt)) {
        // Already gone — clean, OR not on this host. We can't tell the two
        // apart from here, but either way it is not a leftover-on-disk orphan.
        continue;
      }
      // The path exists on disk yet belongs to no live/active session.
      if (r.status === "torndown") {
        orphans.push(`${wt} (Brood marked torndown but worktree remains)`);
      } else {
        orphans.push(`${wt} (${r.status}, no live session)`);
      }
    }

    // Count tracked-but-absent paths only to note when nothing is verifiable.
    unverified = records.filter(
      (r) => r.worktreePath && !ctx.pathExists(r.worktreePath),
    ).length;

    if (orphans.length === 0) {
      findings.push({
        check: "worktree-hygiene",
        title: profile.profile,
        severity: "pass",
        detail:
          unverified > 0
            ? `no orphan worktrees on this host (${unverified} tracked path(s) not present here)`
            : "no orphan worktrees",
      });
      continue;
    }

    findings.push({
      check: "worktree-hygiene",
      title: profile.profile,
      severity: "warn",
      detail: `${orphans.length} orphan worktree(s): ${orphans.slice(0, 3).join("; ")}${orphans.length > 3 ? "; …" : ""}`,
      remedy: "march brood sweep (or march brood teardown <id> for a specific session)",
    });
  }

  if (findings.length === 0) {
    findings.push({
      check: "worktree-hygiene",
      title: "worktrees",
      severity: "pass",
      detail: "no profiles in scope to check",
    });
  }

  return { check: "worktree-hygiene", findings };
}
