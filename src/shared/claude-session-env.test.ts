/**
 * @l1 @deterministic @ci
 */
import { describe, it, expect } from "vitest";
import {
  buildSessionCompactionEnv,
  sessionCompactionSettings,
} from "./claude-session-env.js";

describe("buildSessionCompactionEnv", () => {
  it("defaults to the 1h cache TTL, the idle-compaction floor, and a 200k window", () => {
    expect(buildSessionCompactionEnv({})).toEqual({
      CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
      CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "100000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
    });
  });

  it("applies valid operator overrides", () => {
    expect(
      buildSessionCompactionEnv({
        MARCH_SESSION_CACHE_TTL: " 5M ",
        MARCH_SESSION_IDLE_COMPACT_MIN_TOKENS: "150000",
        MARCH_SESSION_AUTO_COMPACT_WINDOW: "400000",
      }),
    ).toEqual({
      CLAUDE_CODE_PROMPT_CACHE_TTL: "5m",
      CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "150000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000",
    });
  });

  it("falls back to the defaults for unparseable overrides", () => {
    expect(
      buildSessionCompactionEnv({
        MARCH_SESSION_CACHE_TTL: "30m",
        MARCH_SESSION_IDLE_COMPACT_MIN_TOKENS: "lots",
        MARCH_SESSION_AUTO_COMPACT_WINDOW: "200k",
      }),
    ).toEqual(buildSessionCompactionEnv({}));
  });

  it("clamps token counts into Claude Code's documented ranges", () => {
    const low = buildSessionCompactionEnv({
      MARCH_SESSION_IDLE_COMPACT_MIN_TOKENS: "5",
      MARCH_SESSION_AUTO_COMPACT_WINDOW: "5",
    });
    expect(low.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS).toBe("100000");
    expect(low.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("100000");

    const high = buildSessionCompactionEnv({
      MARCH_SESSION_AUTO_COMPACT_WINDOW: "9000000",
    });
    expect(high.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
  });

  it.each(["0", "false", "OFF"])("emits nothing when MARCH_SESSION_COMPACTION=%s", (flag) => {
    expect(buildSessionCompactionEnv({ MARCH_SESSION_COMPACTION: flag })).toEqual({});
  });
});

describe("sessionCompactionSettings", () => {
  it("wraps the vars in an env block", () => {
    expect(sessionCompactionSettings({})).toEqual({
      env: buildSessionCompactionEnv({}),
    });
  });

  it("omits the env key entirely when tuning is disabled", () => {
    expect(sessionCompactionSettings({ MARCH_SESSION_COMPACTION: "0" })).toEqual({});
  });
});
