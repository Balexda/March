/** Leading prefix used by March stewards to identify their conversation replies. */
export const MARCH_BOT_MARKER = "[march-bot]";

export function hasMarchReplyMarker(body: unknown): boolean {
  return typeof body === "string" && body.trimStart().startsWith(MARCH_BOT_MARKER);
}

/** Also recognize marked replies in snapshots recorded before Herald filtered them. */
export function isMarchBotComment(comment: any): boolean {
  return hasMarchReplyMarker(comment?.body_preview);
}
