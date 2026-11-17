/**
 * Review-bot conversation comments that are NOT feedback for the steward.
 *
 * Sensing (`sense-io.ts`) drops these from a PR's conversation comments, so babysit
 * never dispatches a `/smithy.fix` turn for them and they never count as an
 * `owes_comments` merge blocker. Two kinds:
 *
 * - **CodeRabbit's own comments.** Its walkthrough/summary, its replies to a
 *   `@coderabbitai` command ("review triggered"), and its chat replies all open
 *   with `<!-- coderabbit-ai-generated:v1 -->`. CodeRabbit posts its actual
 *   findings as review threads (and review bodies), which sensing reads
 *   separately, so nothing actionable is lost. Left in, each one drew a steward
 *   acknowledgement that CodeRabbit then answered: a reply loop.
 * - **Commands addressed to a review bot.** A comment that opens with
 *   `@coderabbitai` or `@codex` (e.g. `@coderabbitai review`) asks that bot to act,
 *   not the steward.
 *
 * Both are prefix matches, like `isCodexReviewSummary` and `isMarchBotComment`: a
 * reviewer who mentions the marker or a bot handle further down a comment is
 * leaving genuine feedback. Matched on the body, not the author, because the
 * command comments come from human accounts (often the same token the steward
 * uses).
 */

/** The HTML comment every CodeRabbit-authored conversation comment opens with. */
export const CODERABBIT_COMMENT_MARKER = "<!-- coderabbit-ai-generated:v1 -->";

/** Handles of review bots whose commands are not addressed to the steward. */
export const REVIEW_BOT_HANDLES = ["coderabbitai", "codex"] as const;

/** True when the body opens with CodeRabbit's generated-comment marker. */
export function isCodeRabbitComment(body: unknown): boolean {
  return typeof body === "string" && body.trimStart().startsWith(CODERABBIT_COMMENT_MARKER);
}

// `@handle` at the very start, ended by whitespace or end of body, so a different
// handle that merely starts the same way (`@codexbot`) is not mistaken for one.
const REVIEW_BOT_COMMAND_RE = new RegExp(`^@(?:${REVIEW_BOT_HANDLES.join("|")})(?:\\s|$)`, "i");

/** True when the body opens with a command to a review bot, e.g. `@coderabbitai review`. */
export function isReviewBotCommand(body: unknown): boolean {
  return typeof body === "string" && REVIEW_BOT_COMMAND_RE.test(body.trimStart());
}
