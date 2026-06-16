/**
 * Shared explicit histogram bucket boundaries (SECONDS) for service request /
 * operation wall-clock latency.
 *
 * Without explicit boundaries an OTel histogram inherits the SDK defaults
 * (`[0, 5, 10, 25, … 10000]`), which are calibrated for MILLISECONDS — while
 * these `unit: "s"` metrics record SECONDS. So every sub-5s value piles into the
 * first bucket (`le=5`) and `histogram_quantile(0.95)` interpolates to a fixed
 * `0.95 × 5 = 4.75s` artifact, independent of the real latency. That false p95
 * tripped the brood `> 2s` RED alarm and blinded the herald (`> 8s`) / castra
 * (`> 15s`) ones to real sub-threshold slowness.
 *
 * This single ladder spans 5ms → 1h with resolution at each subsystem alarm
 * threshold (boundaries straddle 2s, 8s, 15s), so it fits BOTH the fast HTTP
 * APIs (brood/herald: ~ms) and the slow operations on one scale (castra agent-deck
 * launches: seconds; hatchery spawns: minutes). Keep it low-cardinality — a
 * histogram exports one series per boundary per label set.
 */
export const REQUEST_LATENCY_BUCKETS_SECONDS = [
  0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800, 3600,
];
