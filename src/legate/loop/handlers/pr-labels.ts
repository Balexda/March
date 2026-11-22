import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { labelDiff, resolvedReasonBody, type LabelPr } from "../pure/pr-labels.js";

/**
 * PR label reconciler. Each check lists the repo's open PRs (one `gh pr list`)
 * and reconciles the two labels the legate owns (`march:opened`,
 * `march:needs-human`; rules in pure/pr-labels.ts), adding where missing and
 * removing where they no longer apply. Other labels are never touched.
 *
 * Throttled to one listing per profile every {@link CHECK_INTERVAL_MS} (memo in
 * `state.raw.pr_labels`, ephemeral like dependency-merge's), so a steady state
 * costs one read per interval and no writes. A slice-state change shows up in the
 * next listing. Kill switch: `MARCH_LEGATE_PR_LABELS=0`.
 */

export const PR_LABEL_ADDED_ACTION = "pr-label-added";
export const PR_LABEL_REMOVED_ACTION = "pr-label-removed";
export const PR_LABEL_FAILED_ACTION = "pr-label-failed";
export const PR_REASON_POSTED_ACTION = "pr-reason-comment-posted";
export const PR_REASON_UPDATED_ACTION = "pr-reason-comment-updated";
export const PR_REASON_RESOLVED_ACTION = "pr-reason-comment-resolved";

/** Minimum gap between GitHub listings for one profile. */
export const CHECK_INTERVAL_MS = 2 * 60 * 1000;

export type OpenPr = LabelPr;

export interface PrLabelsDeps {
  /** List the repo's open PRs. Rejects on a gh failure. */
  listOpenPrs(repoPath: string): Promise<OpenPr[]>;
  addLabel(repoPath: string, prNumber: number, label: string, sliceId?: string): Promise<void>;
  removeLabel(repoPath: string, prNumber: number, label: string, sliceId?: string): Promise<void>;
  /** Find March's reason comment (by marker, paginated). Optional: reason reconciliation is skipped without it. */
  findReasonComment?(repoPath: string, prNumber: number): Promise<{ id: number; body: string } | null>;
  /** Create (no `existingId`) or edit the reason comment. */
  upsertReasonComment?(repoPath: string, prNumber: number, body: string, existingId?: number): Promise<void>;
  /** Clock seam for tests. */
  now?: () => number;
}

interface PrLabelsMemo {
  last_checked_at?: number;
}

const errMsg = (err: any): string => err?.message || String(err);

export async function apply(
  _ctx: HandlerContext,
  state: LoopState,
  deps?: PrLabelsDeps,
): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  if (process.env.MARCH_LEGATE_PR_LABELS === "0") return res;
  if (!deps || !state.repoPath) return res;
  if (!state.raw || typeof state.raw !== "object") return res;
  const repoPath = state.repoPath;
  const memo: PrLabelsMemo = (state.raw.pr_labels ??= {});
  const now = (deps.now ?? Date.now)();
  if (memo.last_checked_at !== undefined && now - memo.last_checked_at < CHECK_INTERVAL_MS) return res;
  memo.last_checked_at = now;

  let prs: OpenPr[];
  try {
    prs = await deps.listOpenPrs(repoPath);
  } catch (err) {
    res.failures.push({ action: PR_LABEL_FAILED_ACTION, detail: `list: ${errMsg(err)}` });
    return res;
  }

  const slicesByPr = new Map<number, { sliceId: string; slice: any }>();
  for (const [sliceId, slice] of Object.entries(state.slices ?? {}) as [string, any][]) {
    const pr = state.perSlice?.[sliceId]?.pr ?? slice?.pr;
    const number = Number(pr?.number);
    if (Number.isInteger(number) && number > 0) slicesByPr.set(number, { sliceId, slice });
  }

  for (const entry of labelDiff(Array.isArray(prs) ? prs : [], slicesByPr)) {
    const ops: Array<[string, "add" | "remove"]> = [
      ...entry.add.map((l) => [l, "add"] as [string, "add" | "remove"]),
      ...entry.remove.map((l) => [l, "remove"] as [string, "add" | "remove"]),
    ];
    for (const [label, op] of ops) {
      const base = { ...(entry.sliceId ? { sliceId: entry.sliceId } : {}), pr: entry.pr };
      try {
        if (op === "add") await deps.addLabel(repoPath, entry.pr, label, entry.sliceId);
        else await deps.removeLabel(repoPath, entry.pr, label, entry.sliceId);
        res.actions.push({ action: op === "add" ? PR_LABEL_ADDED_ACTION : PR_LABEL_REMOVED_ACTION, ...base, detail: label });
      } catch (err) {
        res.failures.push({ action: PR_LABEL_FAILED_ACTION, ...base, detail: `${label}: ${errMsg(err)}` });
      }
    }

    if (entry.reason !== undefined && deps.findReasonComment && deps.upsertReasonComment) {
      const base = { ...(entry.sliceId ? { sliceId: entry.sliceId } : {}), pr: entry.pr };
      try {
        const existing = await deps.findReasonComment(repoPath, entry.pr);
        if (entry.reason === "clear") {
          const resolved = resolvedReasonBody();
          if (existing && existing.body !== resolved) {
            await deps.upsertReasonComment(repoPath, entry.pr, resolved, existing.id);
            res.actions.push({ action: PR_REASON_RESOLVED_ACTION, ...base, detail: "resolved" });
          }
        } else if (!existing) {
          await deps.upsertReasonComment(repoPath, entry.pr, entry.reason.body);
          res.actions.push({ action: PR_REASON_POSTED_ACTION, ...base, detail: "posted" });
        } else if (existing.body !== entry.reason.body) {
          await deps.upsertReasonComment(repoPath, entry.pr, entry.reason.body, existing.id);
          res.actions.push({ action: PR_REASON_UPDATED_ACTION, ...base, detail: "updated" });
        }
      } catch (err) {
        res.failures.push({ action: PR_LABEL_FAILED_ACTION, ...base, detail: `reason: ${errMsg(err)}` });
      }
    }
  }
  return res;
}
