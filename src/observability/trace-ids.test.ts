/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  buildTraceparent,
  randomSpanId,
  spanIdForDispatch,
  traceIdForDispatch,
} from "./trace-ids.js";

describe("trace-ids", () => {
  it("derives a stable 32-hex trace id from a dispatch key", () => {
    const id = traceIdForDispatch("my-spec-us1-forge");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIdForDispatch("my-spec-us1-forge")).toBe(id);
  });

  it("gives different traces to different dispatches (no cross-task grouping)", () => {
    // render/mark/cut/forge of the same work item must NOT share a trace.
    expect(traceIdForDispatch("my-spec-us1-forge")).not.toBe(
      traceIdForDispatch("my-spec-us1-cut"),
    );
    expect(traceIdForDispatch("a")).not.toBe(traceIdForDispatch("b"));
  });

  it("never produces an all-zero trace id", () => {
    expect(traceIdForDispatch("forge x s1")).not.toBe("0".repeat(32));
  });

  it("derives a stable 16-hex span id from a dispatch key", () => {
    const id = spanIdForDispatch("my-spec-us1-forge");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(spanIdForDispatch("my-spec-us1-forge")).toBe(id);
  });

  it("randomSpanId produces fresh 16-hex ids", () => {
    expect(randomSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(randomSpanId()).not.toBe(randomSpanId());
  });

  it("builds a W3C traceparent (version 00, sampled)", () => {
    const traceId = "a".repeat(32);
    const spanId = "b".repeat(16);
    expect(buildTraceparent(traceId, spanId)).toBe(`00-${traceId}-${spanId}-01`);
  });
});
