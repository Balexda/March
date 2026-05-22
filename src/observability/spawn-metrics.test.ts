import { describe, expect, it } from "vitest";
import { outcomeFromExitCode, recordSpawnRun } from "./spawn-metrics.js";

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
});
