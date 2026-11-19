/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import {
  approvalSatisfied,
  changesRequestedSatisfied,
  DEFAULT_MERGE_REQUIREMENTS,
  KNOWN_TASK_TYPES,
  parseMergePolicy,
  resolveMergeRequirements,
  resolveReviewRequests,
  validateMergePolicy,
  type MergePolicy,
} from "./merge-policy.js";

describe("resolveMergeRequirements", () => {
  const required = { approval: true, changesRequested: true, botApproval: false, botApprovers: [] };
  const cut = { ...required, approval: false };
  const forge = { ...required, botApproval: true, botApprovers: ["coderabbitai"] };
  const defaults = { approval: false, changesRequested: false, botApproval: true };
  const relaxed = { ...forge, approval: false };
  const override = { approval: false, changesRequested: false, botApproval: true, botApprovers: ["Review-App[BOT]"] };
  const overridden = { ...override, botApprovers: ["review-app"] };
  const rows = [
    ...KNOWN_TASK_TYPES.map((verb) => ({
      verb, empty: verb === "cut" ? cut : verb === "forge" ? forge : required,
    })),
    { verb: "custom", empty: required },
    { verb: "unknown", empty: required },
    { verb: undefined, empty: required },
  ];
  it.each(rows)("resolves $verb under empty, relaxed and per-verb policies", ({ verb, empty }) => {
    expect(resolveMergeRequirements(undefined, verb)).toEqual(empty);
    expect(resolveMergeRequirements({}, verb)).toEqual(empty);
    expect(resolveMergeRequirements({ defaults, byTaskType: { custom: {} } }, verb))
      .toEqual(verb === "custom" ? relaxed : empty);
    const byTaskType = Object.fromEntries([...KNOWN_TASK_TYPES, "custom"].map((name) => [name, override]));
    expect(resolveMergeRequirements({ defaults, byTaskType }, verb))
      .toEqual(verb && Object.hasOwn(byTaskType, verb) ? overridden : required);
  });

  it("retightens cut and disables forge bot approval through explicit overrides", () => {
    const policy = { byTaskType: { cut: { approval: true }, forge: { botApproval: false } } };
    expect(resolveMergeRequirements(policy, "cut")).toEqual(required);
    expect(resolveMergeRequirements(policy, "forge")).toEqual(required);
  });

  it("requests reviewers only for the opted-in verb and defaults CodeRabbit's mode", () => {
    const policy: MergePolicy = {
      reviewRequests: { byTaskType: { forge: { reviewers: [{ id: "coderabbit" }, { id: "copilot" }] } } },
    };
    expect(resolveReviewRequests(undefined, "forge")).toEqual([]);
    expect(resolveReviewRequests(policy, "cut")).toEqual([]);
    expect(resolveReviewRequests(policy, "forge")).toEqual([
      { id: "coderabbit", mode: "comment-trigger" },
      { id: "copilot" },
    ]);
  });
});

describe("approvalSatisfied", () => {
  const forge = resolveMergeRequirements(undefined, "forge");
  const botApproved = {
    head_sha: "head",
    bot_approval_count: 1,
    coderabbit: { decision: "APPROVED", decision_commit_sha: "head", decision_is_bot: true as const },
  };

  it("requires an eligible approval when the gate is on", () => {
    expect(approvalSatisfied(forge, { human_approval_count: 1 })).toBe(true);
    expect(approvalSatisfied(forge, { bot_approval_count: 1 })).toBe(false);
    expect(approvalSatisfied(forge, undefined)).toBe(false);
    expect(approvalSatisfied(resolveMergeRequirements(undefined, "cut"), undefined)).toBe(true);
  });

  it("accepts observed CodeRabbit approval only for a trusted bot on the head", () => {
    expect(approvalSatisfied(forge, botApproved)).toBe(true);
    expect(approvalSatisfied(forge, { ...botApproved, head_sha: "new" })).toBe(false);
    expect(approvalSatisfied(forge, { ...botApproved, coderabbit: { decision: "APPROVED", decision_commit_sha: "head" } })).toBe(false);
    expect(approvalSatisfied({ ...forge, botApprovers: ["other"] }, botApproved)).toBe(false);
    expect(approvalSatisfied(DEFAULT_MERGE_REQUIREMENTS, botApproved)).toBe(false);
  });
});

it("blocks a trusted CodeRabbit changes-requested verdict until an explicit override", () => {
  const forge = resolveMergeRequirements(undefined, "forge");
  const pr = {
    changes_requested_count: 0,
    coderabbit: { decision: "CHANGES_REQUESTED", decision_commit_sha: "old", decision_is_bot: true as const },
  };
  expect(changesRequestedSatisfied(forge, pr)).toBe(false);
  expect(changesRequestedSatisfied({ ...forge, changesRequested: false }, pr)).toBe(true);
  expect(changesRequestedSatisfied({ ...forge, botApprovers: ["other"] }, pr)).toBe(true);
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
    expect(resolveMergeRequirements({ dependencyUpdates: { autoMerge: true } }, "mark")).toEqual(DEFAULT_MERGE_REQUIREMENTS);
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

  it("accepts and round-trips initialReview alongside rereview", () => {
    expect(validateMergePolicy({ codeRabbit: { rereview: true, initialReview: true } })).toEqual({
      ok: true,
      policy: { codeRabbit: { rereview: true, initialReview: true } },
    });
    expect(validateMergePolicy({ codeRabbit: { initialReview: "on" } }).ok).toBe(false);
  });

  it("rejects unknown keys and non-boolean values", () => {
    expect(validateMergePolicy({ codeRabbit: { approve: true } }).ok).toBe(false);
    expect(validateMergePolicy({ codeRabbit: { rereview: "yes" } }).ok).toBe(false);
    expect(validateMergePolicy({ codeRabbit: true }).ok).toBe(false);
  });
});

describe("review policy validation", () => {
  it.each([[], ["bad login"], ["MARCH-BOT[bot]"], "coderabbitai", Array(11).fill("bot")].map((botApprovers) => ({ botApprovers })))(
    "rejects invalid allowlist $botApprovers", ({ botApprovers }) => {
      vi.stubEnv("MARCH_SELF_BOT_LOGIN", "");
      try {
        expect(validateMergePolicy({ defaults: { botApprovers } }).ok).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("rejects the configured identity after normalizing its login", () => {
    vi.stubEnv("MARCH_SELF_BOT_LOGIN", "CUSTOM[bot]");
    try {
      expect(validateMergePolicy({ byTaskType: { forge: { botApprovers: ["Custom"] } } }).ok).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    [{ id: "copilot" }, { id: "copilot" }],
    [{ id: "copilot", mode: "auto" }],
    [{ id: "coderabbit", mode: "manual" }],
    [{ id: "coderabbit", extra: true }],
    [{ id: "unknown" }],
  ].map((reviewers) => ({ reviewers })))("rejects invalid reviewers $reviewers", ({ reviewers }) => {
    expect(validateMergePolicy({ reviewRequests: { byTaskType: { forge: { reviewers } } } }).ok).toBe(false);
  });

  it.each(["__proto__", "constructor", "prototype"])("rejects reserved reviewer verb %s", (verb) => {
    expect(validateMergePolicy({ reviewRequests: { byTaskType: { [verb]: { reviewers: [] } } } }).ok).toBe(false);
  });

  it("falls back to the built-in table when stored policy is invalid", () => {
    const invalid = parseMergePolicy('{"byTaskType":{"forge":{"approval":false,"botApprovers":[]}}}');
    expect(resolveMergeRequirements(invalid, "forge")).toEqual(resolveMergeRequirements(undefined, "forge"));
  });
});
