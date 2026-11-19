/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { classifyReviewerComment, CODERABBIT_COMMENT_MARKER, isCodeRabbitComment, isReviewBotCommand } from "./review-bot-comments.js";

describe("classifyReviewerComment", () => {
  const createdAt = "2026-11-15T18:53:24Z";

  it.each([
    ["<!-- This is an auto-generated comment: summarize by coderabbit.ai -->", "status", undefined],
    ["> [!NOTE]\n> Currently processing new changes in this PR.", "in_progress", undefined],
    ["> ## Rate limit exceeded\n> Please wait **6 minutes and 43 seconds** before requesting another review.", "rate_limited", "2026-11-15T19:00:07.000Z"],
    ["<!-- This is an auto-generated comment: review paused by coderabbit.ai -->", "paused", undefined],
    ["> ## Reviews paused\n> Resumes at 2026-11-15T20:00:00Z", "paused", "2026-11-15T20:00:00.000Z"],
  ])("classifies CodeRabbit notice %s", (body, kind, resetAt) => {
    expect(classifyReviewerComment({ author: "coderabbitai", authorType: "Bot", body, createdAt }))
      .toEqual({ reviewer: "coderabbit", kind, resetAt });
  });

  it.each(["CoDeRaBbItAi", "coderabbitai[bot]"])("recognizes unmarked status from %s", (author) => {
    expect(classifyReviewerComment({ author, authorType: "Bot", body: "An unfamiliar notice" }))
      .toEqual({ reviewer: "coderabbit", kind: "status" });
  });

  it.each([
    { author: "coderabbitai", authorType: "User" },
    { author: "other[bot]", authorType: "Bot" },
  ])("keeps unverified feedback from $author", (actor) => {
    expect(classifyReviewerComment({ ...actor, body: "An unfamiliar notice" })).toEqual({ kind: "feedback" });
  });

  it.each(["[march-bot] @coderabbitai review", "@coderabbitai review", "<!-- march-bot:review-trigger -->"])(
    "recognizes %s only at the opening",
    (trigger) => {
      expect(classifyReviewerComment({ body: trigger })).toEqual({ kind: "trigger" });
      expect(classifyReviewerComment({ body: "Why did March post this?\n" + trigger })).toEqual({ kind: "feedback" });
    },
  );
});

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
