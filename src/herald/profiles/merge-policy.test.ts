/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MERGE_REQUIREMENTS,
  parseMergePolicy,
  resolveMergeRequirements,
  validateMergePolicy,
  type MergePolicy,
} from "./merge-policy.js";

describe("resolveMergeRequirements", () => {
  it("undefined policy yields the all-required default", () => {
    expect(resolveMergeRequirements(undefined, "cut")).toEqual(DEFAULT_MERGE_REQUIREMENTS);
  });

  it("empty policy yields the all-required default", () => {
    expect(resolveMergeRequirements({}, "cut")).toEqual({ approval: true, changesRequested: true });
  });

  it("defaults override the base for every task type", () => {
    const policy: MergePolicy = { defaults: { approval: false } };
    expect(resolveMergeRequirements(policy, "cut")).toEqual({ approval: false, changesRequested: true });
    expect(resolveMergeRequirements(policy, "forge")).toEqual({ approval: false, changesRequested: true });
  });

  it("byTaskType overrides defaults for the matching verb only", () => {
    const policy: MergePolicy = {
      defaults: { approval: true, changesRequested: true },
      byTaskType: { cut: { approval: false } },
    };
    expect(resolveMergeRequirements(policy, "cut")).toEqual({ approval: false, changesRequested: true });
    expect(resolveMergeRequirements(policy, "forge")).toEqual({ approval: true, changesRequested: true });
  });

  it("the cut use-case: only approval relaxed for cut", () => {
    const policy: MergePolicy = { byTaskType: { cut: { approval: false } } };
    expect(resolveMergeRequirements(policy, "cut")).toEqual({ approval: false, changesRequested: true });
    expect(resolveMergeRequirements(policy, "mark")).toEqual({ approval: true, changesRequested: true });
  });

  it("unknown / undefined task type falls back to defaults", () => {
    const policy: MergePolicy = { byTaskType: { cut: { approval: false } } };
    expect(resolveMergeRequirements(policy, "render")).toEqual({ approval: true, changesRequested: true });
    expect(resolveMergeRequirements(policy, undefined)).toEqual({ approval: true, changesRequested: true });
  });

  it("layering precedence: base < defaults < byTaskType, per field", () => {
    const policy: MergePolicy = {
      defaults: { approval: false, changesRequested: false },
      byTaskType: { cut: { changesRequested: true } },
    };
    expect(resolveMergeRequirements(policy, "cut")).toEqual({ approval: false, changesRequested: true });
  });
});

describe("validateMergePolicy", () => {
  it("accepts a minimal byTaskType policy", () => {
    const result = validateMergePolicy({ byTaskType: { cut: { approval: false } } });
    expect(result).toEqual({ ok: true, policy: { byTaskType: { cut: { approval: false } } } });
  });

  it("accepts defaults + byTaskType", () => {
    const result = validateMergePolicy({
      defaults: { approval: false },
      byTaskType: { cut: { changesRequested: false } },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validateMergePolicy(42).ok).toBe(false);
    expect(validateMergePolicy(null).ok).toBe(false);
    expect(validateMergePolicy([]).ok).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    const result = validateMergePolicy({ nope: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("nope");
  });

  it("rejects unknown requirement keys", () => {
    const result = validateMergePolicy({ byTaskType: { cut: { checks: false } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("checks");
  });

  it("rejects non-boolean requirement values", () => {
    const result = validateMergePolicy({ defaults: { approval: "yes" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("approval");
  });

  it("rejects a non-object byTaskType", () => {
    expect(validateMergePolicy({ byTaskType: [] }).ok).toBe(false);
  });

  it("rejects prototype-pollution task-type keys", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const result = validateMergePolicy({ byTaskType: { [key]: { approval: false } } });
      expect(result.ok).toBe(false);
    }
    // A normal policy parsed from JSON does not pollute Object.prototype.
    parseMergePolicy('{"byTaskType":{"__proto__":{"approval":false}}}');
    expect(({} as Record<string, unknown>).approval).toBeUndefined();
  });
});

describe("parseMergePolicy", () => {
  it("returns undefined for null/empty (all-required)", () => {
    expect(parseMergePolicy(null)).toBeUndefined();
    expect(parseMergePolicy(undefined)).toBeUndefined();
    expect(parseMergePolicy("")).toBeUndefined();
    expect(parseMergePolicy("   ")).toBeUndefined();
  });

  it("returns undefined for malformed JSON (never throws)", () => {
    expect(parseMergePolicy("{not json")).toBeUndefined();
  });

  it("returns undefined for valid JSON that fails validation", () => {
    expect(parseMergePolicy('{"byTaskType":{"cut":{"checks":false}}}')).toBeUndefined();
  });

  it("round-trips a valid policy", () => {
    const json = '{"byTaskType":{"cut":{"approval":false}}}';
    expect(parseMergePolicy(json)).toEqual({ byTaskType: { cut: { approval: false } } });
  });
});
