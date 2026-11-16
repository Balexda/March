/**
 * @l0 @deterministic @ci
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { initOtel } from "./otel.js";
import { recordTesseraClientFallback } from "./tessera-metrics.js";

describe("tessera-metrics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    initOtel({});
  });

  it("is a no-op when telemetry is disabled", () => {
    initOtel({});
    expect(() => recordTesseraClientFallback({ service: "march-herald" })).not.toThrow();
  });

  it("counts a fallback with only the service label when telemetry is enabled", () => {
    const meter = initOtel({
      MARCH_OTEL: "1",
      MARCH_OTEL_ENDPOINT: "http://localhost:4318",
    }).getMeter();
    const add = vi.fn();
    const createCounter = vi.spyOn(meter, "createCounter").mockReturnValue({ add } as never);

    recordTesseraClientFallback({ service: "march-herald" });
    recordTesseraClientFallback({ service: "march-brood" });

    expect(createCounter).toHaveBeenCalledTimes(1);
    expect(createCounter.mock.calls[0]?.[0]).toBe("march.tessera.client.fallbacks");
    expect(add).toHaveBeenNthCalledWith(1, 1, { service: "march-herald" });
    expect(add).toHaveBeenNthCalledWith(2, 1, { service: "march-brood" });
  });

  it("never throws when the meter fails", () => {
    const meter = initOtel({
      MARCH_OTEL: "1",
      MARCH_OTEL_ENDPOINT: "http://localhost:4318",
    }).getMeter();
    vi.spyOn(meter, "createCounter").mockImplementation(() => {
      throw new Error("meter broke");
    });
    expect(() => recordTesseraClientFallback({ service: "march-herald" })).not.toThrow();
  });
});
