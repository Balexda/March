/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { startHeraldSpan } from "./herald-trace.js";

describe("startHeraldSpan", () => {
  it("returns a disabled no-op span when telemetry is off", () => {
    const span = startHeraldSpan({ name: "herald.pr.merged" });
    expect(span.enabled).toBe(false);
    expect(() => span.setAttributes({ "march.slice_id": "s1" })).not.toThrow();
    expect(() => span.end({ error: true, endTimeMs: Date.now() })).not.toThrow();
  });

  it("accepts a dispatchKey (slice-scoped nesting) without throwing when disabled", () => {
    const span = startHeraldSpan({
      name: "herald.pr.opened",
      dispatchKey: "my-spec-us1-forge",
      attributes: { "march.slice_id": "my-spec-us1-forge", "march.pr_number": 12 },
      startTimeMs: Date.now(),
    });
    expect(span.enabled).toBe(false);
    span.end();
  });

  it("accepts an inbound traceparent without throwing when disabled", () => {
    const span = startHeraldSpan({
      name: "herald.request",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    expect(span.enabled).toBe(false);
    span.end();
  });

  it("tolerates a malformed traceparent (no-op when disabled)", () => {
    const span = startHeraldSpan({ name: "herald.observe.failed", traceparent: "nope" });
    expect(span.enabled).toBe(false);
    expect(() => span.end()).not.toThrow();
  });
});
