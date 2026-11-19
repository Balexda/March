import { randomUUID } from "node:crypto";
import type { MultiProfileState, ReviewBackoffRecord } from "../../../herald/events.js";
import type { CodeRabbitStanding } from "../../../observe/coderabbit-review.js";
import type { ReviewerNotice } from "../../../observe/review-bot-comments.js";
import { backoffMs } from "../pure/self-heal.js";

export type ReviewPostOutcome =
  | { ok: true }
  | { ok: false; kind: "rate_limited"; resetAt?: string }
  | { ok: false; kind: "failed"; detail: string };

export interface ReviewTarget {
  profile: string;
  sliceId: string;
  pr: number;
}

type ReviewSignal = ReviewTarget & {
  cause: ReviewBackoffRecord["cause"];
  at: string;
  resetAt?: string;
  noticeId?: string;
};

type LatestIntent = NonNullable<NonNullable<MultiProfileState["latestReviewRequests"]>["coderabbit"]>;
type Report = (target: ReviewTarget, outcome: "backoff" | "failed", detail: string, rateLimitHit?: boolean) => void;

const reviewer = "coderabbit";

export class CodeRabbitBackoff {
  private current?: ReviewBackoffRecord & { seq: number; ts: string };
  private seen = new Set<string>();
  private pending?: { target: ReviewTarget; record: ReviewBackoffRecord; id: string };
  private startupIntent?: LatestIntent;
  private started = false;

  constructor(private readonly append: (profile: string, record: ReviewBackoffRecord, id: string) => Promise<{ seq: number; ts: string }>) {}

  async beginTick(
    fold: MultiProfileState,
    signals: ReviewSignal[],
    now: number,
    verify: (intent: LatestIntent) => Promise<boolean>,
    report: Report,
  ): Promise<void> {
    const folded = fold.reviewBackoffs?.[reviewer];
    this.current = folded;
    this.seen = new Set(Object.keys(fold.reviewNoticeIds ?? {}));
    if (!this.started) {
      this.started = true;
      this.startupIntent = fold.latestReviewRequests?.[reviewer];
    }
    if (this.pending && !await this.persist(report)) return;
    if (this.startupIntent && (this.current?.seq ?? 0) > this.startupIntent.seq) this.startupIntent = undefined;

    const intent = this.startupIntent;
    if (intent) {
      let verified: boolean | undefined;
      try {
        verified = await verify(intent);
      } catch (error) {
        report(intent, "failed", `Could not verify prior CodeRabbit trigger: ${String(error)}`);
      }
      if (verified === false) {
        report(intent, "failed", "Prior CodeRabbit post outcome is unknown");
        if (!await this.record({ ...intent, cause: "post_failed" }, now, report)) return;
      }
      if (verified !== undefined) this.startupIntent = undefined;
    }

    for (const signal of signals.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      const observed = Date.parse(signal.at);
      const previous = Date.parse(this.current?.signalAt ?? this.current?.ts ?? "");
      if (!Number.isFinite(observed) || observed > now || observed < previous) continue;
      if (signal.cause === "reset" && (!this.current?.attempts || observed <= previous)) continue;
      if (signal.noticeId && (this.seen.has(signal.noticeId) || this.current?.cause === "reset" && observed <= previous)) continue;
      if (!await this.record(signal, now, report)) return;
    }
  }

  blocked(now: number): boolean {
    return !!(this.pending || this.startupIntent || Date.parse(this.current?.until ?? "") > now);
  }

  async record(signal: ReviewSignal, now: number, report: Report): Promise<boolean> {
    const signalTime = Date.parse(signal.at);
    const attempts = signal.cause === "reset" ? 0 : Math.min(Number.MAX_SAFE_INTEGER, (this.current?.attempts ?? 0) + 1);
    const stated = Date.parse(signal.resetAt ?? "");
    const deadline = attempts === 0 ? now : stated > signalTime ? stated : signalTime + backoffMs(attempts, reviewer);
    if (signal.noticeId && (stated <= now || deadline <= now)) return true;
    const record: ReviewBackoffRecord = {
      reviewer, attempts, cause: signal.cause, signalAt: signal.at,
      until: new Date(deadline).toISOString(),
      ...(signal.noticeId ? { noticeId: signal.noticeId } : {}),
    };
    this.pending = { target: signal, record, id: randomUUID() };
    if (signal.cause !== "reset" && signal.cause !== "post_failed") {
      report(signal, "backoff", `CodeRabbit ${signal.cause} until ${record.until}`, signal.cause !== "paused_comment");
    }
    return this.persist(report);
  }

  private async persist(report: Report): Promise<boolean> {
    const { target, record, id } = this.pending!;
    try {
      const { seq, ts } = await this.append(target.profile, record, id);
      if (seq >= (this.current?.seq ?? 0)) this.current = { ...record, seq, ts };
    } catch (error) {
      report(target, "failed", `Could not persist CodeRabbit back-off: ${String(error)}`);
      return false;
    }
    if (record.noticeId) this.seen.add(record.noticeId);
    this.pending = undefined;
    return true;
  }
}

interface ReviewSnapshot {
  number?: number;
  url?: string;
  error?: string;
  skipped?: boolean;
  head_sha?: string;
  reviewer_notices?: ReviewerNotice[];
  coderabbit?: Pick<CodeRabbitStanding, "review_times_by_head"> | null;
}

export function reviewSignals(profile: string, repo: string, sliceId: string, snapshot: unknown): ReviewSignal[] {
  const pr = snapshot as ReviewSnapshot | null | undefined;
  if (!pr || pr.error || pr.skipped || typeof pr.number !== "number" || !Number.isSafeInteger(pr.number) || pr.number < 1) return [];
  const target = { profile, sliceId, pr: pr.number };
  const notices = Array.isArray(pr.reviewer_notices) ? pr.reviewer_notices : [];
  const signals: ReviewSignal[] = notices.flatMap((notice) => {
    if (notice?.reviewer !== reviewer || (notice.kind !== "rate_limited" && notice.kind !== "paused")) return [];
    return [{
      ...target, at: notice.created_at, resetAt: notice.reset_at,
      cause: notice.kind === "paused" ? "paused_comment" : "rate_limited_comment",
      noticeId: notice.comment_id !== undefined
        ? `coderabbit:${notice.comment_id}`
        : JSON.stringify([pr.url || repo.toLowerCase(), pr.number, notice.created_at, notice.kind]),
    }];
  });
  const head = typeof pr.head_sha === "string" ? pr.head_sha.toLowerCase() : undefined;
  const reviewedAt = head && pr.coderabbit?.review_times_by_head?.[head];
  if (reviewedAt) signals.push({ ...target, at: reviewedAt, cause: "reset" });
  return signals;
}
