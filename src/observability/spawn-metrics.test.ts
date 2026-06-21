/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { outcomeFromExitCode, recordAgentFailure, recordSpawnRun, recordSpawnTokens } from "./spawn-metrics.js";

describe("spawn-metrics", () => {
  it("maps exit code 0 to success and anything else to failure", () => {
    expect(outcomeFromExitCode(0)).toBe("success");
    expect(outcomeFromExitCode(1)).toBe("failure");
    expect(outcomeFromExitCode(137)).toBe("failure");
  });

  it("is a no-op (does not throw) when telemetry is disabled", () => {
    expect(() =>
      recordSpawnRun({
        backend: "codex",
        taskType: "forge",
        profile: "smithy",
        outcome: "success",
        durationSeconds: 1.5,
      }),
    ).not.toThrow();
  });

  it("accepts a failureStage on a failure record without throwing when disabled", () => {
    expect(() =>
      recordSpawnRun({
        backend: "codex",
        taskType: "cut",
        profile: "march",
        outcome: "failure",
        failureStage: "patch_apply",
        durationSeconds: 0.3,
      }),
    ).not.toThrow();
  });

  it("recordAgentFailure is a no-op (does not throw) when telemetry is disabled", () => {
    expect(() => recordAgentFailure({ backend: "codex", profile: "smithy", reason: "auth" })).not.toThrow();
  });

  it("recordAgentFailure skips the `none` reason without throwing", () => {
    expect(() => recordAgentFailure({ backend: "codex", profile: "smithy", reason: "none" })).not.toThrow();
  });

  it("recordSpawnTokens is a no-op (does not throw) when telemetry is disabled", () => {
    expect(() =>
      recordSpawnTokens({
        backend: "codex",
        profile: "smithy",
        taskType: "forge",
        usage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 5 },
      }),
    ).not.toThrow();
  });
});
