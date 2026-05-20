import { describe, expect, it } from "vitest";
import { startBroodSpan } from "./brood-trace.js";

describe("startBroodSpan", () => {
  it("returns a disabled no-op span when telemetry is off", () => {
    const span = startBroodSpan({ name: "brood.teardown", key: "s1" });
    expect(span.enabled).toBe(false);
    expect(() => span.event("teardown.container", { outcome: "ok" })).not.toThrow();
    expect(() => span.setAttributes({ "march.session.id": "s1" })).not.toThrow();
    expect(() => span.end({ error: true })).not.toThrow();
  });

  it("accepts an inbound traceparent without throwing (no-op when disabled)", () => {
    const span = startBroodSpan({
      name: "brood.teardown",
      key: "s1",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    expect(span.enabled).toBe(false);
    span.end();
  });
});
