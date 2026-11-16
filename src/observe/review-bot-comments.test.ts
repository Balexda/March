/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { CODERABBIT_COMMENT_MARKER, isCodeRabbitComment, isReviewBotCommand } from "./review-bot-comments.js";

describe("isCodeRabbitComment", () => {
  it("matches CodeRabbit's summary, command ack and chat reply, as observed on a real PR", () => {
    const opening = (rest: string) => `${CODERABBIT_COMMENT_MARKER}\n\n${rest}`;
    expect(isCodeRabbitComment(opening("<!-- This is an auto-generated comment: summarize by coderabbit.ai -->"))).toBe(true);
    expect(isCodeRabbitComment(opening("<!-- This is an auto-generated reply by CodeRabbit -->"))).toBe(true);
    expect(isCodeRabbitComment(`  \n${CODERABBIT_COMMENT_MARKER}\n@me Thanks for the update.`)).toBe(true);
  });

  it("does not match a comment that only quotes or mentions the marker", () => {
    expect(isCodeRabbitComment(`Why does the bot write ${CODERABBIT_COMMENT_MARKER}?`)).toBe(false);
    expect(isCodeRabbitComment("please fix the retry budget")).toBe(false);
    expect(isCodeRabbitComment(undefined)).toBe(false);
  });
});

describe("isReviewBotCommand", () => {
  it("matches a comment that opens with a review-bot command", () => {
    expect(isReviewBotCommand("@coderabbitai review")).toBe(true);
    expect(isReviewBotCommand("  @CodeRabbitAI full review")).toBe(true);
    expect(isReviewBotCommand("@coderabbitai")).toBe(true);
    expect(isReviewBotCommand("@codex review")).toBe(true);
  });

  it("does not match a mid-comment mention, a lookalike handle, or a non-string", () => {
    expect(isReviewBotCommand("Thanks — @coderabbitai please re-check the cache key")).toBe(false);
    expect(isReviewBotCommand("@codexbot review")).toBe(false);
    expect(isReviewBotCommand("@reviewer please look")).toBe(false);
    expect(isReviewBotCommand(null)).toBe(false);
  });
});
