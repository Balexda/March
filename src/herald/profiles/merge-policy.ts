/**
 * Per-profile, per-task-type merge policy.
 *
 * March auto-merges a worker's PR only when a fixed set of requirements is met.
 * Two of those are *human-review* gates — at least one human approval, and no
 * outstanding "changes requested" review — and some task types don't warrant
 * them. The motivating case: `smithy cut` produces planning artifacts
 * (`*.tasks.md`) that are mostly the AI talking to itself, so requiring a human
 * approval there just makes people a bottleneck.
 *
 * A {@link MergePolicy} attaches to a profile (stored as JSON in the registry's
 * `merge_policy` column) and lets an operator relax those two gates for specific
 * task types. The CI/conflict/thread requirements are *not* expressed here — they
 * stay mandatory and are enforced by the legate's all-clear precondition.
 *
 * This module is pure (no I/O) so both Herald (validation on write) and the
 * legate service (resolution at merge time) can import it.
 */

/**
 * The two relaxable human-review gates. Both default to *required*.
 *
 * - `approval`: at least one human (non-bot) `APPROVED` review.
 * - `changesRequested`: zero outstanding human `CHANGES_REQUESTED` reviews.
 */
export interface MergeRequirements {
  readonly approval: boolean;
  readonly changesRequested: boolean;
}

/** All human-review gates required — the back-compat default for a profile with
 *  no policy, and the base every override layers on top of. */
export const DEFAULT_MERGE_REQUIREMENTS: MergeRequirements = {
  approval: true,
  changesRequested: true,
};

/** The requirement keys, as a runtime list for validation. */
const REQUIREMENT_KEYS: ReadonlyArray<keyof MergeRequirements> = [
  "approval",
  "changesRequested",
];

/**
 * A profile's merge policy. `defaults` overrides the all-required base for every
 * task type; `byTaskType` overrides per smithy verb (e.g. `"cut"`). Any omitted
 * requirement falls through to the layer beneath it, so a policy can be as small
 * as `{ byTaskType: { cut: { approval: false } } }`.
 */
export interface MergePolicy {
  readonly defaults?: Partial<MergeRequirements>;
  readonly byTaskType?: Readonly<Record<string, Partial<MergeRequirements>>>;
}

/**
 * Resolve the effective requirements for a task type:
 * `DEFAULT_MERGE_REQUIREMENTS` < `policy.defaults` < `policy.byTaskType[taskType]`,
 * last layer wins per field. An undefined policy or unknown task type yields the
 * all-required default — both fail safe toward *more* gating.
 */
export function resolveMergeRequirements(
  policy: MergePolicy | undefined,
  taskType: string | undefined,
): MergeRequirements {
  const effective: MergeRequirements = { ...DEFAULT_MERGE_REQUIREMENTS };
  if (!policy) return effective;
  Object.assign(effective, policy.defaults ?? {});
  const override = taskType ? policy.byTaskType?.[taskType] : undefined;
  if (override) Object.assign(effective, override);
  return effective;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate an untrusted `Partial<MergeRequirements>`: only known keys, only booleans. */
function validateRequirements(
  value: unknown,
  where: string,
): { ok: true; requirements: Partial<MergeRequirements> } | { ok: false; error: string } {
  if (!isPlainObject(value)) {
    return { ok: false, error: `${where} must be an object.` };
  }
  const requirements: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!REQUIREMENT_KEYS.includes(key as keyof MergeRequirements)) {
      return {
        ok: false,
        error: `${where} has unknown requirement "${key}" (expected one of ${REQUIREMENT_KEYS.join(", ")}).`,
      };
    }
    if (typeof raw !== "boolean") {
      return { ok: false, error: `${where}.${key} must be a boolean.` };
    }
    requirements[key] = raw;
  }
  return { ok: true, requirements };
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
    if (key !== "defaults" && key !== "byTaskType") {
      return {
        ok: false,
        error: `merge policy has unknown key "${key}" (expected "defaults" or "byTaskType").`,
      };
    }
  }
  const policy: { defaults?: Partial<MergeRequirements>; byTaskType?: Record<string, Partial<MergeRequirements>> } = {};

  if (value.defaults !== undefined) {
    const result = validateRequirements(value.defaults, "merge policy defaults");
    if (!result.ok) return result;
    policy.defaults = result.requirements;
  }

  if (value.byTaskType !== undefined) {
    if (!isPlainObject(value.byTaskType)) {
      return { ok: false, error: "merge policy byTaskType must be an object keyed by task type." };
    }
    const byTaskType: Record<string, Partial<MergeRequirements>> = {};
    for (const [taskType, requirements] of Object.entries(value.byTaskType)) {
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
 * a value that fails validation, all degrade to `undefined` (all-required) — this
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
