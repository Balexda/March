/**
 * CodeRabbit's review standing on a PR, for the legate's re-review request.
 *
 * CodeRabbit (with its request-changes workflow) leaves a `CHANGES_REQUESTED`
 * review, and GitHub keeps blocking the merge on it until CodeRabbit reviews
 * again and approves. Resolving its threads is not enough. Auto-review is off at
 * the org level, so after the steward pushes a fix nothing asks for that second
 * review and the PR sits. Sensing therefore reports what the legate needs to
 * decide whether to post `@coderabbitai review`:
 *
 * - `decision` / `decision_commit_sha` / `decision_at`: CodeRabbit's latest
 *   decisive review (`APPROVED`, `CHANGES_REQUESTED` or `DISMISSED`). Its
 *   `COMMENTED` reviews are skipped: a reply in a thread is filed as one, at the
 *   current head, and must not read as "head already reviewed".
 * - `last_review_commit_sha`: the commit CodeRabbit's newest review of any state
 *   (thread replies included) is on, or `null` when it has never reviewed the
 *   PR.
 * - `last_request_at`: when the newest conversation comment opening with
 *   `@coderabbitai review` (or `full review`) was posted, by anyone.
 * - `last_request_sha`: the head named by the newest sampled March trigger.
 * - `review_times_by_head` and `trigger_times_by_head`: the latest raw review
 *   and earliest sampled marked trigger per head, from GitHub timestamps.
 * - `trigger_history`: every sampled marked trigger in chronological order, so
 *   a SHA-less notice can be attributed to the trigger that preceded it even
 *   when triggers alternate between heads.
 *
 * Pure, so it is unit-testable without `gh`.
 */

/** CodeRabbit's GitHub App login, as review authors report it. */
export const CODERABBIT_LOGINS: ReadonlySet<string> = new Set(["coderabbitai", "coderabbitai[bot]"]);

/** The review command the legate posts, and the forms it recognizes as already posted. */
export const CODERABBIT_REVIEW_COMMAND = "@coderabbitai review";
const REVIEW_REQUEST_RE = /^@coderabbitai\s+(?:full\s+)?review\b/i;
const REQUEST_MARKER_RE = /<!--\s*march-coderabbit-request:([0-9a-f]{7,40})\s*-->/i;

/**
 * The comment the legate posts: the command on the first line (so CodeRabbit
 * and the review-bot comment filter both recognize it), then a marker naming
 * the head it was posted for.
 */
export function reviewRequestBody(headSha: string): string {
  return `${CODERABBIT_REVIEW_COMMAND}\n\n<!-- march-coderabbit-request:${headSha} -->`;
}

export function markedCodeRabbitHead(body: unknown): string | undefined {
  return isCodeRabbitReviewRequest(body)
    ? REQUEST_MARKER_RE.exec(String(body))?.[1]?.toLowerCase()
    : undefined;
}

export interface CodeRabbitStanding {
  review_times_by_head?: Record<string, string>;
  trigger_times_by_head?: Record<string, string>;
  trigger_history?: Array<{ head_sha: string; at: string }>;
  decision: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | null;
  decision_commit_sha: string | null;
  /** Set only when the full review list establishes the latest bot verdict. */
  decision_is_bot?: true;
  decision_at: string | null;
  last_review_commit_sha: string | null;
  last_request_at: string | null;
  last_request_sha: string | null;
}

const DECISIVE = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/** True when a conversation comment body asks CodeRabbit for a review. */
export function isCodeRabbitReviewRequest(body: unknown): boolean {
  return typeof body === "string" && REVIEW_REQUEST_RE.test(body.trimStart());
}

/** A GraphQL `author` that is a bot: typed `Bot`, or a login ending in `[bot]`
 *  (covers GitHub Apps that present as Users, e.g. Copilot). An ordinary user can
 *  be neither — GitHub logins cannot contain brackets. */
export function isBotActor(author: { __typename?: string; login?: string } | null | undefined): boolean {
  return author?.__typename === "Bot" || String(author?.login || "").endsWith("[bot]");
}

/**
 * Reduce a PR's review and comment nodes to CodeRabbit's standing, or `null`
 * when CodeRabbit has neither reviewed (in any state) nor been asked to.
 */
export function summarizeCodeRabbit(
  reviewNodes: unknown,
  commentNodes: unknown,
  reviewsComplete = true,
): CodeRabbitStanding | null {
  const reviews = Array.isArray(reviewNodes) ? reviewNodes : [];
  const comments = Array.isArray(commentNodes) ? commentNodes : [];
  const reviewTimes: Record<string, string> = {};
  const triggerTimes: Record<string, string> = {};
  const triggerHistory: Array<{ head_sha: string; at: string }> = [];
  let decisive: any = null;
  let latest: any = null;
  for (const r of reviews) {
    if (!CODERABBIT_LOGINS.has(String(r?.author?.login || ""))) continue;
    const oid = r?.commit?.oid;
    const sha = typeof oid === "string" ? oid.toLowerCase() : undefined;
    const at = r?.submittedAt;
    if (typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha) &&
        typeof at === "string" && Date.parse(at) > Date.parse(reviewTimes[sha] ?? "1970-01-01")) {
      reviewTimes[sha] = at;
    }
    if (!latest || String(r?.submittedAt) >= String(latest?.submittedAt)) latest = r;
    if (!DECISIVE.has(String(r?.state))) continue;
    if (!decisive || String(r?.submittedAt) >= String(decisive?.submittedAt)) decisive = r;
  }
  let lastRequestAt: string | null = null;
  let lastMarked: { at: string; sha: string } | null = null;
  for (const c of comments) {
    if (!isCodeRabbitReviewRequest(c?.body) || typeof c?.createdAt !== "string") continue;
    if (lastRequestAt === null || c.createdAt > lastRequestAt) lastRequestAt = c.createdAt;
    const sha = markedCodeRabbitHead(c.body);
    if (sha && (!triggerTimes[sha] || Date.parse(c.createdAt) < Date.parse(triggerTimes[sha]))) {
      triggerTimes[sha] = c.createdAt;
    }
    if (sha) triggerHistory.push({ head_sha: sha, at: c.createdAt });
    if (sha && (!lastMarked || c.createdAt > lastMarked.at)) lastMarked = { at: c.createdAt, sha };
  }
  if (!latest && lastRequestAt === null) return null;
  return {
    ...(Object.keys(reviewTimes).length ? { review_times_by_head: reviewTimes } : {}),
    ...(Object.keys(triggerTimes).length ? { trigger_times_by_head: triggerTimes } : {}),
    ...(triggerHistory.length
      ? { trigger_history: triggerHistory.sort((left, right) => Date.parse(left.at) - Date.parse(right.at)) }
      : {}),
    decision: decisive ? (decisive.state as CodeRabbitStanding["decision"]) : null,
    decision_commit_sha: typeof decisive?.commit?.oid === "string" ? decisive.commit.oid : null,
    ...(reviewsComplete && isBotActor(decisive?.author) ? { decision_is_bot: true as const } : {}),
    decision_at: typeof decisive?.submittedAt === "string" ? decisive.submittedAt : null,
    last_review_commit_sha: typeof latest?.commit?.oid === "string" ? latest.commit.oid : null,
    last_request_at: lastRequestAt,
    last_request_sha: lastMarked?.sha ?? null,
  };
}
