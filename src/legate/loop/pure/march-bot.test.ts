import { describe, expect, it } from "vitest";
import { MARCH_BOT_MARKER, isMarchBotComment } from "./march-bot.js";

describe("march-bot marker (#374)", () => {
  it("exposes the stable [march-bot] marker", () => {
    expect(MARCH_BOT_MARKER).toBe("[march-bot]");
  });

  it("detects March's own reply by its body_preview prefix", () => {
    expect(isMarchBotComment({ body_preview: "[march-bot] Fixed in abc123: tightened the gate" })).toBe(true);
  });

  it("does not match a reviewer comment that lacks the marker", () => {
    expect(isMarchBotComment({ body_preview: "please reconsider the spec" })).toBe(false);
  });

  it("is robust to a missing / non-string body_preview", () => {
    expect(isMarchBotComment({})).toBe(false);
    expect(isMarchBotComment(null)).toBe(false);
    expect(isMarchBotComment({ body_preview: 123 })).toBe(false);
  });
});
