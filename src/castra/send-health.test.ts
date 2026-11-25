/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  deriveCastraReadiness,
  EventLoopLagMonitor,
  REFUSAL_COOLDOWN_MS,
  SEND_WINDOW_MS,
  SendTracker,
} from "./send-health.js";

describe("SendTracker", () => {
  it("keeps a refusal active for the cooldown, then drops it", () => {
    let now = 1_000;
    const tracker = new SendTracker({ now: () => now });
    tracker.recordRefusal({ profile: "march", sessionId: "s1", message: "refused" });
    expect(tracker.activeRefusal("march", "s1")?.message).toBe("refused");
    expect(tracker.activeRefusal("other", "s1")).toBeUndefined();
    expect(tracker.refusedSessionIds()).toEqual(["s1"]);
    now += REFUSAL_COOLDOWN_MS - 1;
    expect(tracker.remainingMs(tracker.activeRefusal("march", "s1")!)).toBe(1);
    now += 1;
    expect(tracker.activeRefusal("march", "s1")).toBeUndefined();
    expect(tracker.refusedSessionIds()).toEqual([]);
  });

  it("clears a refusal on demand", () => {
    const tracker = new SendTracker();
    tracker.recordRefusal({ profile: "march", sessionId: "s1", message: "refused" });
    tracker.clearRefusal("march", "s1");
    expect(tracker.refusedSessionIds()).toEqual([]);
  });

  it("clearRefusalIfBefore keeps a refusal recorded after the cutoff", () => {
    let now = 100;
    const tracker = new SendTracker({ now: () => now });
    tracker.recordRefusal({ profile: "march", sessionId: "s1", message: "old" });
    const cutoff = tracker.nowMs();
    now = 150;
    tracker.clearRefusalIfBefore("march", "s1", cutoff);
    expect(tracker.refusedSessionIds()).toEqual([]);
    // A refusal recorded during the recovery attempt is newer than its start: kept.
    tracker.recordRefusal({ profile: "march", sessionId: "s1", message: "new" });
    tracker.clearRefusalIfBefore("march", "s1", cutoff);
    expect(tracker.activeRefusal("march", "s1")?.message).toBe("new");
  });

  it("counts failed sends in the window; not_found is not a failure", () => {
    let now = 0;
    const tracker = new SendTracker({ now: () => now });
    tracker.recordSend("delivered");
    tracker.recordSend("refused");
    tracker.recordSend("refused_cached");
    tracker.recordSend("failed");
    tracker.recordSend("not_found");
    expect(tracker.recentSends()).toEqual({ total: 5, failed: 3 });
    now += SEND_WINDOW_MS + 1;
    tracker.recordSend("delivered");
    expect(tracker.recentSends()).toEqual({ total: 1, failed: 0 });
  });
});

describe("deriveCastraReadiness", () => {
  it("is ok with no lag, no refusals and no failures", () => {
    expect(
      deriveCastraReadiness({ eventLoopLagMs: 3, refusedSessions: [], recentSendFailures: 0 }),
    ).toEqual({
      ready: true,
      state: "ok",
      reasons: [],
      event_loop_lag_ms: 3,
      refused_sessions: [],
      recent_send_failures: 0,
    });
  });

  it("is degraded while a session is in refusal cooldown", () => {
    const body = deriveCastraReadiness({
      eventLoopLagMs: 3,
      refusedSessions: ["s1", "s2"],
      recentSendFailures: 2,
    });
    expect(body.state).toBe("degraded");
    expect(body.ready).toBe(true);
    expect(body.refused_sessions).toEqual(["s1", "s2"]);
    expect(body.reasons.join(" ")).toMatch(/s1, s2/);
  });

  it("is degraded when recent sends keep failing", () => {
    expect(
      deriveCastraReadiness({ eventLoopLagMs: 3, refusedSessions: [], recentSendFailures: 2 }).state,
    ).toBe("ok");
    const body = deriveCastraReadiness({ eventLoopLagMs: 3, refusedSessions: [], recentSendFailures: 3 });
    expect(body.state).toBe("degraded");
    expect(body.reasons[0]).toMatch(/3 sends failed/);
  });

  it("is down when event-loop lag p99 is over 2s, whatever else is true", () => {
    const body = deriveCastraReadiness({
      eventLoopLagMs: 14_700,
      refusedSessions: ["s1"],
      recentSendFailures: 60,
    });
    expect(body.state).toBe("down");
    expect(body.ready).toBe(false);
    expect(body.reasons[0]).toMatch(/event loop lag p99 .* 14700ms/);
    expect(
      deriveCastraReadiness({ eventLoopLagMs: 2_000, refusedSessions: [], recentSendFailures: 0 }).state,
    ).toBe("ok");
  });
});

describe("EventLoopLagMonitor", () => {
  it("reports a non-negative lag and stops cleanly", async () => {
    const monitor = new EventLoopLagMonitor(50, 1_000).start();
    await new Promise((r) => setTimeout(r, 120));
    const lag = monitor.lagP99Ms();
    expect(lag).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(lag)).toBe(true);
    monitor.stop();
  });
});
