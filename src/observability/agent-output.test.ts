/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { classifyAgentFailure, parseTokenUsage } from "./agent-output.js";

// The real codex auth-lapse log captured during the smithy-profile-idle
// incident: thread.started -> turn.started -> error -> turn.failed.
const AUTH_FAILURE_LOG = [
  '{"type":"thread.started","thread_id":"019ed3fe-e353-7882-b579-137983441b6b"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."}',
  '{"type":"turn.failed","error":{"message":"Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."}}',
].join("\n");

const SUCCESS_LOG = [
  '{"type":"thread.started","thread_id":"abc"}',
  '{"type":"turn.started"}',
  '{"type":"turn.completed","usage":{"input_tokens":80762,"cached_input_tokens":70016,"output_tokens":808,"reasoning_output_tokens":83}}',
].join("\n");

describe("classifyAgentFailure", () => {
  it("classifies the codex refresh-token lapse as auth", () => {
    expect(classifyAgentFailure(AUTH_FAILURE_LOG)).toBe("auth");
  });

  it("returns none for a clean run with no error record", () => {
    expect(classifyAgentFailure(SUCCESS_LOG)).toBe("none");
  });

  it("classifies rate limits and timeouts", () => {
    expect(
      classifyAgentFailure('{"type":"error","message":"Rate limit exceeded (429), retry later"}'),
    ).toBe("rate_limit");
    expect(classifyAgentFailure('{"type":"turn.failed","error":{"message":"request timed out"}}')).toBe(
      "timeout",
    );
  });

  it("falls back to other for an unrecognized error", () => {
    expect(classifyAgentFailure('{"type":"error","message":"disk full"}')).toBe("other");
  });

  it("prefers a specific reason over a generic one regardless of order", () => {
    const log = [
      '{"type":"error","message":"something odd happened"}',
      '{"type":"turn.failed","error":{"message":"unauthorized: refresh token already used"}}',
    ].join("\n");
    expect(classifyAgentFailure(log)).toBe("auth");
  });

  it("tolerates >-prefixed and noise lines", () => {
    const log = ["  some plain log line", "  > " + AUTH_FAILURE_LOG.split("\n")[2]].join("\n");
    expect(classifyAgentFailure(log)).toBe("auth");
  });
});

describe("parseTokenUsage", () => {
  it("extracts usage from turn.completed", () => {
    expect(parseTokenUsage(SUCCESS_LOG)).toEqual({
      inputTokens: 80762,
      cachedInputTokens: 70016,
      outputTokens: 808,
      reasoningOutputTokens: 83,
    });
  });

  it("returns the LAST turn.completed when several are present", () => {
    const log = [
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":20,"reasoning_output_tokens":5}}',
    ].join("\n");
    expect(parseTokenUsage(log)?.inputTokens).toBe(100);
  });

  it("returns undefined when no usage line is present", () => {
    expect(parseTokenUsage(AUTH_FAILURE_LOG)).toBeUndefined();
  });

  it("defaults missing sub-fields to 0", () => {
    expect(parseTokenUsage('{"type":"turn.completed","usage":{"input_tokens":42}}')).toEqual({
      inputTokens: 42,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    });
  });
});
