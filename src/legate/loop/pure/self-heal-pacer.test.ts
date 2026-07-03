/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  backoffUntil,
  clearBackoff,
  coolingDown,
  retryAttempts,
  scheduleBackoff,
  setRetryAttempts,
  type RetryDomain,
} from "./self-heal-pacer.js";
import { backoffMs } from "./self-heal.js";

const DOMAIN: RetryDomain = { retryKey: (s) => "test-recovery:" + s, backoffField: "test_backoff_until" };
const NOW = 1_000_000;

describe("self-heal pacer", () => {
  it("reads 0 attempts / 0 window on an empty raw", () => {
    expect(retryAttempts({}, DOMAIN, "s")).toBe(0);
    expect(backoffUntil({}, DOMAIN, "s")).toBe(0);
    expect(coolingDown({}, DOMAIN, "s", NOW)).toBe(false);
  });

  it("setRetryAttempts writes under the domain's key and reads back", () => {
    const raw: any = {};
    setRetryAttempts(raw, DOMAIN, "s", 3);
    expect(raw.transient_retry_counts["test-recovery:s"]).toBe(3);
    expect(retryAttempts(raw, DOMAIN, "s")).toBe(3);
    // A different domain's key is untouched.
    expect(retryAttempts(raw, { retryKey: (s) => "other:" + s, backoffField: "x" }, "s")).toBe(0);
  });

  it("scheduleBackoff writes now + backoffMs(attempt, slice) into the domain field", () => {
    const raw: any = {};
    scheduleBackoff(raw, DOMAIN, "s", 2, NOW);
    expect(raw.test_backoff_until.s).toBe(NOW + backoffMs(2, "s"));
    expect(backoffUntil(raw, DOMAIN, "s")).toBe(NOW + backoffMs(2, "s"));
  });

  it("scheduleBackoff is a no-op for a non-finite now (can't gate on a non-date tick)", () => {
    const raw: any = {};
    scheduleBackoff(raw, DOMAIN, "s", 2, NaN);
    expect(raw.test_backoff_until).toBeUndefined();
  });

  it("scheduleBackoff floors the attempt at 1 so a 0/None attempt still doubles from base", () => {
    const raw: any = {};
    scheduleBackoff(raw, DOMAIN, "s", 0, NOW);
    expect(raw.test_backoff_until.s).toBe(NOW + backoffMs(1, "s"));
  });

  it("clearBackoff drops just the one slice's window", () => {
    const raw: any = { test_backoff_until: { s: 42, t: 99 } };
    clearBackoff(raw, DOMAIN, "s");
    expect(raw.test_backoff_until.s).toBeUndefined();
    expect(raw.test_backoff_until.t).toBe(99);
  });

  it("coolingDown holds only when a prior attempt exists AND now is before the window", () => {
    const raw: any = {};
    setRetryAttempts(raw, DOMAIN, "s", 1);
    scheduleBackoff(raw, DOMAIN, "s", 1, NOW);
    const until = backoffUntil(raw, DOMAIN, "s");
    expect(coolingDown(raw, DOMAIN, "s", until - 1)).toBe(true); // inside the window
    expect(coolingDown(raw, DOMAIN, "s", until + 1)).toBe(false); // window elapsed
  });

  it("coolingDown is false on the first failure (no prior attempt → fix goes out immediately)", () => {
    const raw: any = { test_backoff_until: { s: NOW + 999999 } };
    expect(retryAttempts(raw, DOMAIN, "s")).toBe(0);
    expect(coolingDown(raw, DOMAIN, "s", NOW)).toBe(false);
  });
});
