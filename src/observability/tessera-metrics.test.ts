/**
 * @l0 @deterministic @ci
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { initOtel } from "./otel.js";
import {
  recordTesseraClientFallback,
  recordTesseraDenial,
  recordTesseraIssuance,
} from "./tessera-metrics.js";

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

describe("tessera server counters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    initOtel({});
  });

  /** Enable telemetry and capture each counter's `add` calls by instrument name. */
  function enable(): Map<string, ReturnType<typeof vi.fn>> {
    const meter = initOtel({
      MARCH_OTEL: "1",
      MARCH_OTEL_ENDPOINT: "http://localhost:4318",
    }).getMeter();
    const adds = new Map<string, ReturnType<typeof vi.fn>>();
    vi.spyOn(meter, "createCounter").mockImplementation((name: string) => {
      const add = vi.fn();
      adds.set(name, add);
      return { add } as never;
    });
    return adds;
  }

  it("is a no-op when telemetry is disabled", () => {
    initOtel({});
    expect(() =>
      recordTesseraIssuance({ identity: "app", provider: "github-app", access: "read", cache: "miss" }),
    ).not.toThrow();
    expect(() => recordTesseraDenial({ identity: null, reason: "unauthorized" })).not.toThrow();
  });

  it("counts an issuance with identity, provider, access and cache labels only", () => {
    const adds = enable();
    recordTesseraIssuance({ identity: "app", provider: "github-app", access: "write", cache: "hit" });
    recordTesseraIssuance({ identity: "user", provider: "github-user", access: "read", cache: "miss" });
    const issuances = adds.get("march.tessera.issuances")!;
    expect(issuances).toHaveBeenNthCalledWith(1, 1, {
      identity: "app",
      provider: "github-app",
      access: "write",
      cache: "hit",
    });
    expect(issuances).toHaveBeenNthCalledWith(2, 1, {
      identity: "user",
      provider: "github-user",
      access: "read",
      cache: "miss",
    });
    expect(adds.get("march.tessera.denials")).not.toHaveBeenCalled();
  });

  it("counts a denial with identity and reason labels only", () => {
    const adds = enable();
    recordTesseraDenial({ identity: "app", reason: "policy_denied" });
    recordTesseraDenial({ identity: null, reason: "unauthorized" });
    const denials = adds.get("march.tessera.denials")!;
    expect(denials).toHaveBeenNthCalledWith(1, 1, { identity: "app", reason: "policy_denied" });
    expect(denials).toHaveBeenNthCalledWith(2, 1, { identity: "none", reason: "unauthorized" });
    expect(adds.get("march.tessera.issuances")).not.toHaveBeenCalled();
  });

  it("coerces any value outside the closed sets to the one placeholder", () => {
    const adds = enable();
    recordTesseraIssuance({
      identity: "acme/widgets",
      provider: "ghs_SECRET",
      access: "admin",
      cache: "n/a",
    });
    recordTesseraDenial({ identity: "herald", reason: "tessera-key-do-not-log" });
    expect(adds.get("march.tessera.issuances")).toHaveBeenCalledWith(1, {
      identity: "none",
      provider: "none",
      access: "none",
      cache: "none",
    });
    expect(adds.get("march.tessera.denials")).toHaveBeenCalledWith(1, {
      identity: "none",
      reason: "none",
    });
  });

  it("accepts every Tessera error code as a reason", () => {
    const adds = enable();
    const codes = [
      "unauthorized",
      "policy_denied",
      "invalid_request",
      "repo_not_installed",
      "provider_unconfigured",
      "credential_invalid",
      "provider_unavailable",
      "mint_failed",
      "internal",
    ];
    for (const reason of codes) recordTesseraDenial({ identity: "app", reason });
    expect(adds.get("march.tessera.denials")!.mock.calls.map((call) => call[1].reason)).toEqual(codes);
  });

  it("leaves the client fallback counter unchanged", () => {
    const adds = enable();
    recordTesseraIssuance({ identity: "app", provider: "github-app", access: "read", cache: "miss" });
    recordTesseraClientFallback({ service: "march-herald" });
    expect(adds.get("march.tessera.client.fallbacks")).toHaveBeenCalledWith(1, {
      service: "march-herald",
    });
  });

  it("never throws when the meter fails", () => {
    const meter = initOtel({
      MARCH_OTEL: "1",
      MARCH_OTEL_ENDPOINT: "http://localhost:4318",
    }).getMeter();
    vi.spyOn(meter, "createCounter").mockImplementation(() => {
      throw new Error("meter broke");
    });
    expect(() =>
      recordTesseraIssuance({ identity: "app", provider: "github-app", access: "read", cache: "miss" }),
    ).not.toThrow();
    expect(() => recordTesseraDenial({ identity: "app", reason: "internal" })).not.toThrow();
  });
});
