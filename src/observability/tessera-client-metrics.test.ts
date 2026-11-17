/** @l0 @deterministic @ci */
import { beforeEach, describe, expect, it, vi } from "vitest";
const add = vi.fn();
const createCounter = vi.fn(() => ({ add }));
const meter = { createCounter };
const state = vi.hoisted(() => ({ enabled: false }));
vi.mock("./otel.js", () => ({ getActiveOtel: () => ({ enabled: state.enabled, getMeter: () => meter }) }));
import { recordTesseraFallback, tesseraConsumerService } from "./tessera-client-metrics.js";

describe("Tessera fallback metrics", () => {
  beforeEach(() => { vi.clearAllMocks(); state.enabled = false; });
  it("does not create or record instruments when telemetry is disabled", () => {
    recordTesseraFallback("herald");
    expect(createCounter).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
  it("records the documented counter with bounded service labels when enabled", () => {
    state.enabled = true;
    recordTesseraFallback("herald"); recordTesseraFallback("secret-or-repo-name");
    expect(createCounter).toHaveBeenCalledWith("march.tessera.client.fallbacks", expect.any(Object));
    expect(add.mock.calls).toEqual([[1, { service: "herald" }], [1, { service: "unknown" }]]);
  });
  it("uses the March telemetry service setting and bounds arbitrary names", () => {
    expect(tesseraConsumerService({ MARCH_OTEL_SERVICE_NAME: "march-legate" })).toBe("legate");
    expect(tesseraConsumerService({ MARCH_OTEL_SERVICE_NAME: "arbitrary-value" })).toBe("unknown");
    expect(tesseraConsumerService({})).toBe("unknown");
  });
});
