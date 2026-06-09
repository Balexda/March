import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_CONCURRENT_SPAWNS, resolveMaxConcurrentSpawns } from "./meta.js";

describe("resolveMaxConcurrentSpawns (#313 global spawn cap config)", () => {
  it("defaults to 10 when unset", () => {
    expect(resolveMaxConcurrentSpawns({})).toBe(10);
    expect(DEFAULT_MAX_CONCURRENT_SPAWNS).toBe(10);
  });

  it("defaults to 10 when non-numeric or blank", () => {
    expect(resolveMaxConcurrentSpawns({ MARCH_MAX_CONCURRENT_SPAWNS: "lots" })).toBe(10);
    expect(resolveMaxConcurrentSpawns({ MARCH_MAX_CONCURRENT_SPAWNS: "" })).toBe(10);
  });

  it("treats 0 and negatives as misconfiguration → default 10 (never 'halt dispatch')", () => {
    expect(resolveMaxConcurrentSpawns({ MARCH_MAX_CONCURRENT_SPAWNS: "0" })).toBe(10);
    expect(resolveMaxConcurrentSpawns({ MARCH_MAX_CONCURRENT_SPAWNS: "-5" })).toBe(10);
  });

  it("honors a valid positive value (floored to an integer)", () => {
    expect(resolveMaxConcurrentSpawns({ MARCH_MAX_CONCURRENT_SPAWNS: "3" })).toBe(3);
    expect(resolveMaxConcurrentSpawns({ MARCH_MAX_CONCURRENT_SPAWNS: "25" })).toBe(25);
    expect(resolveMaxConcurrentSpawns({ MARCH_MAX_CONCURRENT_SPAWNS: "8.9" })).toBe(8);
  });
});
