import { describe, expect, it } from "vitest";
import { startDispatchSpan } from "./spawn-trace.js";

describe("spawn-trace (disabled)", () => {
  it("runs the wrapped function and returns its value when telemetry is off", () => {
    const dispatch = startDispatchSpan({
      traceKey: "my-spec-us1-forge",
      rootName: "hatchery.spawn",
    });
    expect(dispatch.enabled).toBe(false);

    const result = dispatch.span("spawn.start", () => 42);
    expect(result).toBe(42);
  });

  it("runActive runs the wrapped function and returns its value when disabled", () => {
    const dispatch = startDispatchSpan({ traceKey: "k", rootName: "hatchery.spawn" });
    expect(dispatch.runActive(() => "ok")).toBe("ok");
  });

  it("propagates exceptions from the wrapped function", () => {
    const dispatch = startDispatchSpan({
      traceKey: "k",
      rootName: "hatchery.spawn",
    });
    expect(() =>
      dispatch.span("spawn.end", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });

  it("spanAsync runs the wrapped async function and returns its value when disabled", async () => {
    const dispatch = startDispatchSpan({ traceKey: "k", rootName: "hatchery.spawn" });
    await expect(
      dispatch.spanAsync("manager.launch", async () => 7),
    ).resolves.toBe(7);
  });

  it("spanAsync propagates rejections from the wrapped async function", async () => {
    const dispatch = startDispatchSpan({ traceKey: "k", rootName: "hatchery.spawn" });
    await expect(
      dispatch.spanAsync("steward.send", async () => {
        throw new Error("send boom");
      }),
    ).rejects.toThrow("send boom");
  });

  it("has no traceparent and a safe no-op end when disabled", () => {
    const dispatch = startDispatchSpan({ traceKey: "k", rootName: "r" });
    expect(dispatch.traceparent()).toBeUndefined();
    expect(() => {
      dispatch.setAttributes({ "march.task.type": "forge" });
      dispatch.recordException(new Error("x"));
      dispatch.end({ error: true });
    }).not.toThrow();
  });
});
