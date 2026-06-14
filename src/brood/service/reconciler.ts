import { getActiveOtel } from "../../observability/otel.js";
import {
  recordBroodReconciliation,
  recordBroodReaps,
  type BroodReapOutcome,
} from "../../observability/brood-metrics.js";
import type { BroodReapConfig } from "../config.js";
import type { SessionRepository } from "./repository.js";
import {
  defaultOrphanGate,
  defaultStewardGateway,
  observeReconciliation,
  sweepLeakedStewards,
  type CastraStewardGateway,
  type OrphanGate,
  type SweepResult,
} from "./steward-removal.js";

/**
 * Periodic reconciliation for the Brood↔Castra steward leak (issue #304/#308).
 *
 * Two loops with different jobs and cadences:
 *
 *  - The READ-ONLY **observe** loop (always on when telemetry is enabled)
 *    compares Castra's live session list against Brood's active records and
 *    publishes the divergence to the `march.brood.sessions.*` gauges, so "Castra
 *    has N stewards, Brood tracks 0" is a panel/alert instead of a silent wedge.
 *
 *  - The **reap** loop (env-gated OFF by default via {@link BroodReapConfig};
 *    runs only when `reap` or `adopt` is armed) calls {@link sweepLeakedStewards}
 *    to self-heal at the source: reap dead orphans (confirmed-done + age-gated
 *    no-PR) and adopt untracked open-PR stewards into Brood so the legate
 *    manages/merges them. It emits the reconciled delta to `march.brood.reaps`.
 *
 * Both loops are best-effort (a transient failure is swallowed and the next tick
 * retries), guard against overlapping a slow Castra onto the next tick, and run
 * on `unref`'d intervals so neither holds the process open. Mirrors
 * {@link startBroodHeartbeat}: no-op (no timers) when telemetry is disabled.
 */
const OBSERVE_INTERVAL_MS = 30000;

/** Minimal logger seam — the brood Fastify logger satisfies it structurally. */
export interface ReconcilerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ReconcilerOptions {
  /** Castra gateway (defaults to the env-configured client). */
  readonly gateway?: CastraStewardGateway;
  /** Read-only observe-loop cadence (gauges). Defaults to 30s. */
  readonly intervalMs?: number;
  /** Auto-reconciler config; the reap loop runs only when `active`. */
  readonly reap?: BroodReapConfig;
  /** Orphan gate the reap loop uses (defaults to `fs` + GitHub REST). */
  readonly gate?: OrphanGate;
  /** Best-effort summary logger for the reap loop. */
  readonly logger?: ReconcilerLogger;
}

export function startBroodReconciler(
  store: SessionRepository,
  options: ReconcilerOptions = {},
): () => void {
  const otel = getActiveOtel();
  if (!otel.enabled) return () => {};

  const gateway = options.gateway ?? defaultStewardGateway();
  const stops: Array<() => void> = [];

  stops.push(startObserveLoop(store, gateway, options.intervalMs ?? OBSERVE_INTERVAL_MS));

  if (options.reap?.active) {
    stops.push(
      startReapLoop(store, gateway, options.reap, options.gate ?? defaultOrphanGate(), options.logger),
    );
  }

  return () => {
    for (const stop of stops) stop();
  };
}

/** The read-only divergence-gauge loop. */
function startObserveLoop(
  store: SessionRepository,
  gateway: CastraStewardGateway,
  intervalMs: number,
): () => void {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return; // never overlap a slow Castra list onto the next tick
    running = true;
    try {
      recordBroodReconciliation(await observeReconciliation(store, gateway));
    } catch {
      // Best-effort: a transient Castra/store failure must not crash the loop;
      // the gauges keep their last sample and the next tick retries.
    } finally {
      running = false;
    }
  };
  void run(); // populate the gauges before the first scrape
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** The env-gated self-heal loop (reap dead orphans + adopt open-PR stewards). */
function startReapLoop(
  store: SessionRepository,
  gateway: CastraStewardGateway,
  config: BroodReapConfig,
  gate: OrphanGate,
  logger?: ReconcilerLogger,
): () => void {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await sweepLeakedStewards(store, gateway, gate, {
        // Reaping (incl. dead-orphan age criterion) is gated by AUTO_REAP;
        // adoption by AUTO_ADOPT — independent flags.
        reap: config.reapEnabled,
        deadOrphanAgeMs: config.reapEnabled ? config.deadOrphanAgeMs : undefined,
        adopt: config.adoptEnabled,
      });
      recordBroodReaps(reapOutcomes(result));
      logSweep(logger, result);
    } catch (err) {
      logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "brood auto-reconciler tick failed",
      );
    } finally {
      running = false;
    }
  };
  void run(); // act on the backlog promptly rather than waiting a full interval
  const timer = setInterval(() => void run(), config.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Flatten a sweep into per-outcome metric points (one per reaped/adopted/etc.). */
export function reapOutcomes(result: SweepResult): BroodReapOutcome[] {
  return [
    ...result.reaped.map((r) => ({ outcome: "reaped" as const, reason: r.reason })),
    ...result.adopted.map(() => ({ outcome: "adopted" as const, reason: "open-pr" })),
    ...result.skipped.map((s) => ({ outcome: "skipped" as const, reason: s.reason })),
    ...result.failures.map(() => ({ outcome: "failed" as const, reason: "sweep-failed" })),
  ];
}

/** Emit a one-line summary so a reap is drillable beyond the metric. */
function logSweep(logger: ReconcilerLogger | undefined, result: SweepResult): void {
  if (!logger) return;
  const fields = {
    reaped: result.reaped.length,
    adopted: result.adopted.length,
    skipped: result.skipped.length,
    failed: result.failures.length,
    profiles: result.scannedProfiles.length,
  };
  if (result.reaped.length || result.adopted.length || result.failures.length) {
    logger.info(fields, "brood auto-reconciler tick");
  }
}
