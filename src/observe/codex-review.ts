/**
 * Codex's automatic pull-request review summary: recognition + state parsing.
 *
 * When a PR opens, Codex posts ONE conversation (issue) comment from its GitHub
 * App and edits it in place as its review runs and finishes. The body opens with
 * two HTML comments:
 *
 *   <!-- codex-pull-request-review-summary -->
 *   <!-- codex-review-state:v1 {"code_review":{"commit_sha":"…","has_any_findings":false,
 *        "has_unresolved_findings":false,"status":"completed"},"security_review":{…}} -->
 *
 * It is a status notice, not feedback — Codex posts actual findings separately.
 * Sensing (`sense-io.ts`) therefore drops it from the conversation comments, so no
 * consumer treats it as a comment owing a reply, and surfaces the machine-readable
 * state on the sensed PR instead. Dependency-free and pure so both halves are
 * unit-testable without `gh`.
 */

/** The HTML comment Codex's review-summary comment opens with. */
export const CODEX_REVIEW_SUMMARY_MARKER = "<!-- codex-pull-request-review-summary -->";

/**
 * Codex's code-review state for a PR, from the `codex-review-state:v1` marker.
 * Each field is `null` when Codex reported no value for it (e.g. no code review
 * has started yet).
 */
export interface CodexReviewState {
  /** The commit the review ran against — compare with the PR's `head_sha` to tell
   *  a review of the current head from one of an earlier push. */
  commit_sha: string | null;
  /** Codex's own status string, passed through verbatim (a finished review reads
   *  `"completed"`); deliberately not interpreted here. */
  status: string | null;
  has_unresolved_findings: boolean | null;
}

/**
 * True when a conversation comment body is Codex's review summary — i.e. it
 * *opens* with {@link CODEX_REVIEW_SUMMARY_MARKER}. Keyed on the marker, not the
 * author: Codex may also post real findings as comments, and those must still be
 * captured. A prefix check, not a substring `includes`, for the same reason as
 * `isMarchBotComment`: a reviewer who merely quotes or mentions the marker
 * mid-comment is leaving genuine feedback. `trimStart` tolerates incidental
 * leading whitespace.
 */
export function isCodexReviewSummary(body: unknown): boolean {
  return typeof body === "string" && body.trimStart().startsWith(CODEX_REVIEW_SUMMARY_MARKER);
}

// The state marker's JSON payload: everything up to the `}` that closes the HTML
// comment. Pinned to `v1` — a later schema version is not guessed at.
const CODEX_REVIEW_STATE_RE = /<!--\s*codex-review-state:v1\s+(\{[\s\S]*?\})\s*-->/;

/**
 * Parse the code-review state out of a Codex review-summary comment body. Returns
 * `null` when the body is not the summary comment, or carries no parseable `v1`
 * state — malformed input is never thrown, so one odd comment cannot fail a PR
 * observation.
 *
 * Takes the FULL body: the state marker runs well past the 280-char
 * `body_preview` the sensed conversation comments keep, which is why this is
 * parsed at sensing rather than by a downstream consumer. It reads the body only
 * — whose summary to trust (anyone can paste the markers) is the caller's call.
 */
export function parseCodexReviewState(body: unknown): CodexReviewState | null {
  if (!isCodexReviewSummary(body)) return null;
  const match = CODEX_REVIEW_STATE_RE.exec(body as string);
  if (!match) return null;
  let state: any;
  try {
    state = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const review = state?.code_review;
  if (!review || typeof review !== "object") return null;
  return {
    commit_sha: typeof review.commit_sha === "string" && review.commit_sha.length > 0 ? review.commit_sha : null,
    status: typeof review.status === "string" && review.status.length > 0 ? review.status : null,
    has_unresolved_findings:
      typeof review.has_unresolved_findings === "boolean" ? review.has_unresolved_findings : null,
  };
}
