import { getActiveOtel } from "../../observability/otel.js";
import { recordBroodReconciliation } from "../../observability/brood-metrics.js";
import type { SessionRepository } from "./repository.js";
import {
  defaultStewardGateway,
  observeReconciliation,
  type CastraStewardGateway,
} from "./steward-removal.js";

/**
 * Periodic, READ-ONLY reconciliation observer (issue #304 follow-up). Each tick
 * it compares Castra's live session list against Brood's active records per
 * profile and publishes the divergence to the `march.brood.sessions.*` gauges, so
 * "Castra has N stewards, Brood tracks 0" is a panel/alert instead of a silent
 * wedge that renders a stalled loop green.
 *
 * It NEVER reaps — the reaper is the gated `sweepLeakedStewards` / `march brood
 * sweep`; this only measures. Best-effort: a failed observation is swallowed and
 * the next tick retries; overlapping runs are skipped so a slow Castra never
 * stacks ticks. Mirrors {@link startBroodHeartbeat}: no-op (no timer) when
 * telemetry is disabled, and the interval is unref'd so it never holds the
 * process open.
 */
const RECONCILE_INTERVAL_MS = 30000;

export function startBroodReconciler(
  store: SessionRepository,
  gateway: CastraStewardGateway = defaultStewardGateway(),
  intervalMs: number = RECONCILE_INTERVAL_MS,
): () => void {
  const otel = getActiveOtel();
  if (!otel.enabled) return () => {};

  let running = false;
  const run = async (): Promise<void> => {
    if (running) return; // never overlap a slow Castra list onto the next tick
    running = true;
    try {
      const observations = await observeReconciliation(store, gateway);
      recordBroodReconciliation(observations);
    } catch {
      // Best-effort: a transient Castra/store failure must not crash the loop;
      // the gauges keep their last sample and the next tick retries.
    } finally {
      running = false;
    }
  };

  // Observe immediately so the gauges are populated before the first scrape.
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
