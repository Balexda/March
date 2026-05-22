import { describe, expect, it } from "vitest";
import { startHeraldSpan } from "./herald-trace.js";

describe("startHeraldSpan", () => {
  it("returns a disabled no-op span when telemetry is off", () => {
    const span = startHeraldSpan({ name: "herald.request" });
    expect(span.enabled).toBe(false);
    expect(() => span.setAttributes({ "http.status_code": 200 })).not.toThrow();
    expect(() => span.end({ error: true })).not.toThrow();
  });

  it("accepts an inbound traceparent without throwing (no-op when disabled)", () => {
    const span = startHeraldSpan({
      name: "herald.request",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      attributes: { "http.route": "/events", "http.method": "GET" },
    });
    expect(span.enabled).toBe(false);
    span.end();
  });

  it("tolerates a malformed traceparent (no-op when disabled)", () => {
    const span = startHeraldSpan({ name: "herald.observe", traceparent: "not-a-traceparent" });
    expect(span.enabled).toBe(false);
    expect(() => span.end()).not.toThrow();
  });
});
