import { describe, expect, it } from "vitest";
import { heraldPort, HERALD_SERVICE_NAME, resolveHeraldPort } from "./config.js";
import { broodPort } from "../brood/config.js";

describe("herald config", () => {
  it("heraldPort is deterministic and inside the 8800–9799 band", () => {
    const a = heraldPort();
    const b = heraldPort();
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(8800);
    expect(a).toBeLessThanOrEqual(9799);
  });

  it("heraldPort does not collide with broodPort", () => {
    expect(heraldPort()).not.toBe(broodPort());
  });

  it("service name is march-herald", () => {
    expect(HERALD_SERVICE_NAME).toBe("march-herald");
  });

  it("resolveHeraldPort honors an explicit override, then env, then default", () => {
    expect(resolveHeraldPort(9001)).toBe(9001);
    expect(resolveHeraldPort(undefined, { MARCH_HERALD_PORT: "9123" } as NodeJS.ProcessEnv)).toBe(9123);
    expect(resolveHeraldPort(undefined, {} as NodeJS.ProcessEnv)).toBe(heraldPort());
  });

  it("resolveHeraldPort throws on a non-numeric or out-of-range override", () => {
    expect(() => resolveHeraldPort("abc")).toThrowError(/Invalid Herald port/);
    expect(() => resolveHeraldPort(70000)).toThrowError(/Invalid Herald port/);
  });
});
