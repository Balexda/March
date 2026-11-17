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
 * - `last_request_at`: when the newest conversation comment opening with
 *   `@coderabbitai review` (or `full review`) was posted, by anyone. Compared
 *   with the head commit's date, it tells the legate the current head was
 *   already put forward, which keeps the request durable across a legate restart.
 *
 * Pure, so it is unit-testable without `gh`.
 */

/** CodeRabbit's GitHub App login, as review authors report it. */
export const CODERABBIT_LOGINS: ReadonlySet<string> = new Set(["coderabbitai", "coderabbitai[bot]"]);

/** The review command the legate posts, and the forms it recognizes as already posted. */
export const CODERABBIT_REVIEW_COMMAND = "@coderabbitai review";
const REVIEW_REQUEST_RE = /^@coderabbitai\s+(?:full\s+)?review\b/i;

export interface CodeRabbitStanding {
  decision: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | null;
  decision_commit_sha: string | null;
  decision_at: string | null;
  last_request_at: string | null;
}

const DECISIVE = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/** True when a conversation comment body asks CodeRabbit for a review. */
export function isCodeRabbitReviewRequest(body: unknown): boolean {
  return typeof body === "string" && REVIEW_REQUEST_RE.test(body.trimStart());
}

/**
 * Reduce a PR's review and comment nodes to CodeRabbit's standing, or `null`
 * when CodeRabbit has neither reviewed nor been asked to.
 */
export function summarizeCodeRabbit(reviewNodes: unknown, commentNodes: unknown): CodeRabbitStanding | null {
  const reviews = Array.isArray(reviewNodes) ? reviewNodes : [];
  const comments = Array.isArray(commentNodes) ? commentNodes : [];
  let decisive: any = null;
  for (const r of reviews) {
    if (!CODERABBIT_LOGINS.has(String(r?.author?.login || ""))) continue;
    if (!DECISIVE.has(String(r?.state))) continue;
    if (!decisive || String(r?.submittedAt) >= String(decisive?.submittedAt)) decisive = r;
  }
  let lastRequestAt: string | null = null;
  for (const c of comments) {
    if (!isCodeRabbitReviewRequest(c?.body) || typeof c?.createdAt !== "string") continue;
    if (lastRequestAt === null || c.createdAt > lastRequestAt) lastRequestAt = c.createdAt;
  }
  if (!decisive && lastRequestAt === null) return null;
  return {
    decision: decisive ? (decisive.state as CodeRabbitStanding["decision"]) : null,
    decision_commit_sha: typeof decisive?.commit?.oid === "string" ? decisive.commit.oid : null,
    decision_at: typeof decisive?.submittedAt === "string" ? decisive.submittedAt : null,
    last_request_at: lastRequestAt,
  };
}
