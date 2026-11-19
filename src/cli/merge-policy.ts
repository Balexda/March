import {
  BOT_LOGIN_PATTERN,
  KNOWN_TASK_TYPES,
  normalizeBotLogin,
  resolveMergeRequirements,
  resolveMergePolicyRow,
  type MergePolicy,
  type MergeRequirements,
} from "../herald/profiles/merge-policy.js";

export interface VerbPolicyEdits {
  botApprover?: string[];
  noBotApprover?: string[];
  reviewRequest?: string[];
  noReviewRequest?: string[];
}

export function editVerbPolicy(
  policy: MergePolicy,
  verb: string,
  override: Partial<MergeRequirements>,
  edits: VerbPolicyEdits,
): MergePolicy {
  const existing = Object.hasOwn(policy.byTaskType ?? {}, verb) ? policy.byTaskType?.[verb] : undefined;
  const row = { ...existing, ...override };
  let reviewRequests = policy.reviewRequests;

  if (edits.botApprover || edits.noBotApprover) {
    const add = edits.botApprover ?? [];
    const remove = edits.noBotApprover ?? [];
    for (const login of [...add, ...remove]) {
      if (!BOT_LOGIN_PATTERN.test(login)) throw new Error(`Invalid bot login "${login}".`);
    }
    const builtin = KNOWN_TASK_TYPES.some((known) => known === verb);
    const inherited = builtin ? undefined : policy.defaults?.botApprovers;
    const logins = new Set((row.botApprovers ?? inherited ?? []).map(normalizeBotLogin));
    for (const login of add) logins.add(normalizeBotLogin(login));
    for (const login of remove) logins.delete(normalizeBotLogin(login));
    if (logins.size > 0) {
      row.botApprovers = [...logins];
    } else if (inherited) {
      // Mask the inherited list with the same fallback used when no list exists.
      row.botApprovers = resolveMergeRequirements({ byTaskType: { [verb]: { botApproval: true } } }, verb).botApprovers;
    } else {
      delete row.botApprovers;
    }
  }

  if (edits.reviewRequest || edits.noReviewRequest) {
    const requests = policy.reviewRequests?.byTaskType;
    const stored = Object.hasOwn(requests ?? {}, verb) ? requests?.[verb]?.reviewers : undefined;
    const reviewers = [...stored ?? []];
    for (const input of edits.reviewRequest ?? []) {
      if (input !== "copilot" && input !== "coderabbit" &&
          input !== "coderabbit:comment-trigger" && input !== "coderabbit:auto") {
        throw new Error(`Invalid reviewer or mode "${input}".`);
      }
      const id = input === "copilot" ? "copilot" : "coderabbit";
      const index = reviewers.findIndex((reviewer) => reviewer.id === id);
      if (index >= 0) reviewers.splice(index, 1);
      reviewers.push(id === "copilot" ? { id } : {
        id,
        mode: input === "coderabbit:auto" ? "auto" : "comment-trigger",
      });
    }
    for (const id of edits.noReviewRequest ?? []) {
      if (id !== "coderabbit" && id !== "copilot") throw new Error(`Invalid reviewer "${id}".`);
      const index = reviewers.findIndex((reviewer) => reviewer.id === id);
      if (index >= 0) reviewers.splice(index, 1);
    }
    reviewRequests = { byTaskType: { ...requests, [verb]: { reviewers } } };
  }

  return { ...policy, byTaskType: { ...policy.byTaskType, [verb]: row }, reviewRequests };
}

export function showMergePolicy(policy: MergePolicy | undefined, json: boolean): void {
  const verbs = new Set([...KNOWN_TASK_TYPES, ...Object.keys(policy?.byTaskType ?? {})]);
  const rows = Object.fromEntries([...verbs].map((verb) => [verb, resolveMergePolicyRow(policy, verb)]));
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.table(Object.entries(rows).map(([verb, { requirements, reviewers, provenance }]) => ({
    verb,
    approval: `${requirements.approval} (${provenance.approval})`,
    changesRequested: `${requirements.changesRequested} (${provenance.changesRequested})`,
    botApproval: `${requirements.botApproval} (${provenance.botApproval})`,
    botApprovers: `${requirements.botApprovers.join(", ") || "—"} (${provenance.botApprovers})`,
    reviewers: `${reviewers.map((r) => r.id === "coderabbit" ? `${r.id}:${r.mode}` : r.id).join(", ") || "—"} (${provenance.reviewers})`,
  })), ["verb", "approval", "changesRequested", "botApproval", "botApprovers", "reviewers"]);
}
