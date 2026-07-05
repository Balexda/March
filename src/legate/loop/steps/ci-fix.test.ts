/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  CI_NOTIFY_ATTEMPT,
  CI_RECOVERY_DOMAIN,
  ciFixStep,
  decideCiFix,
  recordCiFixAttempt,
  resetCiFixRecovery,
} from "./ci-fix.js";
import { backoffUntil, retryAttempts } from "../pure/self-heal-pacer.js";

const NOW = 1_000_000;

describe("ci-fix step contract", () => {
  it("is a named, non-destructive leaf", () => {
    expect(ciFixStep).toEqual({ name: "ci-fix", destructive: false });
  });
});

describe("decideCiFix", () => {
  it("dispatches attempt 1 on the first failure (no prior attempt, notify false)", () => {
    expect(decideCiFix({}, "s", {}, { head_sha: "sha1" }, NOW)).toEqual({ attempt: 1, notify: false });
  });

  it("holds (null) while inside the backoff window", () => {
    const raw: any = { transient_retry_counts: { "ci-recovery:s": 1 }, ci_recovery_backoff_until: { s: NOW + 60_000 } };
    expect(decideCiFix(raw, "s", { ci_recovery_head_sha: "sha1" }, { head_sha: "sha1" }, NOW)).toBeNull();
  });

  it("bumps the attempt on a NEW failing head SHA once the window elapses", () => {
    const raw: any = { transient_retry_counts: { "ci-recovery:s": 1 }, ci_recovery_backoff_until: { s: NOW - 1 } };
    expect(decideCiFix(raw, "s", { ci_recovery_head_sha: "shaPREV" }, { head_sha: "shaNEW" }, NOW)).toEqual({ attempt: 2, notify: false });
  });

  it("re-pokes the SAME failing head SHA past the window WITHOUT burning an attempt", () => {
    const raw: any = { transient_retry_counts: { "ci-recovery:s": 2 }, ci_recovery_backoff_until: { s: NOW - 1 } };
    expect(decideCiFix(raw, "s", { ci_recovery_head_sha: "sha1" }, { head_sha: "sha1" }, NOW)).toEqual({ attempt: 2, notify: false });
  });

  it("notifies once when a genuinely-new attempt first reaches the threshold", () => {
    const raw: any = { transient_retry_counts: { "ci-recovery:s": CI_NOTIFY_ATTEMPT - 1 }, ci_recovery_backoff_until: { s: NOW - 1 } };
    const plan = decideCiFix(raw, "s", { ci_recovery_head_sha: "shaPREV" }, { head_sha: "shaNEW" }, NOW);
    expect(plan).toEqual({ attempt: CI_NOTIFY_ATTEMPT, notify: true });
  });

  it("never notifies on a same-SHA re-poke even at the threshold count", () => {
    const raw: any = { transient_retry_counts: { "ci-recovery:s": CI_NOTIFY_ATTEMPT }, ci_recovery_backoff_until: { s: NOW - 1 } };
    const plan = decideCiFix(raw, "s", { ci_recovery_head_sha: "sha1" }, { head_sha: "sha1" }, NOW);
    expect(plan).toEqual({ attempt: CI_NOTIFY_ATTEMPT, notify: false });
  });
});

describe("recordCiFixAttempt", () => {
  it("sets the durable counter, schedules a backoff window, and stamps the head SHA", () => {
    const raw: any = {};
    const slice: any = {};
    const n = recordCiFixAttempt(raw, "s", slice, "sha1", 2, NOW);
    expect(n).toBe(2);
    expect(retryAttempts(raw, CI_RECOVERY_DOMAIN, "s")).toBe(2);
    expect(backoffUntil(raw, CI_RECOVERY_DOMAIN, "s")).toBeGreaterThan(NOW);
    expect(slice.ci_recovery_head_sha).toBe("sha1");
  });

  it("floors a bad attempt at 1", () => {
    const raw: any = {};
    expect(recordCiFixAttempt(raw, "s", {}, "sha1", 0, NOW)).toBe(1);
    expect(retryAttempts(raw, CI_RECOVERY_DOMAIN, "s")).toBe(1);
  });
});

describe("resetCiFixRecovery", () => {
  it("zeros the counter, drops the window + tracked SHA, and reports it had budget", () => {
    const raw: any = { transient_retry_counts: { "ci-recovery:s": 4 }, ci_recovery_backoff_until: { s: NOW + 999 } };
    const slice: any = { ci_recovery_head_sha: "sha1" };
    expect(resetCiFixRecovery(raw, "s", slice)).toBe(true);
    expect(retryAttempts(raw, CI_RECOVERY_DOMAIN, "s")).toBe(0);
    expect(raw.ci_recovery_backoff_until.s).toBeUndefined();
    expect(slice.ci_recovery_head_sha).toBeUndefined();
  });

  it("reports false when there was no budget to clear", () => {
    expect(resetCiFixRecovery({}, "s", {})).toBe(false);
  });
});
