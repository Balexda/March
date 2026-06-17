import type { SessionRecord } from "../../brood/service/types.js";
import type { CastraSession } from "../../castra/types.js";
import type { DoctorContext } from "../context.js";
import type { CheckResult, Finding, Severity } from "../types.js";

/**
 * Session consistency — Castra-live vs Brood-tracked vs Herald-fold.
 *
 * Three independent views of the same stewards must agree. They drift silently:
 *  - **leaked stewards**: a Castra session with no active Brood record (relaunch
 *    re-keyed Castra but not Brood, #304) — pins the spawn cap. `march brood sweep`.
 *  - **dead orphans**: an active Brood record with no matching Castra session —
 *    the steward died but Brood still tracks it. `march brood sweep`.
 *  - **stale projection**: Herald's fold lists a session as present that Castra
 *    no longer has — the fold diverged from reality. `march legate recover`.
 *
 * This mirrors the Brood reconciler's matching (id / worktree / branch) but runs
 * entirely from the read-only service clients, so it works from a plain install.
 */

interface BroodActiveIndex {
  readonly ids: Set<string>;
  readonly worktrees: Set<string>;
  readonly branches: Set<string>;
}

/** Build the active-session index for one profile (non-torndown records only). */
function indexBroodActive(records: readonly SessionRecord[], profile: string): BroodActiveIndex {
  const ids = new Set<string>();
  const worktrees = new Set<string>();
  const branches = new Set<string>();
  for (const r of records) {
    if ((r.profile ?? "") !== profile) continue;
    if (r.status === "torndown") continue;
    if (r.id) ids.add(r.id);
    if (r.agentDeckSessionId) ids.add(r.agentDeckSessionId);
    if (r.worktreePath) worktrees.add(r.worktreePath);
    if (r.branch) branches.add(r.branch);
  }
  return { ids, worktrees, branches };
}

/** Whether a Castra session is matched to an active Brood record. */
function castraTracked(session: CastraSession, index: BroodActiveIndex): boolean {
  return (
    index.ids.has(session.sessionId) ||
    (!!session.worktreePath && index.worktrees.has(session.worktreePath)) ||
    (!!session.branch && index.branches.has(session.branch))
  );
}

export async function checkSessionConsistency(ctx: DoctorContext): Promise<CheckResult> {
  const findings: Finding[] = [];

  let broodRecords: SessionRecord[];
  try {
    broodRecords = await ctx.brood.list();
  } catch (err) {
    findings.push(serviceFinding("Brood", err));
    return { check: "session-consistency", findings };
  }

  for (const profile of ctx.profiles) {
    let castraSessions: CastraSession[];
    try {
      castraSessions = await ctx.castra.listSessions(profile.profile);
    } catch (err) {
      findings.push({
        check: "session-consistency",
        title: profile.profile,
        severity: "warn",
        detail: `could not list Castra sessions: ${errMsg(err)}`,
      });
      continue;
    }

    const index = indexBroodActive(broodRecords, profile.profile);
    const castraIds = new Set(castraSessions.map((s) => s.sessionId));
    const castraWorktrees = new Set(
      castraSessions.map((s) => s.worktreePath).filter((w): w is string => !!w),
    );

    // Leaks: Castra-live, not tracked by Brood.
    const leaks = castraSessions.filter((s) => !castraTracked(s, index));

    // Dead orphans: active Brood record with no matching Castra session.
    const orphans = broodRecords.filter(
      (r) =>
        (r.profile ?? "") === profile.profile &&
        r.status !== "torndown" &&
        r.kind === "steward" &&
        !matchesCastra(r, castraIds, castraWorktrees),
    );

    // Stale projection: Herald fold says a session is present that Castra lacks.
    let stale = 0;
    try {
      const state = await ctx.herald.state(undefined, profile.profile);
      stale = Object.values(state.sessions).filter(
        (s) => s.present && !castraIds.has(s.id),
      ).length;
    } catch {
      // Herald handled by its own check; a transient failure here just leaves
      // the stale count unknown (0) rather than failing session-consistency.
    }

    if (leaks.length === 0 && orphans.length === 0 && stale === 0) {
      findings.push({
        check: "session-consistency",
        title: profile.profile,
        severity: "pass",
        detail: `Castra/Brood/fold agree (${castraSessions.length} live session(s))`,
      });
      continue;
    }

    if (leaks.length > 0) {
      findings.push({
        check: "session-consistency",
        title: profile.profile,
        severity: "warn",
        detail: `${leaks.length} leaked steward(s) live in Castra with no active Brood record`,
        remedy: "march brood sweep",
      });
    }
    if (orphans.length > 0) {
      findings.push({
        check: "session-consistency",
        title: profile.profile,
        severity: "warn",
        detail: `${orphans.length} dead orphan(s) tracked by Brood with no live Castra session`,
        remedy: "march brood sweep",
      });
    }
    if (stale > 0) {
      findings.push({
        check: "session-consistency",
        title: profile.profile,
        severity: "warn",
        detail: `${stale} stale fold projection(s): Herald reports sessions Castra no longer has`,
        remedy: "march legate recover <sliceId>",
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      check: "session-consistency",
      title: "sessions",
      severity: "pass",
      detail: "no profiles in scope to reconcile",
    });
  }

  return { check: "session-consistency", findings };
}

function matchesCastra(
  record: SessionRecord,
  castraIds: Set<string>,
  castraWorktrees: Set<string>,
): boolean {
  if (record.id && castraIds.has(record.id)) return true;
  if (record.agentDeckSessionId && castraIds.has(record.agentDeckSessionId)) return true;
  if (record.worktreePath && castraWorktrees.has(record.worktreePath)) return true;
  return false;
}

function serviceFinding(service: string, err: unknown): Finding {
  const severity: Severity = "fail";
  return {
    check: "session-consistency",
    title: service,
    severity,
    detail: `could not reach ${service}: ${errMsg(err)}`,
    remedy: "verify the stack is up (`march status`) and the service URL env is set",
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
