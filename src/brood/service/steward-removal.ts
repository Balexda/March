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

/** A leaked Castra session reaped by {@link sweepLeakedStewards}. */
export interface SweptSession {
  readonly sessionId: string;
  readonly profile: string;
  readonly worktreePath: string;
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
  readonly failures: readonly SweepFailure[];
}

/** Resolve a steward row's worktree/branch, falling back to its parent spawn. */
function resolveStewardWorkspace(
  store: SessionRepository,
  steward: SessionRecord,
): { worktreePath?: string; branch?: string } {
  if (steward.worktreePath) {
    return { worktreePath: steward.worktreePath, branch: steward.branch };
  }
  const parent = steward.parentId ? store.get(steward.parentId) : undefined;
  return {
    worktreePath: parent?.worktreePath,
    branch: steward.branch ?? parent?.branch,
  };
}

interface ProfileLeakIndex {
  readonly ids: Set<string>;
  readonly worktrees: Set<string>;
  readonly branches: Set<string>;
}

/**
 * Reap already-leaked Castra stewards (issue #304, ask 3): sessions Brood has
 * marked `torndown` but that are still live in Castra (`waiting`/`error`) because
 * an earlier teardown removed the wrong id. Builds a per-profile index of every
 * torndown steward's id / worktree / branch from the registry, lists Castra's
 * live sessions for each profile, and removes any session that matches a torndown
 * row. Idempotent and best-effort: a profile whose Castra list fails is recorded
 * as a failure and the others still run.
 */
export async function sweepLeakedStewards(
  store: SessionRepository,
  gateway: CastraStewardGateway,
): Promise<SweepResult> {
  const torndown = store.list({ kind: "steward", status: "torndown" });

  const byProfile = new Map<string, ProfileLeakIndex>();
  for (const steward of torndown) {
    const profile = steward.profile ?? "";
    let index = byProfile.get(profile);
    if (!index) {
      index = { ids: new Set(), worktrees: new Set(), branches: new Set() };
      byProfile.set(profile, index);
    }
    if (steward.id) index.ids.add(steward.id);
    if (steward.agentDeckSessionId) index.ids.add(steward.agentDeckSessionId);
    const { worktreePath, branch } = resolveStewardWorkspace(store, steward);
    if (worktreePath) index.worktrees.add(worktreePath);
    if (branch) index.branches.add(branch);
  }

  const reaped: SweptSession[] = [];
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
      const leaked =
        index.ids.has(session.sessionId) ||
        (!!session.worktreePath && index.worktrees.has(session.worktreePath)) ||
        (!!session.branch && index.branches.has(session.branch));
      if (!leaked) continue;
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
        });
      } catch (err) {
        failures.push({ profile, sessionId: session.sessionId, detail: message(err) });
      }
    }
  }

  return { scannedProfiles: [...byProfile.keys()], reaped, failures };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
