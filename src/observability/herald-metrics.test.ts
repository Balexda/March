/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  outcomeFromStatus,
  recordHeraldObserve,
  recordHeraldObserveError,
  recordHeraldRequest,
  recordHeraldSync,
  recordStewardReport,
  startHeraldHeartbeat,
  stewardReportClassification,
} from "./herald-metrics.js";

describe("herald-metrics", () => {
  it("re-exports outcomeFromStatus (2xx/3xx success, else error)", () => {
    expect(outcomeFromStatus(200)).toBe("success");
    expect(outcomeFromStatus(503)).toBe("error");
  });

  it("recording is a no-op (does not throw) when telemetry is disabled", () => {
    expect(() =>
      recordHeraldRequest({ route: "/events", method: "GET", outcome: "success", durationSeconds: 0.01 }),
    ).not.toThrow();
    expect(() =>
      recordHeraldObserve({ durationSeconds: 0.2, eventsByType: { "slice.pr.changed": 2, heartbeat: 0 } }),
    ).not.toThrow();
    expect(() => recordHeraldObserveError()).not.toThrow();
    expect(() => recordHeraldSync("ok")).not.toThrow();
    expect(() => recordHeraldSync("error")).not.toThrow();
    expect(() =>
      recordStewardReport({ profile: "march", classification: "awaiting_input" }),
    ).not.toThrow();
  });

  it("classifies a steward report into its metric label (#371)", () => {
    expect(stewardReportClassification(true, "awaiting_input")).toBe("awaiting_input");
    expect(stewardReportClassification(true, "reported")).toBe("reported");
    expect(stewardReportClassification(true, "working")).toBe("working");
    // The cheap-vs-expensive split: no classification → the legate-agent's job.
    expect(stewardReportClassification(false)).toBe("unclassified");
    expect(stewardReportClassification(false, "working")).toBe("unclassified");
    // classified but status-less (defensive) collapses to a bounded label.
    expect(stewardReportClassification(true)).toBe("classified");
  });

  it("startHeraldHeartbeat returns a no-op stopper when disabled", () => {
    const stop = startHeraldHeartbeat(10);
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });
});
