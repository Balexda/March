/**
 * Pure helpers over the agent-deck-shaped session objects the loop consumes
 * (`{id,title,name,group,status,worktree_path,...}`) and slice<->session/PR
 * matching. The worker group is passed in (it lives in `meta`) so these stay
 * pure and unit-testable.
 */

export interface WorkerSummary {
  waiting: number;
  running: number;
  idle: number;
  error: number;
  stopped: number;
  other: number;
}

export function sessionGroup(session: any): string {
  return session.group || session.group_path || "";
}

export function isWorkerSession(session: any, workerGroup: string): boolean {
  const group = sessionGroup(session);
  return group === workerGroup || group.startsWith(workerGroup + "/");
}

export function sessionMatchesSlice(session: any, slice: any): boolean {
  const sessionId = String(slice.worker_session_id || "");
  if (!sessionId) return false;
  return session.id === sessionId || session.title === sessionId || session.name === sessionId;
}

export function summarizeWorkers(
  list: any,
  workerGroup: string,
): WorkerSummary | { error: string } {
  if (!Array.isArray(list)) return { error: list?.error || "unavailable" };
  const buckets: WorkerSummary = { waiting: 0, running: 0, idle: 0, error: 0, stopped: 0, other: 0 };
  for (const session of list) {
    if (!isWorkerSession(session, workerGroup)) continue;
    const status = session.status || "other";
    if (Object.prototype.hasOwnProperty.call(buckets, status)) (buckets as any)[status] += 1;
    else buckets.other += 1;
  }
  return buckets;
}

export function workerBySessionId(list: any, workerGroup: string): Map<string, any> {
  const out = new Map<string, any>();
  if (!Array.isArray(list)) return out;
  for (const session of list) {
    if (!isWorkerSession(session, workerGroup)) continue;
    if (session.id) out.set(String(session.id), session);
    if (session.title) out.set(String(session.title), session);
    if (session.name) out.set(String(session.name), session);
  }
  return out;
}

export function prNumber(slice: any): string | null {
  const n = slice?.pr?.number;
  if (typeof n === "number" && Number.isInteger(n) && n > 0) return String(n);
  if (typeof n === "string" && /^[0-9]+$/.test(n)) return n;
  return null;
}

/** Add a branch + its feature/ and bare variants to the set. Pure. */
export function addBranchVariants(branches: Set<string>, value: unknown): void {
  const raw = String(value || "").trim();
  if (!raw) return;
  const normalized = raw.replace(/^refs\/heads\//, "");
  branches.add(normalized);
  if (normalized.startsWith("feature/")) branches.add(normalized.slice("feature/".length));
  else branches.add(`feature/${normalized}`);
}

/** Does a PR's head branch fall within the expected branch set? Pure. */
export function prMatchesBranches(branches: Set<string>, pr: any): boolean {
  if (branches.size === 0) return false;
  return branches.has(String(pr?.head_branch || pr?.headRefName || ""));
}
