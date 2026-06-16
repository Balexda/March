/**
 * Stable content marker prefixed to every March-posted PR *conversation*
 * (non-thread) comment reply, and the predicate the capture uses to skip them
 * (issue #374).
 *
 * The non-thread comment capture (#366) is **author-independent by design**: the
 * steward, the human reviewer, and the bot all post under the *same* GitHub
 * token, so the steward's own replies are indistinguishable from reviewer
 * comments by author. Without a marker the next capture pass re-processes the
 * steward's reply as fresh feedback — a feedback loop. A content marker, not the
 * author, is therefore what lets the capture recognize its own replies. This is
 * belt-and-suspenders alongside the existing `:eyes:` reaction + comment-id
 * dedup (which stays as-is).
 */
export const MARCH_BOT_MARKER = "[march-bot]";

/**
 * True when a captured conversation comment is one of March's own replies — i.e.
 * its body carries {@link MARCH_BOT_MARKER}. The capture retains only a bounded
 * `body_preview`, but the marker is a leading prefix, so a substring check over
 * the preview is sufficient and robust to truncation.
 */
export function isMarchBotComment(comment: any): boolean {
  return typeof comment?.body_preview === "string" && comment.body_preview.includes(MARCH_BOT_MARKER);
}
