/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { stampDwell } from "./dwell.js";

const T0 = 1_000_000_000_000; // fixed epoch ms

describe("stampDwell", () => {
  it("pre-seeds every stage / tracked gate to 0 and stamps a fresh slice at age ~0", () => {
    const slices = { a: { stage: "hatchery-pending" } };
    const obs = stampDwell(slices, T0);
    expect(obs.stageAgeMaxSeconds["hatchery-pending"]).toBe(0);
    expect(obs.stageAgeMaxSeconds["implementing"]).toBe(0); // pre-seeded
    expect(obs.mergeGateAgeMaxSeconds["ready"]).toBe(0);
    expect(obs.completedStageDwells).toEqual([]);
    expect((slices.a as any).stage_entered_at).toBe(T0);
  });

  it("reports elapsed age on a later tick without re-stamping", () => {
    const slices = { a: { stage: "implementing" } };
    stampDwell(slices, T0);
    const obs = stampDwell(slices, T0 + 600_000); // +10 min
    expect(obs.stageAgeMaxSeconds["implementing"]).toBe(600);
    expect(obs.completedStageDwells).toEqual([]); // no transition
  });

  it("records the completed dwell of the stage just left on a transition", () => {
    const slices = { a: { stage: "hatchery-pending" } };
    stampDwell(slices, T0);
    (slices.a as any).stage = "implementing";
    const obs = stampDwell(slices, T0 + 120_000); // moved after 2 min in hatchery-pending
    expect(obs.completedStageDwells).toEqual([{ stage: "hatchery-pending", seconds: 120 }]);
    expect(obs.stageAgeMaxSeconds["implementing"]).toBe(0); // fresh entry
  });

  it("seeds a fold-durable entry hint so age survives a restart (implementing_started_at)", () => {
    // Cold start: no _dwell_stage yet, but the slice carries a durable timestamp.
    const startedAt = new Date(T0 - 3_600_000).toISOString(); // 1h ago
    const slices = { a: { stage: "implementing", implementing_started_at: startedAt } };
    const obs = stampDwell(slices, T0);
    expect(obs.stageAgeMaxSeconds["implementing"]).toBe(3600); // 1h, not 0
  });

  it("tracks pr-open merge-gate age and resets it when the gate changes", () => {
    const slices = { a: { stage: "pr-open", merge_gate: "waiting-approval", pr_open_at: new Date(T0).toISOString() } };
    stampDwell(slices, T0);
    let obs = stampDwell(slices, T0 + 300_000); // +5 min same gate
    expect(obs.mergeGateAgeMaxSeconds["waiting-approval"]).toBe(300);
    // Gate flips → age resets from the change moment.
    (slices.a as any).merge_gate = "ready";
    obs = stampDwell(slices, T0 + 360_000);
    expect(obs.mergeGateAgeMaxSeconds["ready"]).toBe(0);
    expect(obs.mergeGateAgeMaxSeconds["waiting-approval"]).toBe(0);
  });

  it("records age for an unexpected stage (normalized to 'other'), not undefined", () => {
    const slices = { a: { stage: "weird-unmapped", _dwell_stage: "other", stage_entered_at: T0 - 120_000 } };
    const obs = stampDwell(slices, T0);
    expect(obs.stageAgeMaxSeconds["other"]).toBe(120); // not undefined / never-recorded
  });

  it("seeds merge-gate age from pr_open_at on the FIRST observation (survives restart)", () => {
    // Cold start: no _dwell_gate yet, but the PR has been open (and ready) a while.
    const slices = { a: { stage: "pr-open", merge_gate: "ready", pr_open_at: new Date(T0 - 2_400_000).toISOString() } }; // 40m ago
    const obs = stampDwell(slices, T0);
    expect(obs.mergeGateAgeMaxSeconds["ready"]).toBe(2400); // 40m, not 0 → the >30m alarm can fire
  });

  it("reports the MAX age across multiple slices in the same stage", () => {
    const slices = {
      a: { stage: "hatchery-pending", _dwell_stage: "hatchery-pending", stage_entered_at: T0 - 60_000 },
      b: { stage: "hatchery-pending", _dwell_stage: "hatchery-pending", stage_entered_at: T0 - 900_000 },
    };
    const obs = stampDwell(slices, T0);
    expect(obs.stageAgeMaxSeconds["hatchery-pending"]).toBe(900); // the older one (b)
  });
});
