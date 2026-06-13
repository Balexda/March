/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  broodPort,
  BROOD_SERVICE_NAME,
  resolveBroodPort,
  resolveBroodStoreBackend,
} from "./config.js";

describe("brood config", () => {
  it("broodPort is deterministic and inside the 8800–9799 band", () => {
    const a = broodPort();
    const b = broodPort();
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(8800);
    expect(a).toBeLessThanOrEqual(9799);
  });

  it("service name is march-brood", () => {
    expect(BROOD_SERVICE_NAME).toBe("march-brood");
  });

  it("resolveBroodPort honors an explicit override, then env, then default", () => {
    expect(resolveBroodPort(9001)).toBe(9001);
    expect(resolveBroodPort(undefined, { MARCH_BROOD_PORT: "9123" })).toBe(9123);
    expect(resolveBroodPort(undefined, {})).toBe(broodPort());
  });

  it("resolveBroodPort throws on a non-numeric or out-of-range override", () => {
    expect(() => resolveBroodPort("abc")).toThrowError(/Invalid Brood port/);
    expect(() => resolveBroodPort(70000)).toThrowError(/Invalid Brood port/);
  });

  it("resolveBroodStoreBackend defaults to sqlite, honors env, is case-insensitive", () => {
    expect(resolveBroodStoreBackend({})).toBe("sqlite");
    expect(resolveBroodStoreBackend({ MARCH_BROOD_STORE: "sqlite" })).toBe(
      "sqlite",
    );
    expect(resolveBroodStoreBackend({ MARCH_BROOD_STORE: "POSTGRES" })).toBe(
      "postgres",
    );
  });

  it("resolveBroodStoreBackend throws on an unrecognized backend", () => {
    expect(() =>
      resolveBroodStoreBackend({ MARCH_BROOD_STORE: "mysql" }),
    ).toThrowError(/Invalid MARCH_BROOD_STORE/);
  });
});
