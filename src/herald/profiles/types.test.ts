/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { byDispatchPriority, DEFAULT_PROFILE_PRIORITY, profilePriority } from "./types.js";

describe("profile dispatch priority", () => {
  it("profilePriority falls back to the default when unset/invalid", () => {
    expect(profilePriority({ priority: 0 })).toBe(0);
    expect(profilePriority({ priority: 2 })).toBe(2);
    expect(profilePriority({})).toBe(DEFAULT_PROFILE_PRIORITY);
    expect(profilePriority({ priority: Number.NaN })).toBe(DEFAULT_PROFILE_PRIORITY);
  });

  it("byDispatchPriority orders lower priority first, unset last, ties by name", () => {
    const profiles = [
      { profile: "story-spider", priority: 2 },
      { profile: "march", priority: 1 },
      { profile: "unset-b" }, // no priority → default (last)
      { profile: "gate", priority: 2 },
      { profile: "smithy", priority: 0 },
      { profile: "unset-a" }, // no priority → default (last), before unset-b by name
    ];
    const order = [...profiles].sort(byDispatchPriority).map((p) => p.profile);
    expect(order).toEqual([
      "smithy", // P0
      "march", // P1
      "gate", // P2, ties with story-spider → name order (gate < story-spider)
      "story-spider", // P2
      "unset-a", // default, name order
      "unset-b",
    ]);
  });

  it("sort is stable/deterministic regardless of input order", () => {
    const a = [{ profile: "b", priority: 1 }, { profile: "a", priority: 1 }];
    const b = [{ profile: "a", priority: 1 }, { profile: "b", priority: 1 }];
    expect([...a].sort(byDispatchPriority).map((p) => p.profile)).toEqual(["a", "b"]);
    expect([...b].sort(byDispatchPriority).map((p) => p.profile)).toEqual(["a", "b"]);
  });
});
