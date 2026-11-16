import type { Counter, Meter } from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";

/**
 * Consumer-side Tessera metrics, emitted by the Node client inside whichever
 * service calls it (contracts "Events"). Instruments are created lazily on the
 * active meter; every function is a complete no-op when telemetry is off and
 * never throws into the caller.
 */

export interface RecordTesseraClientFallbackInput {
  /** The calling service (low-cardinality); the only label. */
  readonly service: string;
}

let cachedMeter: Meter | undefined;
let fallbacksCounter: Counter | undefined;

function fallbacks(meter: Meter): Counter {
  if (meter !== cachedMeter || fallbacksCounter === undefined) {
    fallbacksCounter = meter.createCounter("march.tessera.client.fallbacks", {
      description:
        "Count of GitHub tokens served from GH_TOKEN/GITHUB_TOKEN because Tessera could not issue (migration fallback)",
      unit: "1",
    });
    cachedMeter = meter;
  }
  return fallbacksCounter;
}

/** Count one `env-fallback` result, labelled only by `service`. */
export function recordTesseraClientFallback(input: RecordTesseraClientFallbackInput): void {
  try {
    const otel = getActiveOtel();
    if (!otel.enabled) return;
    fallbacks(otel.getMeter()).add(1, { service: input.service });
  } catch {
    // Telemetry must never break the token call.
  }
}
