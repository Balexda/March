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
 * transition, append to the action log, and — on a failed spawn — cull the
 * orphaned steward it left behind. The legate no longer reclaims ghost sessions
 * for live work (Brood owns teardown, #155), retries codex spawns, or runs a
 * no-spawn direct-steward fallback — a failed spawn is escalated for judgement.
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
  /** Best-effort cull of the orphaned steward a *failed* spawn left behind.
   *
   *  A spawn that fails AFTER Castra created the manager session — most often a
   *  `launchSession` that timed out client-side, so the Hatchery's in-process
   *  rollback (`mgr && !handedOff`) never learned the session id, or a host crash
   *  that killed the Hatchery before its rollback ran — leaves a live Castra
   *  session with no useful state and no Brood record (registration runs only on
   *  success). Once the slice is escalated `hatchery_dispatch_failed`, any session
   *  still carrying this `sliceId` (or sitting on its `branch`) is provably that
   *  orphan, so the legate culls it directly via Castra (the only place it lives).
   *
   *  Resolves `{ culled, sessionId }`; `culled:false` when none matched. Absent
   *  when Castra isn't configured for this container — the `?.` call then no-ops. */
  cullStewardForSlice?: (sliceId: string, branch: string | undefined) => Promise<{ culled: boolean; sessionId?: string }>;
}
