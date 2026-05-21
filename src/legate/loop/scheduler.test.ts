import { afterEach, describe, expect, it, vi } from "vitest";
import { createScheduler } from "./scheduler.js";

/** A promise plus its resolver, for holding a tick open mid-flight. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("createScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runOnce runs the tick and records timing", async () => {
    const tick = vi.fn(async () => {});
    const onTickComplete = vi.fn();
    const s = createScheduler({ tick, onTickError: vi.fn(), onTickComplete, intervalSeconds: 60 });
    expect(s.lastTickAtMs).toBe(0);
    await s.runOnce();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(s.lastTickAtMs).toBeGreaterThan(0);
    expect(onTickComplete).toHaveBeenCalledTimes(1);
  });

  it("skips an overlapping tick (re-entrancy guard)", async () => {
    const d = deferred();
    const tick = vi.fn(() => d.promise);
    const s = createScheduler({ tick, onTickError: vi.fn(), intervalSeconds: 60 });
    const first = s.runOnce();   // starts, blocks on the deferred
    await s.runOnce();           // guard active → returns immediately, no second tick
    expect(tick).toHaveBeenCalledTimes(1);
    d.resolve();
    await first;
    // Guard released: a later tick runs.
    await s.runOnce();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("routes a tick rejection to onTickError and keeps running", async () => {
    const onTickError = vi.fn();
    const tick = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const s = createScheduler({ tick, onTickError, intervalSeconds: 60 });
    await s.runOnce();
    expect(onTickError).toHaveBeenCalledWith(expect.any(Error));
    // Guard was released in finally, so the next tick still runs.
    await s.runOnce();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("start runs an immediate tick then schedules the interval; stop clears it", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {});
    const s = createScheduler({ tick, onTickError: vi.fn(), intervalSeconds: 60 });
    const handle = s.start();
    expect(tick).toHaveBeenCalledTimes(1);     // immediate
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(2);     // one interval fire
    handle.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tick).toHaveBeenCalledTimes(2);     // stopped — no more fires
  });

  it("floors the interval at 10 seconds", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {});
    const s = createScheduler({ tick, onTickError: vi.fn(), intervalSeconds: 1 });
    const handle = s.start();
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(tick).toHaveBeenCalledTimes(1);     // not yet — floor is 10s
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    handle.stop();
  });
});
