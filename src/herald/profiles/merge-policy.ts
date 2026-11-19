import type { ReviewObservation } from "../../observe/sense-io.js";

/** Profile policy shared by Herald validation, Legate, and the operator CLI. */
export interface MergeRequirements {
  readonly approval: boolean;
  readonly changesRequested: boolean;
  readonly botApproval: boolean;
  readonly botApprovers?: readonly string[];
}

export interface ResolvedMergeRequirements extends MergeRequirements {
  readonly botApprovers: readonly string[];
}

export type ReviewerConfig =
  | { readonly id: "coderabbit"; readonly mode?: "comment-trigger" | "auto" }
  | { readonly id: "copilot" };

export interface MergePolicy {
  readonly defaults?: Partial<MergeRequirements>;
  readonly byTaskType?: Readonly<Record<string, Partial<MergeRequirements>>>;
  readonly reviewRequests?: {
    readonly byTaskType: Readonly<Record<string, { readonly reviewers: readonly ReviewerConfig[] }>>;
  };
  readonly dependencyUpdates?: DependencyUpdatePolicy;
  readonly codeRabbit?: CodeRabbitPolicy;
}

/** Legacy profile flags retained in stored policies. The forge reviewer row controls review requests. */
export interface CodeRabbitPolicy {
  readonly rereview?: boolean;
  readonly initialReview?: boolean;
}

const CODERABBIT_POLICY_KEYS = ["rereview", "initialReview"] as const;

/**
 * Policy for dependency-update PRs (Dependabot version bumps). These are not
 * Smithy slices, so the per-task-type requirements above never apply to them;
 * they are handled by the legate's dependency-merge handler, which is inert
 * unless `autoMerge` is true. Off by default.
 */
export interface DependencyUpdatePolicy {
  readonly autoMerge?: boolean;
}

export const KNOWN_TASK_TYPES = ["cut", "forge", "spark", "ignite", "render", "mark", "fix", "strike"] as const;

export const DEFAULT_MERGE_REQUIREMENTS: ResolvedMergeRequirements = {
  approval: true,
  changesRequested: true,
  botApproval: false,
  botApprovers: [],
};

const CODERABBIT_LOGIN = "coderabbitai";
const BUILTIN_BOT_APPROVERS = [CODERABBIT_LOGIN] as const;
const BUILTIN_ROWS = {
  cut: { ...DEFAULT_MERGE_REQUIREMENTS, approval: false },
  forge: { ...DEFAULT_MERGE_REQUIREMENTS, botApproval: true, botApprovers: BUILTIN_BOT_APPROVERS },
  spark: DEFAULT_MERGE_REQUIREMENTS,
  ignite: DEFAULT_MERGE_REQUIREMENTS,
  render: DEFAULT_MERGE_REQUIREMENTS,
  mark: DEFAULT_MERGE_REQUIREMENTS,
  fix: DEFAULT_MERGE_REQUIREMENTS,
  strike: DEFAULT_MERGE_REQUIREMENTS,
};

export const BOT_LOGIN_PATTERN = /^[A-Za-z0-9-]+(\[bot\])?$/i;

export function normalizeBotLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, "");
}

export function selfBotLogin(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeBotLogin(env.MARCH_SELF_BOT_LOGIN?.trim() || "march-bot");
}

function verbEntry<T>(entries: Readonly<Record<string, T>> | undefined, verb: string): T | undefined {
  return entries && Object.hasOwn(entries, verb) ? entries[verb] : undefined;
}

export function resolveMergeRequirements(
  policy: MergePolicy | undefined,
  taskType: string | undefined,
): ResolvedMergeRequirements {
  return resolveMergePolicyRow(policy, taskType).requirements;
}

export function resolveReviewRequests(
  policy: MergePolicy | undefined,
  taskType: string | undefined,
): readonly ReviewerConfig[] {
  return resolveMergePolicyRow(policy, taskType).reviewers;
}

type PolicySource = "built-in" | "profile" | "fail-closed";

export function resolveMergePolicyRow(policy: MergePolicy | undefined, taskType: string | undefined): {
  requirements: ResolvedMergeRequirements;
  reviewers: readonly ReviewerConfig[];
  provenance: Record<keyof MergeRequirements | "reviewers", PolicySource>;
} {
  const verb = taskType ?? "";
  const builtin = verbEntry(BUILTIN_ROWS, verb);
  const override = taskType ? verbEntry(policy?.byTaskType, verb) : undefined;
  const defaults = !builtin && override ? policy?.defaults : undefined;
  const base = builtin ?? DEFAULT_MERGE_REQUIREMENTS;
  const source = builtin ? "built-in" : "fail-closed";
  const profile = { ...defaults, ...override };
  const effective = { ...base, ...profile };
  const configuredApprovers = effective.botApprovers?.map(normalizeBotLogin);
  const allowlist = configuredApprovers?.length ? configuredApprovers : BUILTIN_BOT_APPROVERS;
  const botApprovers = effective.botApproval ? allowlist : [];
  const requests = builtin || override ? verbEntry(policy?.reviewRequests?.byTaskType, verb) : undefined;
  return {
    requirements: {
      ...effective,
      // A profile-wide relaxation never bypasses an outstanding review.
      changesRequested: override?.changesRequested ?? base.changesRequested,
      botApprovers,
    },
    reviewers: requests?.reviewers.map((reviewer) => reviewer.id === "coderabbit"
      ? { id: reviewer.id, mode: reviewer.mode ?? "comment-trigger" }
      : reviewer) ?? [],
    provenance: {
      approval: profile.approval !== undefined ? "profile" : source,
      changesRequested: override?.changesRequested !== undefined ? "profile" : source,
      botApproval: profile.botApproval !== undefined ? "profile" : source,
      botApprovers: effective.botApproval
        ? profile.botApprovers?.length ? "profile" : "built-in"
        : profile.botApproval === false ? "profile" : source,
      reviewers: requests ? "profile" : source,
    },
  };
}

interface ReviewEvidence {
  human_approval_count?: unknown;
  bot_approval_count?: unknown;
  changes_requested_count?: unknown;
  /** False when the observer could not read every review page. */
  reviews_complete?: boolean;
  head_sha?: string | null;
  reviews?: readonly ReviewObservation[];
  coderabbit?: { decision_is_bot?: true; decision?: string | null } | null;
}

export function eligibleReviewer(req: ResolvedMergeRequirements, review: ReviewObservation): boolean {
  const login = normalizeBotLogin(review.login);
  return login !== selfBotLogin() && (
    review.author_kind === "human" ||
    (review.author_kind === "bot" && req.botApprovers.includes(login))
  );
}

export function approvalSatisfied(
  req: ResolvedMergeRequirements,
  pr: ReviewEvidence | null | undefined,
): boolean {
  if (!req.approval) return true;
  // Partial review evidence can hide a later verdict, so it never establishes approval.
  if (pr?.reviews_complete === false) return false;
  if (pr?.reviews) {
    return pr.reviews.some((review) =>
      review.state === "APPROVED" && eligibleReviewer(req, review) &&
      (review.author_kind === "human" ||
        (req.botApproval && !!pr.head_sha && review.commit_sha === pr.head_sha)),
    );
  }
  return typeof pr?.human_approval_count === "number" && pr.human_approval_count >= 1;
}

export function changesRequestedSatisfied(req: ResolvedMergeRequirements, pr: ReviewEvidence): boolean {
  if (!req.changesRequested) return true;
  if (pr.reviews_complete === false) return false;
  if (pr.reviews) {
    return !pr.reviews.some((review) => review.state === "CHANGES_REQUESTED" && eligibleReviewer(req, review));
  }
  // Preserve outstanding blockers on snapshots written before reviewer verdicts.
  const legacyBotBlock = selfBotLogin() !== CODERABBIT_LOGIN && req.botApprovers.includes(CODERABBIT_LOGIN) &&
    pr.coderabbit?.decision_is_bot === true && pr.coderabbit.decision === "CHANGES_REQUESTED";
  return Number(pr.changes_requested_count ?? 0) === 0 && !legacyBotBlock;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RESERVED_VERBS = new Set(["__proto__", "constructor", "prototype"]);

function validVerb(verb: string): boolean {
  return !RESERVED_VERBS.has(verb);
}
function validateRequirements(
  value: unknown,
  where: string,
): { ok: true; requirements: Partial<MergeRequirements> } | { ok: false; error: string } {
  if (!isPlainObject(value)) {
    return { ok: false, error: `${where} must be an object.` };
  }
  const requirements: { -readonly [K in keyof MergeRequirements]?: MergeRequirements[K] } = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "botApprovers") {
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10 ||
          !Array.from(raw).every((login) => typeof login === "string" && BOT_LOGIN_PATTERN.test(login))) {
        return { ok: false, error: `${where}.botApprovers must contain 1–10 valid bot logins.` };
      }
      const logins = raw.map(normalizeBotLogin);
      if (logins.includes(selfBotLogin())) {
        return { ok: false, error: `${where}.botApprovers cannot include March's own bot login.` };
      }
      requirements.botApprovers = [...new Set(logins)];
      continue;
    }
    if (key !== "approval" && key !== "changesRequested" && key !== "botApproval") {
      return { ok: false, error: `${where} has unknown requirement "${key}".` };
    }
    if (typeof raw !== "boolean") {
      return { ok: false, error: `${where}.${key} must be a boolean.` };
    }
    requirements[key] = raw;
  }
  return { ok: true, requirements };
}

function validateReviewRequests(
  value: unknown,
): { ok: true; requests: NonNullable<MergePolicy["reviewRequests"]> } | { ok: false; error: string } {
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "byTaskType") ||
      !isPlainObject(value.byTaskType)) {
    return { ok: false, error: "merge policy reviewRequests must contain only a byTaskType map." };
  }
  const byTaskType: Record<string, { reviewers: ReviewerConfig[] }> = Object.create(null);
  for (const [verb, config] of Object.entries(value.byTaskType)) {
    const where = `merge policy reviewRequests.byTaskType.${verb}`;
    if (!validVerb(verb) || !isPlainObject(config) ||
        Object.keys(config).some((key) => key !== "reviewers") || !Array.isArray(config.reviewers)) {
      return { ok: false, error: `${where} must be a valid verb entry containing only a reviewers array.` };
    }
    const reviewers: ReviewerConfig[] = [];
    for (const reviewer of config.reviewers) {
      if (!isPlainObject(reviewer) || Object.keys(reviewer).some((key) => key !== "id" && key !== "mode")) {
        return { ok: false, error: `${where} has an invalid reviewer object.` };
      }
      const { id, mode } = reviewer;
      if (reviewers.some((entry) => entry.id === id)) {
        return { ok: false, error: `${where} has duplicate reviewer "${id}".` };
      }
      if (id === "coderabbit" && (mode === undefined || mode === "comment-trigger" || mode === "auto")) {
        reviewers.push({ id, mode: mode ?? "comment-trigger" });
      } else if (id === "copilot" && mode === undefined) {
        reviewers.push({ id });
      } else {
        return { ok: false, error: `${where} has an unsupported reviewer ID or mode.` };
      }
    }
    byTaskType[verb] = { reviewers };
  }
  return { ok: true, requests: { byTaskType } };
}

/**
 * Validate an untrusted value as a {@link MergePolicy}. Rejects unknown keys,
 * non-boolean requirement values, and non-object shapes. Returns a normalized
 * policy (only known fields) on success.
 */
export function validateMergePolicy(
  value: unknown,
): { ok: true; policy: MergePolicy } | { ok: false; error: string } {
  if (!isPlainObject(value)) {
    return { ok: false, error: "merge policy must be an object." };
  }
  for (const key of Object.keys(value)) {
    if (key !== "defaults" && key !== "byTaskType" && key !== "dependencyUpdates" && key !== "codeRabbit" && key !== "reviewRequests") {
      return {
        ok: false,
        error: `merge policy has unknown key "${key}".`,
      };
    }
  }
  const policy: { -readonly [K in keyof MergePolicy]: MergePolicy[K] } = {};

  if (value.reviewRequests !== undefined) {
    const result = validateReviewRequests(value.reviewRequests);
    if (!result.ok) return result;
    policy.reviewRequests = result.requests;
  }

  if (value.codeRabbit !== undefined) {
    const cr = value.codeRabbit;
    if (!isPlainObject(cr)) {
      return { ok: false, error: "merge policy codeRabbit must be an object." };
    }
    const out: { rereview?: boolean; initialReview?: boolean } = {};
    for (const [key, raw] of Object.entries(cr)) {
      if (!(CODERABBIT_POLICY_KEYS as readonly string[]).includes(key)) {
        return { ok: false, error: `merge policy codeRabbit has unknown key "${key}" (expected "rereview" or "initialReview").` };
      }
      if (typeof raw !== "boolean") {
        return { ok: false, error: `merge policy codeRabbit.${key} must be a boolean.` };
      }
      out[key as (typeof CODERABBIT_POLICY_KEYS)[number]] = raw;
    }
    policy.codeRabbit = out;
  }

  if (value.dependencyUpdates !== undefined) {
    const du = value.dependencyUpdates;
    if (!isPlainObject(du)) {
      return { ok: false, error: "merge policy dependencyUpdates must be an object." };
    }
    for (const [key, raw] of Object.entries(du)) {
      if (key !== "autoMerge") {
        return { ok: false, error: `merge policy dependencyUpdates has unknown key "${key}" (expected "autoMerge").` };
      }
      if (typeof raw !== "boolean") {
        return { ok: false, error: "merge policy dependencyUpdates.autoMerge must be a boolean." };
      }
    }
    policy.dependencyUpdates = typeof du.autoMerge === "boolean" ? { autoMerge: du.autoMerge } : {};
  }

  if (value.defaults !== undefined) {
    const result = validateRequirements(value.defaults, "merge policy defaults");
    if (!result.ok) return result;
    policy.defaults = result.requirements;
  }

  if (value.byTaskType !== undefined) {
    if (!isPlainObject(value.byTaskType)) {
      return { ok: false, error: "merge policy byTaskType must be an object keyed by task type." };
    }
    // Null-prototype map so an untrusted task-type key can't pollute the
    // prototype chain; also reject the dangerous names outright (they are not
    // valid smithy verbs anyway). This input arrives over HTTP (POST /profiles).
    const byTaskType: Record<string, Partial<MergeRequirements>> = Object.create(null);
    for (const [taskType, requirements] of Object.entries(value.byTaskType)) {
      if (!validVerb(taskType)) {
        return { ok: false, error: `merge policy byTaskType has invalid or reserved key "${taskType}".` };
      }
      const result = validateRequirements(requirements, `merge policy byTaskType.${taskType}`);
      if (!result.ok) return result;
      byTaskType[taskType] = result.requirements;
    }
    policy.byTaskType = byTaskType;
  }

  return { ok: true, policy };
}

/**
 * Parse the registry's `merge_policy` TEXT column. Null/empty/malformed JSON, or
 * a value that fails validation, all degrade to `undefined` (built-in policy) — this
 * is the read path for Herald and the legate, so it must never throw.
 */
export function parseMergePolicy(text: string | null | undefined): MergePolicy | undefined {
  if (text == null) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const result = validateMergePolicy(parsed);
  return result.ok ? result.policy : undefined;
}
