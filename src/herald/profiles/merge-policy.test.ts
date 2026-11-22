/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import {
  APPROVAL_CODES,
  approvalEvidence,
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

describe("review verdicts", () => {
  const forge = resolveMergeRequirements(undefined, "forge");
  const botReview = {
    login: "coderabbitai",
    author_kind: "bot",
    state: "APPROVED",
    commit_sha: "head",
    submitted_at: "2026-11-16T12:00:00Z",
  } as const;
  const pr = { head_sha: "head", reviews: [botReview] };

  it("requires eligible approval and uses aggregate human evidence for legacy snapshots", () => {
    expect(approvalSatisfied(forge, { human_approval_count: 1 })).toBe(true);
    expect(approvalSatisfied(forge, { bot_approval_count: 1 })).toBe(false);
    expect(approvalSatisfied(forge, { human_approval_count: 1, reviews: [] })).toBe(false);
    expect(approvalSatisfied(forge, undefined)).toBe(false);
    expect(approvalSatisfied(resolveMergeRequirements(undefined, "cut"), undefined)).toBe(true);
  });

  it("accepts allowlisted bots only with approval on the current head", () => {
    expect(approvalSatisfied(forge, pr)).toBe(true);
    expect(approvalSatisfied(forge, { ...pr, head_sha: "new" })).toBe(false);
    expect(approvalSatisfied(forge, { ...pr, reviews: [{ ...botReview, commit_sha: null }] })).toBe(false);
    expect(approvalSatisfied(forge, { ...pr, reviews: [{ ...botReview, login: "CodeRabbitAI[BOT]" }] })).toBe(true);
    const customForge = resolveMergeRequirements({ byTaskType: { forge: { botApprovers: ["Other[bot]"] } } }, "forge");
    expect(approvalSatisfied(customForge, pr)).toBe(false);
    expect(approvalSatisfied(customForge, { ...pr, reviews: [{ ...botReview, login: "other" }] })).toBe(true);
    expect(approvalSatisfied(forge, { ...pr, reviews_complete: false })).toBe(false);
    expect(changesRequestedSatisfied(forge, { ...pr, reviews_complete: false })).toBe(false);
    expect(approvalSatisfied(DEFAULT_MERGE_REQUIREMENTS, pr)).toBe(false);
  });

  it("uses human approval rules for a human with an allowlisted login", () => {
    const review = { ...botReview, author_kind: "human", commit_sha: null } as const;
    expect(approvalSatisfied(DEFAULT_MERGE_REQUIREMENTS, { ...pr, reviews: [review] })).toBe(true);
  });

  it("excludes March even if the policy allowlists it", () => {
    vi.stubEnv("MARCH_SELF_BOT_LOGIN", "march-app[bot]");
    try {
      const req = { ...forge, botApprovers: ["march-app"] };
      const self = { ...botReview, login: "March-App" };
      expect(approvalSatisfied(req, { ...pr, reviews: [self] })).toBe(false);
      expect(changesRequestedSatisfied(req, { ...pr, reviews: [{ ...self, state: "CHANGES_REQUESTED" }] })).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("blocks trusted and human changes-requested on any commit until superseded or relaxed", () => {
    const review = { ...botReview, state: "CHANGES_REQUESTED", commit_sha: "old" } as const;
    const blocked = { ...pr, reviews: [review] };
    expect(changesRequestedSatisfied(forge, blocked)).toBe(false);
    expect(changesRequestedSatisfied(forge, pr)).toBe(true);
    expect(changesRequestedSatisfied({ ...forge, changesRequested: false }, blocked)).toBe(true);
    expect(changesRequestedSatisfied({ ...forge, botApprovers: ["other"] }, blocked)).toBe(true);
    expect(changesRequestedSatisfied(DEFAULT_MERGE_REQUIREMENTS, {
      ...pr, reviews: [{ ...review, author_kind: "human" }],
    })).toBe(false);
  });
});

it("fails closed on partial review evidence unless the verb relaxes the gate", () => {
  const forge = resolveMergeRequirements(undefined, "forge");
  const partial = { reviews_complete: false, human_approval_count: 1, changes_requested_count: 0 };
  expect(approvalSatisfied(forge, partial)).toBe(false);
  expect(changesRequestedSatisfied(forge, partial)).toBe(false);
  // Older snapshots without the flag keep their existing behavior.
  expect(approvalSatisfied(forge, { human_approval_count: 1 })).toBe(true);
  // An explicitly relaxed gate does not read the evidence at all.
  expect(approvalSatisfied(resolveMergeRequirements(undefined, "cut"), partial)).toBe(true);
  expect(changesRequestedSatisfied({ ...forge, changesRequested: false }, partial)).toBe(true);
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

describe("approvalEvidence", () => {
  const forge = resolveMergeRequirements(undefined, "forge");
  const cut = resolveMergeRequirements(undefined, "cut");
  const mark = resolveMergeRequirements(undefined, "mark");
  const fix = resolveMergeRequirements(undefined, "fix");
  const head = "AbC123";
  const cr = (over: Record<string, unknown> = {}) => ({
    decision: "APPROVED", decision_is_bot: true as const, decision_commit_sha: head, ...over,
  });
  const bot = { head_sha: head, coderabbit: cr() };
  const ok = { ok: true, code: null };

  it("accepts a proven coderabbit approval of the head when reviews are absent", () => {
    expect(approvalEvidence(forge, bot)).toEqual(ok);
    expect(approvalEvidence(forge, { head_sha: head.toLowerCase(), coderabbit: cr({ decision_commit_sha: head.toUpperCase() }) }))
      .toEqual(ok);
  });

  it("reports stale-head when the approval is for an older commit", () => {
    expect(approvalEvidence(forge, { ...bot, head_sha: "newsha" })).toEqual({ ok: false, code: "approval:stale-head" });
  });

  it("reports no-review-evidence without proven bot data", () => {
    const none = { ok: false, code: "approval:no-review-evidence" };
    expect(approvalEvidence(forge, { head_sha: head })).toEqual(none);
    expect(approvalEvidence(forge, undefined)).toEqual(none);
    expect(approvalEvidence(forge, { head_sha: head, coderabbit: { decision: "APPROVED", decision_commit_sha: head } }))
      .toEqual(none);
    expect(approvalEvidence(forge, { head_sha: head, coderabbit: cr({ decision: "CHANGES_REQUESTED" }) })).toEqual(none);
  });

  it("reports evidence-incomplete when reviews could not all be read", () => {
    expect(approvalEvidence(forge, { ...bot, reviews_complete: false }))
      .toEqual({ ok: false, code: "approval:evidence-incomplete" });
  });

  it("accepts a human approval count on forge without reviews", () => {
    expect(approvalEvidence(forge, { head_sha: head, human_approval_count: 1 })).toEqual(ok);
  });

  it("keeps cut open and mark/fix human-only", () => {
    expect(approvalEvidence(cut, undefined)).toEqual(ok);
    for (const req of [mark, fix]) {
      expect(approvalEvidence(req, bot)).toEqual({ ok: false, code: "approval:no-review-evidence" });
      expect(approvalEvidence(req, { head_sha: head, human_approval_count: 1 })).toEqual(ok);
      expect(approvalEvidence(req, { head_sha: head })).toEqual({ ok: false, code: "approval:no-review-evidence" });
    }
  });

  it("never accepts coderabbit approval when March runs as coderabbit", () => {
    vi.stubEnv("MARCH_SELF_BOT_LOGIN", "coderabbitai");
    try {
      expect(approvalEvidence(forge, bot).ok).toBe(false);
      expect(approvalSatisfied(forge, bot)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the reviews-present path unchanged and codes failures", () => {
    const review = {
      login: "coderabbitai", author_kind: "bot", state: "APPROVED", commit_sha: "head",
      submitted_at: "2026-11-16T12:00:00Z",
    } as const;
    const pr = { head_sha: "head", reviews: [review] };
    expect(approvalEvidence(forge, pr)).toEqual(ok);
    expect(approvalEvidence(forge, { ...pr, head_sha: "new" })).toEqual({ ok: false, code: "approval:stale-head" });
    expect(approvalEvidence(forge, { ...pr, reviews: [] })).toEqual({ ok: false, code: "approval:missing" });
    expect(approvalEvidence(forge, { ...pr, reviews: [{ ...review, state: "COMMENTED" }] }))
      .toEqual({ ok: false, code: "approval:missing" });
  });

  it("keeps approvalSatisfied equal to approvalEvidence().ok and codes within the vocabulary", () => {
    const fixtures = [
      undefined, { head_sha: head }, bot, { ...bot, head_sha: "new" }, { ...bot, reviews_complete: false },
      { head_sha: head, human_approval_count: 1 }, { head_sha: "head", reviews: [] },
    ];
    for (const req of [forge, cut, mark, fix, DEFAULT_MERGE_REQUIREMENTS]) {
      for (const pr of fixtures) {
        const result = approvalEvidence(req, pr);
        expect(approvalSatisfied(req, pr)).toBe(result.ok);
        expect(result.ok ? result.code === null : APPROVAL_CODES.includes(result.code!)).toBe(true);
      }
    }
  });

  it("still blocks on a legacy coderabbit CHANGES_REQUESTED verdict without reviews", () => {
    const blocked = { head_sha: head, coderabbit: cr({ decision: "CHANGES_REQUESTED" }) };
    expect(changesRequestedSatisfied(forge, blocked)).toBe(false);
    expect(changesRequestedSatisfied(forge, { head_sha: head })).toBe(true);
  });
});
