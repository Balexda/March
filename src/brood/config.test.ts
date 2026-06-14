/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  broodPort,
  BROOD_SERVICE_NAME,
  resolveBroodPort,
  resolveBroodStoreBackend,
  resolveReapConfig,
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

describe("resolveReapConfig", () => {
  it("defaults both flags OFF (inactive), 5-min cadence, 24-h dead-orphan age", () => {
    const c = resolveReapConfig({});
    expect(c.reapEnabled).toBe(false);
    expect(c.adoptEnabled).toBe(false);
    expect(c.active).toBe(false);
    expect(c.intervalMs).toBe(300_000);
    expect(c.deadOrphanAgeMs).toBe(24 * 3_600_000);
  });

  it("treats the two flags independently and derives `active` from either", () => {
    expect(resolveReapConfig({ MARCH_BROOD_AUTO_REAP: "1" })).toMatchObject({
      reapEnabled: true,
      adoptEnabled: false,
      active: true,
    });
    expect(resolveReapConfig({ MARCH_BROOD_AUTO_ADOPT: "1" })).toMatchObject({
      reapEnabled: false,
      adoptEnabled: true,
      active: true,
    });
    expect(
      resolveReapConfig({ MARCH_BROOD_AUTO_REAP: "1", MARCH_BROOD_AUTO_ADOPT: "1" }),
    ).toMatchObject({ reapEnabled: true, adoptEnabled: true, active: true });
  });

  it("only the exact value \"1\" arms a flag", () => {
    expect(resolveReapConfig({ MARCH_BROOD_AUTO_REAP: "true" }).reapEnabled).toBe(false);
    expect(resolveReapConfig({ MARCH_BROOD_AUTO_REAP: "0" }).reapEnabled).toBe(false);
    expect(resolveReapConfig({ MARCH_BROOD_AUTO_REAP: " 1 " }).reapEnabled).toBe(true);
  });

  it("honors interval + dead-orphan-age overrides", () => {
    const c = resolveReapConfig({
      MARCH_BROOD_AUTO_REAP_INTERVAL_MS: "60000",
      MARCH_BROOD_DEAD_ORPHAN_AGE_HOURS: "48",
    });
    expect(c.intervalMs).toBe(60_000);
    expect(c.deadOrphanAgeMs).toBe(48 * 3_600_000);
  });

  it("throws on a non-positive / non-numeric override (fail fast)", () => {
    expect(() =>
      resolveReapConfig({ MARCH_BROOD_AUTO_REAP_INTERVAL_MS: "0" }),
    ).toThrowError(/MARCH_BROOD_AUTO_REAP_INTERVAL_MS/);
    expect(() =>
      resolveReapConfig({ MARCH_BROOD_DEAD_ORPHAN_AGE_HOURS: "abc" }),
    ).toThrowError(/MARCH_BROOD_DEAD_ORPHAN_AGE_HOURS/);
  });
});
