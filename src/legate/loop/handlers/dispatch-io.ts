/**
 * Injected I/O seams for the dispatch ops (#144 phase 3).
 *
 * The dispatch handler ({@link ./dispatch.ts}) declares the high-level
 * `DispatchDeps` it needs (completePending / launchDispatch). The bodies live in
 * {@link ./dispatch-ops.ts} and reach the outside world only through this single,
 * faked-in-tests surface, so the dispatch flow is unit testable. runtime.ts
 * builds the concrete deps and wires them.
 *
 * This is deliberately small. The legate's job is to *ask services to act* and
 * *record the transition* — not to perform recovery surgery. So the only outward
 * calls here are: POST a spawn to Hatchery, poll a Hatchery job, append a Herald
 * transition, and append to the action log. The legate no longer reclaims ghost
 * sessions (Brood owns teardown, #155), retries codex spawns, or runs a no-spawn
 * direct-steward fallback — a failed spawn is escalated for judgement instead.
 */
export interface DispatchIoDeps {
  /** Loaded loop meta (profile, repo, worker_group, names). */
  meta: any;
  /** Append a Herald transition event — the sole durable record of a transition
   *  now that state.json is retired (#176). Fire-and-forget on the runtime side. */
  emitTransition: (event: any) => void;
  /** Append an action/event record to the processor action log (drives the OTel
   *  span/log side-effects in runtime.ts). */
  emit: (event: any) => void;
  /** Append a human-readable line to the processor log. */
  log: (line: string) => void;
  /** Hatchery service client, pre-bound to the resolved base URL. POSTs a spawn
   *  request and resolves to the created job (its `id` is polled by getJob). */
  postSpawn: (request: any) => Promise<{ id?: string }>;
  /** Poll a Hatchery job by id; resolves to the job (status/result/error). */
  getJob: (jobId: string) => Promise<any>;
  /**
   * Discover the slice's own open PR via the shared sense I/O (branch-variant
   * matched, identical to Herald/babysit). Used by the #173 branch-collision
   * adopt path: when a re-dispatch hits a branch that already has this slice's
   * open PR, the legate adopts the PR instead of escalating. Returns the
   * babysit-shaped PR snapshot, or null when no matching open PR exists.
   */
  discoverPr: (slice: any, state: any, sessionId?: string) => Promise<any>;
}
