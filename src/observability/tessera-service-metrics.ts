import type { BatchObservableCallback, Meter } from "@opentelemetry/api";
import type { AccessLevel, Identity, ProviderIssueResult, TesseraErrorCode } from "../tessera/models.js";
import { getActiveOtel } from "./otel.js";

export type TesseraProviderId = `github-${Identity}`;

function createInstruments(meter: Meter) {
  return {
    issuances: meter.createCounter("march.tessera.issuances", { unit: "1" }),
    denials: meter.createCounter("march.tessera.denials", { unit: "1" }),
    mintDuration: meter.createHistogram("march.tessera.mint.duration", { unit: "ms" }),
    remaining: meter.createGauge("march.tessera.github.rate_limit_remaining", { unit: "1" }),
    expiryRemaining: meter.createObservableGauge("march.tessera.credential.expiry_remaining", { unit: "s" }),
    expiryWarning: meter.createObservableGauge("march.tessera.credential.expiry_warning", { unit: "1" }),
    secondaryLimits: meter.createCounter("march.tessera.github.secondary_limits", { unit: "1" }),
  };
}

const instrumentsByMeter = new WeakMap<Meter, ReturnType<typeof createInstruments>>();

function instruments() {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  const meter = otel.getMeter();
  let current = instrumentsByMeter.get(meter);
  if (!current) {
    current = createInstruments(meter);
    instrumentsByMeter.set(meter, current);
  }
  return current;
}

export function recordTesseraIssuance(identity: Identity, provider: TesseraProviderId, access: AccessLevel, cache: ProviderIssueResult["cache"]): void {
  instruments()?.issuances.add(1, { identity, provider, access, cache });
}

export function recordTesseraDenial(identity: Identity | undefined, reason: TesseraErrorCode): void {
  instruments()?.denials.add(1, { identity: identity ?? "unknown", reason });
}

export function recordTesseraMint(provider: TesseraProviderId, elapsedMs: number, outcome: "issued" | "failed"): void {
  instruments()?.mintDuration.record(elapsedMs, { provider, outcome });
}

export function recordTesseraRateLimit(provider: TesseraProviderId, remaining: number): void {
  instruments()?.remaining.record(remaining, { provider });
}

export function recordTesseraSecondaryLimit(provider: TesseraProviderId): void {
  instruments()?.secondaryLimits.add(1, { provider });
}

export function observeTesseraExpiry(read: () => Iterable<{
  provider: TesseraProviderId;
  secondsRemaining: number;
  warning: boolean;
}>): () => void {
  const current = instruments();
  if (!current) return () => {};
  const { expiryRemaining, expiryWarning } = current;
  const callback: BatchObservableCallback = result => {
    for (const { provider, secondsRemaining, warning } of read()) {
      result.observe(expiryRemaining, secondsRemaining, { provider });
      result.observe(expiryWarning, Number(warning), { provider });
    }
  };
  const meter = getActiveOtel().getMeter();
  const gauges = [expiryRemaining, expiryWarning];
  meter.addBatchObservableCallback(callback, gauges);
  return () => meter.removeBatchObservableCallback(callback, gauges);
}
