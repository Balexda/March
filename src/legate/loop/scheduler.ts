/**
 * Loop scheduler (#144) — the cadence layer of the legate loop, extracted from
 * runtime.ts. It owns *when* a tick runs, not what a tick does:
 *
 *   - the re-entrancy guard (a tick is async and can outlast the interval; an
 *     overlapping fire would double-dispatch, so it is skipped),
 *   - the interval timer + the immediate first tick on start,
 *   - the per-tick timing (lastTickAtMs / lastTickDurationMs) the HTTP /status
 *     endpoint reports.
 *
 * This is distinct from heartbeat.ts, which writes the per-tick heartbeat
 * *record*; the scheduler drives the cadence and hands timing to the metrics
 * flush. The tick body, error handling, and metrics flush are injected so the
 * scheduler is unit-testable without the runtime's I/O.
 */

export interface SchedulerDeps {
  /** Run one tick. Rejections are routed to {@link onTickError}, never thrown. */
  readonly tick: () => Promise<void>;
  /** Handle a tick failure (log it). The scheduler keeps running. */
  readonly onTickError: (err: unknown) => void;
  /** Called after each completed tick with its duration + wall-clock end (for metrics). */
  readonly onTickComplete?: (durationMs: number, tickAtMs: number) => void;
  /** Interval between ticks, in seconds (floored at 10s by {@link start}). */
  readonly intervalSeconds: number;
}

export interface LoopScheduler {
  /** Run an immediate tick, then schedule the interval. Returns a stop handle. */
  start(): { stop: () => void };
  /** Run a single tick now (subject to the re-entrancy guard). */
  runOnce(): Promise<void>;
  /** Wall-clock ms at the end of the last completed tick (0 before the first). */
  readonly lastTickAtMs: number;
  /** Duration of the last completed tick in ms (0 before the first). */
  readonly lastTickDurationMs: number;
}

export function createScheduler(deps: SchedulerDeps): LoopScheduler {
  // A tick is async and can outlast the interval (slow gh/git/castra). Overlapping
  // ticks would double-dispatch, so skip a fire while the previous is in flight.
  let ticking = false;
  let lastTickAtMs = 0;
  let lastTickDurationMs = 0;

  async function safeTick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    const startedAt = Date.now();
    try {
      await deps.tick();
    } catch (err) {
      deps.onTickError(err);
    } finally {
      ticking = false;
    }
    lastTickAtMs = Date.now();
    lastTickDurationMs = lastTickAtMs - startedAt;
    try {
      deps.onTickComplete?.(lastTickDurationMs, lastTickAtMs);
    } catch {
      // Metrics/telemetry side effects must never break the loop.
    }
  }

  return {
    start() {
      void safeTick();
      const timer = setInterval(() => void safeTick(), Math.max(10, deps.intervalSeconds) * 1000);
      return { stop: () => clearInterval(timer) };
    },
    runOnce: safeTick,
    get lastTickAtMs() {
      return lastTickAtMs;
    },
    get lastTickDurationMs() {
      return lastTickDurationMs;
    },
  };
}
