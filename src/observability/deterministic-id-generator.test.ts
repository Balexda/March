import { describe, expect, it } from "vitest";
import { DeterministicIdGenerator } from "./deterministic-id-generator.js";

describe("DeterministicIdGenerator", () => {
  it("generates random, well-formed ids by default", () => {
    const gen = new DeterministicIdGenerator();
    const traceId = gen.generateTraceId();
    const spanId = gen.generateSpanId();
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(gen.generateTraceId()).not.toBe(traceId);
    expect(gen.generateSpanId()).not.toBe(spanId);
  });

  it("forces the trace + span id of the span created inside withForcedIds, then reverts", () => {
    const gen = new DeterministicIdGenerator();
    const forcedTrace = "a".repeat(32);
    const forcedSpan = "b".repeat(16);

    const seen = gen.withForcedIds(forcedTrace, forcedSpan, () => ({
      traceId: gen.generateTraceId(),
      spanId: gen.generateSpanId(),
    }));
    expect(seen).toEqual({ traceId: forcedTrace, spanId: forcedSpan });

    // After the scope closes, generation is random again.
    expect(gen.generateTraceId()).not.toBe(forcedTrace);
    expect(gen.generateSpanId()).not.toBe(forcedSpan);
  });

  it("consumes each forced id exactly once", () => {
    const gen = new DeterministicIdGenerator();
    const forcedTrace = "c".repeat(32);
    const forcedSpan = "d".repeat(16);

    const ids = gen.withForcedIds(forcedTrace, forcedSpan, () => {
      const first = { traceId: gen.generateTraceId(), spanId: gen.generateSpanId() };
      const second = { traceId: gen.generateTraceId(), spanId: gen.generateSpanId() };
      return { first, second };
    });
    expect(ids.first).toEqual({ traceId: forcedTrace, spanId: forcedSpan });
    expect(ids.second.traceId).not.toBe(forcedTrace);
    expect(ids.second.spanId).not.toBe(forcedSpan);
  });

  it("never leaks forced ids onto the next span when the callback throws", () => {
    const gen = new DeterministicIdGenerator();
    expect(() =>
      gen.withForcedIds("e".repeat(32), "f".repeat(16), () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(gen.generateTraceId()).not.toBe("e".repeat(32));
    expect(gen.generateSpanId()).not.toBe("f".repeat(16));
  });
});
