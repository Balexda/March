/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  approvalSatisfied,
  DEFAULT_MERGE_REQUIREMENTS,
  parseMergePolicy,
  resolveMergeRequirements,
  validateMergePolicy,
  type MergePolicy,
} from "./merge-policy.js";

describe("resolveMergeRequirements", () => {
  // Built-in base policy (#298): cut drops the approval gate for EVERY profile,
  // present and future, without per-profile config.
  it("undefined policy: cut auto-merges by default; other verbs stay all-required", () => {
    expect(resolveMergeRequirements(undefined, "cut")).toEqual({ approval: false, changesRequested: true, botApproval: false });
    expect(resolveMergeRequirements(undefined, "forge")).toEqual(DEFAULT_MERGE_REQUIREMENTS);
    expect(resolveMergeRequirements(undefined, undefined)).toEqual(DEFAULT_MERGE_REQUIREMENTS);
  });

  it("empty policy behaves like undefined: built-in cut default still applies", () => {
    expect(resolveMergeRequirements({}, "cut")).toEqual({ approval: false, changesRequested: true, botApproval: false });
    expect(resolveMergeRequirements({}, "forge")).toEqual({ approval: true, changesRequested: true, botApproval: false });
  });

  it("built-in cut default relaxes approval only, never changesRequested", () => {
    expect(resolveMergeRequirements(undefined, "cut")).toEqual({ approval: false, changesRequested: true, botApproval: false });
  });

  it("a profile can re-tighten cut explicitly — its policy wins over the built-in base", () => {
    const policy: MergePolicy = { byTaskType: { cut: { approval: true } } };
    expect(resolveMergeRequirements(policy, "cut")).toEqual({ approval: true, changesRequested: true, botApproval: false });
  });

  it("a profile-wide defaults.approval=true does NOT re-require cut approval (verb tier is more specific)", () => {
    const policy: MergePolicy = { defaults: { approval: true } };
    expect(resolveMergeRequirements(policy, "cut")).toEqual({ approval: false, changesRequested: true, botApproval: false });
    expect(resolveMergeRequirements(policy, "forge")).toEqual({ approval: true, changesRequested: true, botApproval: false });
  });

  it("defaults override the base for every task type", () => {
    const policy: MergePolicy = { defaults: { approval: false } };
    expect(resolveMergeRequirements(policy, "cut")).toEqual({ approval: false, changesRequested: true, botApproval: false });
    expect(resolveMergeRequirements(policy, "forge")).toEqual({ approval: false, changesRequested: true, botApproval: false });
  });

  it("byTaskType overrides defaults for the matching verb only", () => {
    const policy: MergePolicy = {
      defaults: { approval: true, changesRequested: true },
      byTaskType: { cut: { approval: false } },
    };
    expect(resolveMergeRequirements(policy, "cut")).toEqual({ approval: false, changesRequested: true, botApproval: false });
    expect(resolveMergeRequirements(policy, "forge")).toEqual({ approval: true, changesRequested: true, botApproval: false });
  });

  it("the cut use-case: only approval relaxed for cut", () => {
    const policy: MergePolicy = { byTaskType: { cut: { approval: false } } };
    expect(resolveMergeRequirements(policy, "cut")).toEqual({ approval: false, changesRequested: true, botApproval: false });
    expect(resolveMergeRequirements(policy, "mark")).toEqual({ approval: true, changesRequested: true, botApproval: false });
  });

  it("unknown / undefined task type falls back to defaults", () => {
    const policy: MergePolicy = { byTaskType: { cut: { approval: false } } };
    expect(resolveMergeRequirements(policy, "render")).toEqual({ approval: true, changesRequested: true, botApproval: false });
    expect(resolveMergeRequirements(policy, undefined)).toEqual({ approval: true, changesRequested: true, botApproval: false });
  });

  it("layering precedence: base < defaults < byTaskType, per field", () => {
    const policy: MergePolicy = {
      defaults: { approval: false, changesRequested: false },
      byTaskType: { cut: { changesRequested: true } },
    };
    expect(resolveMergeRequirements(policy, "cut")).toEqual({ approval: false, changesRequested: true, botApproval: false });
  });
});

describe("botApproval", () => {
  it("is off by default for every verb", () => {
    expect(resolveMergeRequirements(undefined, "mark").botApproval).toBe(false);
    expect(resolveMergeRequirements({}, "forge").botApproval).toBe(false);
  });

  it("can be enabled profile-wide or per verb, and re-disabled per verb", () => {
    const policy: MergePolicy = { defaults: { botApproval: true }, byTaskType: { forge: { botApproval: false } } };
    expect(resolveMergeRequirements(policy, "mark")).toEqual({ approval: true, changesRequested: true, botApproval: true });
    expect(resolveMergeRequirements(policy, "forge").botApproval).toBe(false);
  });

  it("validates as a boolean requirement", () => {
    expect(validateMergePolicy({ byTaskType: { mark: { botApproval: true } } }).ok).toBe(true);
    expect(validateMergePolicy({ defaults: { botApproval: "yes" } }).ok).toBe(false);
  });
});

describe("approvalSatisfied", () => {
  const required = { approval: true, changesRequested: true, botApproval: false };
  const botOk = { ...required, botApproval: true };

  it("a human approval always satisfies the gate", () => {
    expect(approvalSatisfied(required, { human_approval_count: 1, bot_approval_count: 0 })).toBe(true);
    expect(approvalSatisfied(botOk, { human_approval_count: 1, bot_approval_count: 0 })).toBe(true);
  });

  it("a bot approval is ignored unless the policy opts in", () => {
    expect(approvalSatisfied(required, { human_approval_count: 0, bot_approval_count: 1 })).toBe(false);
    expect(approvalSatisfied(botOk, { human_approval_count: 0, bot_approval_count: 1 })).toBe(true);
  });

  it("opting in does not drop the gate: no approval at all still blocks", () => {
    expect(approvalSatisfied(botOk, { human_approval_count: 0, bot_approval_count: 0 })).toBe(false);
    expect(approvalSatisfied(botOk, {})).toBe(false);
    expect(approvalSatisfied(botOk, undefined)).toBe(false);
  });

  it("a relaxed approval gate passes regardless", () => {
    expect(approvalSatisfied({ ...required, approval: false }, {})).toBe(true);
  });
});

describe("dependencyUpdates", () => {
  it("accepts and normalizes the autoMerge switch", () => {
    const r = validateMergePolicy({ dependencyUpdates: { autoMerge: true } });
    expect(r).toEqual({ ok: true, policy: { dependencyUpdates: { autoMerge: true } } });
    expect(parseMergePolicy('{"dependencyUpdates":{"autoMerge":true}}')).toEqual({ dependencyUpdates: { autoMerge: true } });
  });

  it("rejects unknown keys and non-boolean values", () => {
    expect(validateMergePolicy({ dependencyUpdates: { autoMerge: "yes" } }).ok).toBe(false);
    expect(validateMergePolicy({ dependencyUpdates: { authors: ["x"] } }).ok).toBe(false);
    expect(validateMergePolicy({ dependencyUpdates: true }).ok).toBe(false);
  });

  it("does not affect slice merge requirements", () => {
    expect(resolveMergeRequirements({ dependencyUpdates: { autoMerge: true } }, "forge")).toEqual(DEFAULT_MERGE_REQUIREMENTS);
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

describe("codeRabbit", () => {
  it("accepts and round-trips rereview", () => {
    expect(validateMergePolicy({ codeRabbit: { rereview: true } })).toEqual({ ok: true, policy: { codeRabbit: { rereview: true } } });
    expect(parseMergePolicy('{"codeRabbit":{"rereview":false}}')).toEqual({ codeRabbit: { rereview: false } });
  });

  it("rejects unknown keys and non-boolean values", () => {
    expect(validateMergePolicy({ codeRabbit: { approve: true } }).ok).toBe(false);
    expect(validateMergePolicy({ codeRabbit: { rereview: "yes" } }).ok).toBe(false);
    expect(validateMergePolicy({ codeRabbit: true }).ok).toBe(false);
  });
});
