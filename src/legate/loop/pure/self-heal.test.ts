/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  backoffMs,
  jitterFraction,
  parseMs,
  readRecoveryRate,
  stepRecoveryRate,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  RECOVERY_RATE_MAX,
  RECOVERY_RATE_MIN,
} from "./self-heal.js";

describe("self-heal backoff", () => {
  it("doubles per attempt and stays within [BASE, MAX·(1+JITTER)]", () => {
    const id = "slice-x";
    const a1 = backoffMs(1, id);
    const a2 = backoffMs(2, id);
    const a3 = backoffMs(3, id);
    expect(a1).toBeGreaterThanOrEqual(BACKOFF_BASE_MS);
    expect(a2).toBeGreaterThan(a1);
    expect(a3).toBeGreaterThan(a2);
    // 2^(n-1) doubling, modulo the (stable, per-id) jitter multiplier.
    expect(a2 / a1).toBeCloseTo(2, 5);
  });

  it("plateaus at the MAX ceiling and never overflows for huge attempts", () => {
    const big = backoffMs(1000, "slice-y");
    expect(Number.isFinite(big)).toBe(true);
    // capped at MAX before jitter → at most MAX·(1+20%).
    expect(big).toBeLessThanOrEqual(Math.round(BACKOFF_MAX_MS * 1.2));
    expect(big).toBeGreaterThanOrEqual(BACKOFF_MAX_MS);
  });

  it("jitter is deterministic per id and de-correlates different ids", () => {
    expect(jitterFraction("a")).toBe(jitterFraction("a"));
    expect(jitterFraction("a")).not.toBe(jitterFraction("b"));
    expect(jitterFraction("a")).toBeGreaterThanOrEqual(0);
    expect(jitterFraction("a")).toBeLessThan(1);
  });
});

describe("self-heal AIMD rate", () => {
  it("reads a per-field scalar clamped to [MIN, MAX], defaulting to MIN", () => {
    expect(readRecoveryRate({}, "recovery_rate")).toBe(RECOVERY_RATE_MIN);
    expect(readRecoveryRate({ r: 99 }, "r")).toBe(RECOVERY_RATE_MAX);
    expect(readRecoveryRate({ r: 0 }, "r")).toBe(RECOVERY_RATE_MIN);
    expect(readRecoveryRate({ r: 3 }, "r")).toBe(3);
    // distinct fields are independent
    expect(readRecoveryRate({ a: 5, b: 2 }, "a")).toBe(5);
    expect(readRecoveryRate({ a: 5, b: 2 }, "b")).toBe(2);
  });

  it("halves on any failure (floored at MIN)", () => {
    expect(stepRecoveryRate(8, { failures: 1, rateLimited: true })).toBe(4);
    expect(stepRecoveryRate(2, { failures: 3, rateLimited: false })).toBe(1);
    expect(stepRecoveryRate(1, { failures: 1, rateLimited: false })).toBe(RECOVERY_RATE_MIN);
  });

  it("adds 1 only on a clean rate-limited sweep (capped at MAX)", () => {
    expect(stepRecoveryRate(3, { failures: 0, rateLimited: true })).toBe(4);
    expect(stepRecoveryRate(RECOVERY_RATE_MAX, { failures: 0, rateLimited: true })).toBe(RECOVERY_RATE_MAX);
    // clean but NOT rate-limited holds steady (no need to grow)
    expect(stepRecoveryRate(3, { failures: 0, rateLimited: false })).toBe(3);
  });
});

describe("parseMs", () => {
  it("parses ISO strings and returns NaN for non-dates", () => {
    expect(parseMs("2026-06-28T00:00:00.000Z")).toBe(Date.parse("2026-06-28T00:00:00.000Z"));
    expect(Number.isNaN(parseMs("T"))).toBe(true);
    expect(Number.isNaN(parseMs(undefined))).toBe(true);
    expect(Number.isNaN(parseMs(123))).toBe(true);
  });
});
