import { describe, expect, it } from "vitest";
import {
  getActiveOtel,
  initOtel,
  otelEnabled,
  resolveOtelEndpoint,
} from "./otel.js";

describe("otel gate", () => {
  it("is disabled unless MARCH_OTEL=1", () => {
    expect(otelEnabled({})).toBe(false);
    expect(otelEnabled({ MARCH_OTEL: "0" })).toBe(false);
    expect(otelEnabled({ MARCH_OTEL: "true" })).toBe(false);
    expect(otelEnabled({ MARCH_OTEL: "1" })).toBe(true);
  });

  it("resolves the endpoint with a localhost default and strips trailing slashes", () => {
    expect(resolveOtelEndpoint({})).toBe("http://localhost:4318");
    expect(
      resolveOtelEndpoint({ MARCH_OTEL_ENDPOINT: "http://otel-lgtm:4318/" }),
    ).toBe("http://otel-lgtm:4318");
    expect(
      resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://host:4318" }),
    ).toBe("http://host:4318");
  });

  it("returns a no-op handle when disabled and never throws on shutdown", async () => {
    const handle = initOtel({});
    expect(handle.enabled).toBe(false);
    expect(getActiveOtel().enabled).toBe(false);
    // No-op tracer/meter/logger are usable without a provider.
    handle.getTracer().startSpan("noop").end();
    handle.getMeter().createCounter("noop").add(1);
    handle.getLogger().emit({ body: "noop" });
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});
