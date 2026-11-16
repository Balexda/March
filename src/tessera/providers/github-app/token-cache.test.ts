/**
 * @l1 @deterministic @ci
 *
 * The in-memory installation-token cache: key separation, the ten-minute
 * re-mint threshold, expiry and whole-cache clearing, on an injected clock.
 */
import { describe, expect, it } from "vitest";
import { createTokenCache, REMINT_THRESHOLD_MS, type TokenCacheKey } from "./token-cache.js";

const T0 = Date.parse("2026-11-15T12:00:00Z");
const MINUTE = 60 * 1000;

function clock(start = T0) {
  let t = start;
  return { now: () => t, set: (ms: number) => { t = ms; } };
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const KEY: TokenCacheKey = { installationId: 7, repos: ["acme/widgets"], access: "read" };
const ENTRY = { token: "ghs_one", expiresAt: iso(T0 + 60 * MINUTE) };

describe("token cache", () => {
  it("uses a ten-minute re-mint threshold", () => {
    expect(REMINT_THRESHOLD_MS).toBe(10 * MINUTE);
  });

  it("returns a fresh entry while strictly more than ten minutes remain", () => {
    const c = clock();
    const cache = createTokenCache({ now: c.now });
    expect(cache.getFresh(KEY)).toBeUndefined();
    cache.set(KEY, ENTRY);
    expect(cache.getFresh(KEY)).toEqual(ENTRY);
    expect(cache.size()).toBe(1);

    c.set(T0 + 50 * MINUTE - 1);
    expect(cache.getFresh(KEY)).toEqual(ENTRY);
    c.set(T0 + 50 * MINUTE);
    expect(cache.getFresh(KEY)).toBeUndefined();
  });

  it("keeps a stale entry available as unexpired until it expires, then drops it", () => {
    const c = clock();
    const cache = createTokenCache({ now: c.now });
    cache.set(KEY, ENTRY);
    c.set(T0 + 55 * MINUTE);
    expect(cache.getFresh(KEY)).toBeUndefined();
    expect(cache.getUnexpired(KEY)).toEqual(ENTRY);
    expect(cache.size()).toBe(1);

    c.set(T0 + 60 * MINUTE);
    expect(cache.getUnexpired(KEY)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("does not count expired entries in size()", () => {
    const c = clock();
    const cache = createTokenCache({ now: c.now });
    cache.set(KEY, ENTRY);
    cache.set({ ...KEY, repos: ["acme/gadgets"] }, { token: "ghs_two", expiresAt: iso(T0 + 90 * MINUTE) });
    c.set(T0 + 70 * MINUTE);
    expect(cache.size()).toBe(1);
  });

  it("never shares an entry across installations, repositories or access levels", () => {
    const cache = createTokenCache({ now: () => T0 });
    cache.set(KEY, ENTRY);
    expect(cache.getFresh({ ...KEY, installationId: 8 })).toBeUndefined();
    expect(cache.getFresh({ ...KEY, repos: ["acme/gadgets"] })).toBeUndefined();
    expect(cache.getFresh({ ...KEY, access: "write" })).toBeUndefined();
    expect(cache.getFresh({ ...KEY, repos: ["acme/widgets", "acme/gadgets"] })).toBeUndefined();
  });

  it("keys repositories by owner/name and ignores case", () => {
    const cache = createTokenCache({ now: () => T0 });
    cache.set(KEY, ENTRY);
    expect(cache.getFresh({ ...KEY, repos: ["other/widgets"] })).toBeUndefined();
    expect(cache.getFresh({ ...KEY, repos: ["Acme/Widgets"] })).toEqual(ENTRY);
  });

  it("treats the repository set as sorted", () => {
    const cache = createTokenCache({ now: () => T0 });
    cache.set({ ...KEY, repos: ["b", "a"] }, ENTRY);
    expect(cache.getFresh({ ...KEY, repos: ["a", "b"] })).toEqual(ENTRY);
  });

  it("replaces an entry on set and drops one on evict", () => {
    const cache = createTokenCache({ now: () => T0 });
    cache.set(KEY, ENTRY);
    const next = { token: "ghs_two", expiresAt: iso(T0 + 60 * MINUTE) };
    cache.set(KEY, next);
    expect(cache.getFresh(KEY)).toEqual(next);
    expect(cache.size()).toBe(1);
    cache.evict(KEY);
    expect(cache.getFresh(KEY)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("clears every entry at once", () => {
    const cache = createTokenCache({ now: () => T0 });
    cache.set(KEY, ENTRY);
    cache.set({ ...KEY, access: "write" }, ENTRY);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.getUnexpired(KEY)).toBeUndefined();
  });

  it("does not store an entry with an unparseable or past expiry", () => {
    const cache = createTokenCache({ now: () => T0 });
    cache.set(KEY, { token: "ghs_bad", expiresAt: "not a time" });
    cache.set({ ...KEY, access: "write" }, { token: "ghs_old", expiresAt: iso(T0 - MINUTE) });
    expect(cache.size()).toBe(0);
  });
});
