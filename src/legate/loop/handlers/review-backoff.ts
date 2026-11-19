import { randomUUID } from "node:crypto";
import type { MultiProfileState, ReviewBackoffRecord } from "../../../herald/events.js";
import type { CodeRabbitStanding } from "../../../observe/coderabbit-review.js";
import type { ReviewerNotice } from "../../../observe/review-bot-comments.js";
import { backoffMs } from "../pure/self-heal.js";

export type ReviewPostOutcome =
  | { ok: true }
  | { ok: false; kind: "rate_limited"; resetAt?: string }
  | { ok: false; kind: "failed" | "identity_unavailable"; detail: string };

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

export type LatestIntent = NonNullable<NonNullable<MultiProfileState["latestReviewRequests"]>[ReviewBackoffRecord["reviewer"]]>;
type Report = (target: ReviewTarget, outcome: "backoff" | "failed", detail: string, rateLimitHit?: boolean) => void;

export class ReviewerBackoff {
  private current?: ReviewBackoffRecord & { seq: number; ts: string };
  private seen = new Set<string>();
  private resetBoundary = NaN;
  private pending?: { target: ReviewTarget; record: ReviewBackoffRecord; id: string };
  private startupIntent?: LatestIntent;
  private started = false;

  constructor(
    private readonly append: (profile: string, record: ReviewBackoffRecord, id: string) => Promise<{ seq: number; ts: string }>,
    readonly reviewer: ReviewBackoffRecord["reviewer"] = "coderabbit",
  ) {}

  async beginTick(
    fold: MultiProfileState,
    signals: ReviewSignal[],
    now: number,
    verify: (intent: LatestIntent) => Promise<boolean>,
    report: Report,
  ): Promise<void> {
    const reviewer = this.reviewer;
    const folded = fold.reviewBackoffs?.[reviewer];
    this.current = folded;
    this.seen = new Set(Object.keys(fold.reviewNoticeIds ?? {}));
    this.resetBoundary = Date.parse(fold.reviewResetBoundaries?.[reviewer] ?? "");
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
        report(intent, "failed", `Could not verify prior ${reviewer} request: ${String(error)}`);
      }
      if (verified === false) {
        report(intent, "failed", `${reviewer} prior post outcome is unknown`);
        if (!await this.record({ ...intent, cause: "post_failed" }, now, report)) return;
      }
      if (verified !== undefined) this.startupIntent = undefined;
    }

    for (const signal of signals.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      const observed = Date.parse(signal.at);
      const previous = Date.parse(this.current?.signalAt ?? this.current?.ts ?? "");
      if (!Number.isFinite(observed) || observed > now) continue;
      if (signal.cause === "reset") {
        if (observed <= this.resetBoundary) continue;
        if (this.current?.attempts && observed > previous) {
          if (!await this.record(signal, now, report)) return;
        } else if (!this.startupIntent && !await this.observeReset(signal, now, report)) {
          // While a startup outcome is unresolved, a boundary-only append would look
          // like a newer back-off and wrongly settle it; the signal is re-sensed later.
          return;
        }
        continue;
      }
      // Notices dedupe by identity: a late-delivered notice older than the last
      // signal can still carry a later stated reset. Other signals stay chronological.
      if (!signal.noticeId && observed < previous) continue;
      // A notice from before the last reset is stale even after later throttle records.
      if (signal.noticeId && (this.seen.has(signal.noticeId) || observed <= this.resetBoundary)) continue;
      if (!await this.record(signal, now, report)) return;
    }
  }

  blocked(now: number): boolean {
    return !!(this.pending || this.startupIntent || Date.parse(this.current?.until ?? "") > now);
  }

  async record(signal: ReviewSignal, now: number, report: Report): Promise<boolean> {
    const reviewer = this.reviewer;
    const signalTime = Date.parse(signal.at);
    const attempts = signal.cause === "reset" ? 0 : Math.min(Number.MAX_SAFE_INTEGER, (this.current?.attempts ?? 0) + 1);
    const stated = Date.parse(signal.resetAt ?? "");
    const own = attempts === 0 ? now : stated > signalTime ? stated : signalTime + backoffMs(attempts, reviewer);
    // An expired notice cannot re-arm back-off, even while another deadline is active.
    if (signal.noticeId && (stated <= now || own <= now)) return true;
    // A throttle signal never shortens an active deadline; only a reset clears it.
    const active = Date.parse(this.current?.until ?? "");
    const deadline = attempts > 0 && active > own ? active : own;
    const record: ReviewBackoffRecord = {
      reviewer, attempts, cause: signal.cause, signalAt: signal.at,
      until: new Date(deadline).toISOString(),
      ...(signal.noticeId ? { noticeId: signal.noticeId } : {}),
    };
    this.pending = { target: signal, record, id: randomUUID() };
    if (signal.cause !== "reset" && signal.cause !== "post_failed") {
      report(signal, "backoff", `${reviewer} ${signal.cause} until ${record.until}`, signal.cause !== "paused_comment");
    }
    return this.persist(report);
  }

  /**
   * Persist a fresh-review boundary without clearing pacing: with an active
   * throttle newer than the review, repeat that throttle with `resetObservedAt`;
   * otherwise there is nothing to clear, so record a plain reset.
   */
  private async observeReset(signal: ReviewSignal, now: number, report: Report): Promise<boolean> {
    const reviewer = this.reviewer;
    const current = this.current;
    const record: ReviewBackoffRecord = current?.attempts
      ? {
        reviewer, until: current.until, attempts: current.attempts, cause: current.cause,
        // Keep the comparison time beginTick uses (signalAt, else the event ts).
        signalAt: current.signalAt ?? current.ts,
        resetObservedAt: signal.at,
      }
      : { reviewer, until: new Date(now).toISOString(), attempts: 0, cause: "reset", signalAt: signal.at };
    this.pending = { target: signal, record, id: randomUUID() };
    return this.persist(report);
  }

  private async persist(report: Report): Promise<boolean> {
    const { target, record, id } = this.pending!;
    try {
      const { seq, ts } = await this.append(target.profile, record, id);
      if (seq >= (this.current?.seq ?? 0)) this.current = { ...record, seq, ts };
    } catch (error) {
      report(target, "failed", `Could not persist ${this.reviewer} back-off: ${String(error)}`);
      return false;
    }
    if (record.noticeId) this.seen.add(record.noticeId);
    const boundary = Date.parse((record.cause === "reset" ? record.signalAt : record.resetObservedAt) ?? "");
    // Ordinary throttle records carry no boundary; never let them erase one.
    if (Number.isFinite(boundary) && !(this.resetBoundary >= boundary)) this.resetBoundary = boundary;
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
  copilot_review_times?: Record<string, string>;
  reviews_complete?: boolean;
}

export function reviewSignals(profile: string, repo: string, sliceId: string, snapshot: unknown, reviewer: ReviewBackoffRecord["reviewer"] = "coderabbit"): ReviewSignal[] {
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
        ? `${reviewer}:${notice.comment_id}`
        : JSON.stringify([pr.url || repo.toLowerCase(), pr.number, notice.created_at, notice.kind, ...(reviewer === "copilot" ? [reviewer] : [])]),
    }];
  });
  const head = typeof pr.head_sha === "string" ? pr.head_sha.toLowerCase() : undefined;
  const reviewedAt = head && (reviewer === "coderabbit" ? pr.coderabbit?.review_times_by_head?.[head]
    : pr.reviews_complete === true && pr.copilot_review_times?.[head]);
  if (reviewedAt) signals.push({ ...target, at: reviewedAt, cause: "reset" });
  return signals;
}

type TriggerLookup = (repoPath: string, prNumber: number, head: string, sliceId: string, since?: number) => Promise<string | undefined>;

/**
 * Decide whether the reviewer's latest pre-restart intent produced a post.
 * `true` = a review or March trigger proves it; `false` = outcome unknown, so the
 * caller durably records `post_failed`. Throws only when the lookup itself is
 * incomplete (retry next tick). An intent whose profile is no longer registered
 * cannot be looked up again; treating it as unknown reconciles it durably instead
 * of wedging every other profile behind it.
 */
export async function verifyStartupIntent(
  intent: LatestIntent,
  fold: MultiProfileState,
  profiles: ReadonlyMap<string, { repoPath: string }>,
  findTrigger: TriggerLookup,
): Promise<boolean> {
  const pr = fold.byProfile[intent.profile]?.slices[intent.sliceId]?.pr as
    ReviewSnapshot | undefined;
  // GitHub timestamps are second-precision. Ignore markers from earlier attempts.
  const since = Math.floor(Date.parse(intent.at) / 1000) * 1000;
  const reviewTimes = intent.reviewer === "copilot" ? pr?.copilot_review_times : pr?.coderabbit?.review_times_by_head;
  if (!pr?.error && !pr?.skipped && pr?.number === intent.pr && pr.reviews_complete === true &&
      Date.parse(reviewTimes?.[intent.headSha] ?? "") >= since) return true;
  // GitHub reviewer requests have no durable head-specific marker to look up.
  if (intent.reviewer === "copilot") return false;
  const profile = profiles.get(intent.profile);
  if (!profile) return false;
  try {
    return !!await findTrigger(profile.repoPath, intent.pr, intent.headSha, intent.sliceId, since);
  } catch (error) {
    // A missing or deleted PR/repo cannot answer on retry: settle it as unknown so
    // the durable post_failed path runs. Anything else (5xx, rate limit, partial
    // history, network) stays retryable.
    if (isPermanentLookupFailure(error)) return false;
    throw error;
  }
}

const PERMANENT_LOOKUP_STATUSES = new Set([404, 410]);

function isPermanentLookupFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && PERMANENT_LOOKUP_STATUSES.has(status);
}
