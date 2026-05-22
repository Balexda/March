import { describe, expect, it, vi } from "vitest";
import type { DispatchIoDeps } from "./dispatch-io.js";
import {
  completePendingHatcheryDispatches,
  launchDispatch,
  launchHatcheryDispatch,
  recoverDispatch,
} from "./dispatch-ops.js";
import { recoveryAttemptKey } from "../pure/slice.js";

function deps(over: Partial<DispatchIoDeps> = {}): DispatchIoDeps {
  return {
    meta: { profile: "prof", worker_group: "wg", repo: { path: "/repo" }, processor_name: "proc", paired_legate: "leg" },
    emitTransition: vi.fn(),
    emit: vi.fn(),
    log: vi.fn(),
    postSpawn: vi.fn(async () => ({ id: "job-1" })),
    getJob: vi.fn(async () => ({ status: "running" })),
    ...over,
  };
}

const item = (over: any = {}) => ({
  path: "specs/a.spec.md",
  next_action: { command: "smithy.forge", arguments: ["specs/a.spec.md", "1"] },
  ...over,
});

describe("launchHatcheryDispatch", () => {
  it("POSTs a codex spawn request with the caller's slice id and returns the job id", async () => {
    const postSpawn = vi.fn(async (_req: any) => ({ id: "job-42" }));
    const res = await launchHatcheryDispatch(item(), "slice-7", deps({ postSpawn }));
    expect(res).toEqual({ jobId: "job-42" });
    const req = postSpawn.mock.calls[0]![0] as any;
    expect(req).toMatchObject({ backend: "codex", repoPath: "/repo", profile: "prof", agentDeckProfile: "prof", managerGroup: "wg", sliceId: "slice-7" });
    expect(req.prompt.length).toBeGreaterThan(0);
  });

  it("throws when the repo path is missing", async () => {
    await expect(launchHatcheryDispatch(item(), "s", deps({ meta: { repo: {} } }))).rejects.toThrow(/repo path is missing/);
  });

  it("throws when the service returns no job id (empty 202 body)", async () => {
    await expect(launchHatcheryDispatch(item(), "s", deps({ postSpawn: vi.fn(async () => ({})) }))).rejects.toThrow(/no job id/);
  });
});

describe("launchDispatch", () => {
  it("creates a hatchery-pending slice, records the job id, and emits slice.dispatched with the jobId", async () => {
    const state: any = { slices: {} };
    const emitTransition = vi.fn();
    const postSpawn = vi.fn(async (_req: any) => ({ id: "job-7" }));
    const out = await launchDispatch(state, "T", item(), "s", deps({ emitTransition, postSpawn }));
    expect(state.slices.s).toMatchObject({ stage: "hatchery-pending", command: "smithy.forge", hatchery: { backend: "codex", job_id: "job-7" } });
    expect(out.actions).toEqual([expect.objectContaining({ action: "dispatch", sliceId: "s" })]);
    expect(emitTransition).toHaveBeenCalledWith(expect.objectContaining({ type: "slice.dispatched", sliceId: "s", jobId: "job-7" }));
    // The spawn runs under the same slice id as the in-memory slice + transition.
    expect((postSpawn.mock.calls[0]![0] as any).sliceId).toBe("s");
  });

  it("escalates the slice and queues a judgement notification when the launch throws", async () => {
    const state: any = { slices: {} };
    const emit = vi.fn();
    const log = vi.fn();
    const emitTransition = vi.fn();
    const out = await launchDispatch(state, "T", item(), "s", deps({ emit, log, emitTransition, postSpawn: vi.fn(async () => { throw new Error("hatchery 500"); }) }));
    expect(state.slices.s.stage).toBe("escalated");
    expect(out.failures).toHaveLength(1);
    expect(out.notifications[0]).toMatchObject({ sliceId: "s", reason: "hatchery_dispatch_failed" });
    expect(emitTransition).toHaveBeenCalledWith(expect.objectContaining({ type: "slice.escalated", sliceId: "s" }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "dispatch_failure", slice_id: "s" }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("dispatch failed s"));
  });
});

describe("completePendingHatcheryDispatches", () => {
  const pending = (jobId = "job-1") => ({
    stage: "hatchery-pending",
    command: "smithy.forge",
    arguments: ["a", "1"],
    hatchery: { backend: "codex", job_id: jobId },
  });
  const pendingNoJob = () => ({
    stage: "hatchery-pending",
    command: "smithy.forge",
    arguments: ["a", "1"],
    hatchery: { backend: "codex" },
  });

  it("ignores slices that are not hatchery-pending", async () => {
    const state: any = { slices: { s: { stage: "implementing", hatchery: { job_id: "x" } } } };
    const getJob = vi.fn();
    const out = await completePendingHatcheryDispatches(state, "T", deps({ getJob }));
    expect(getJob).not.toHaveBeenCalled();
    expect(out.mutated).toBe(false);
  });

  it("skips a pending slice with no job id (defensive)", async () => {
    const state: any = { slices: { s: pendingNoJob() } };
    const getJob = vi.fn();
    const out = await completePendingHatcheryDispatches(state, "T", deps({ getJob }));
    expect(getJob).not.toHaveBeenCalled();
    expect(out.mutated).toBe(false);
  });

  it("waits (no change) while the job is still running", async () => {
    const state: any = { slices: { s: pending() } };
    const out = await completePendingHatcheryDispatches(state, "T", deps({ getJob: vi.fn(async () => ({ status: "running" })) }));
    expect(state.slices.s.stage).toBe("hatchery-pending");
    expect(out.mutated).toBe(false);
  });

  it("waits (no change) on a transient network getJob failure", async () => {
    const state: any = { slices: { s: pending() } };
    const out = await completePendingHatcheryDispatches(state, "T", deps({ getJob: vi.fn(async () => { throw new Error("Could not reach the hatchery service at http://x"); }) }));
    expect(state.slices.s.stage).toBe("hatchery-pending");
    expect(out.mutated).toBe(false);
  });

  it("escalates (not strands) on a non-transient getJob lookup failure (e.g. 404 after restart)", async () => {
    const state: any = { slices: { s: pending() } };
    const emitTransition = vi.fn();
    const out = await completePendingHatcheryDispatches(state, "T", deps({ getJob: vi.fn(async () => { throw new Error("hatchery GET /spawns/job-1 failed with status 404"); }), emitTransition }));
    expect(state.slices.s.stage).toBe("escalated");
    expect(out.notifications[0]).toMatchObject({ sliceId: "s", reason: "hatchery_dispatch_failed" });
    expect(emitTransition).toHaveBeenCalledWith(expect.objectContaining({ type: "slice.escalated", sliceId: "s" }));
  });

  it("promotes the slice to implementing on success", async () => {
    const state: any = { slices: { s: pending() }, transient_retry_counts: { s: 2, "spawn-error:s": 1, other: 5 } };
    const emitTransition = vi.fn();
    const getJob = vi.fn(async () => ({
      status: "succeeded",
      result: { managerSession: { sessionId: "sess-9", title: "T", worktreePath: "/wt" }, branch: "feature/a", spawnId: "sp-1", artifacts: { dir: "/art" } },
    }));
    const out = await completePendingHatcheryDispatches(state, "T", deps({ getJob, emitTransition }));
    expect(state.slices.s).toMatchObject({ stage: "implementing", worker_session_id: "sess-9", branch: "feature/a", worktree_path: "/wt", implementing_started_at: "T" });
    expect(state.slices.s.hatchery).toMatchObject({ spawn_id: "sp-1", artifacts_dir: "/art" });
    // The handoff transition carries the steward session so a restart's fold
    // rebuild keeps the slice→session link (#210 latent regression).
    expect(emitTransition).toHaveBeenCalledWith({ type: "slice.stage.changed", sliceId: "s", stage: "implementing", sessionId: "sess-9" });
    expect(out.actions).toEqual([expect.objectContaining({ action: "dispatch-complete", sliceId: "s", sessionId: "sess-9" })]);
    // Retry counters for this slice are cleared; unrelated ones survive.
    expect(state.transient_retry_counts).toEqual({ other: 5 });
  });

  it("escalates the slice (no recovery) when the job failed", async () => {
    const state: any = { slices: { s: pending() } };
    const emitTransition = vi.fn();
    const out = await completePendingHatcheryDispatches(state, "T", deps({ getJob: vi.fn(async () => ({ status: "failed", error: { message: "git apply --index failed" } })), emitTransition }));
    expect(state.slices.s.stage).toBe("escalated");
    // Tags the recoverable class so bounded auto-recovery (#211) can re-dispatch it.
    expect(state.slices.s.escalated_reason).toBe("hatchery_dispatch_failed");
    expect(out.failures[0]).toMatchObject({ slice_id: "s" });
    expect(out.notifications[0]).toMatchObject({ sliceId: "s", reason: "hatchery_dispatch_failed" });
    expect(out.notifications[0].detail).toContain("auto-recovers");
    expect(emitTransition).toHaveBeenCalledWith(expect.objectContaining({ type: "slice.escalated", sliceId: "s" }));
  });

  it("escalates on a succeeded job whose result carries an error", async () => {
    const state: any = { slices: { s: pending() } };
    const out = await completePendingHatcheryDispatches(state, "T", deps({ getJob: vi.fn(async () => ({ status: "succeeded", result: { error: "session already exists: t (ghost-1)" } })) }));
    expect(state.slices.s.stage).toBe("escalated");
    expect(out.notifications[0].sliceId).toBe("s");
  });
});

describe("recoverDispatch (#211 bounded auto-recovery)", () => {
  // An escalated slice keyed at the item's deterministic slice id.
  const escalated = () => ({ stage: "escalated", escalated_reason: "hatchery_dispatch_failed", command: "smithy.forge", arguments: ["specs/a.spec.md", "1"] });

  it("re-dispatches via the fresh-launch path: clean hatchery-pending slice + new job id", async () => {
    const state: any = { slices: { s: escalated() }, transient_retry_counts: {} };
    const postSpawn = vi.fn(async () => ({ id: "job-99" }));
    const out = await recoverDispatch(state, "T", item(), "s", 1, deps({ postSpawn }));
    // launchDispatch overwrote the escalated slice with a clean pending one.
    expect(state.slices.s).toMatchObject({ stage: "hatchery-pending", hatchery: { job_id: "job-99" } });
    expect(state.slices.s.escalated_reason).toBeUndefined();
    expect(out.actions[0]).toMatchObject({ action: "dispatch-recovery" });
    expect(out.actions[0].detail).toContain("auto-recovery attempt 1/");
  });

  it("persists the bumped retry counter and emits retry.counted + recovery.dispatched + the stage clear", async () => {
    const state: any = { slices: { s: escalated() }, transient_retry_counts: {} };
    const emitTransition = vi.fn();
    await recoverDispatch(state, "T", item(), "s", 2, deps({ emitTransition }));
    expect(state.transient_retry_counts[recoveryAttemptKey("s")]).toBe(2);
    expect(emitTransition).toHaveBeenCalledWith({ type: "retry.counted", key: recoveryAttemptKey("s"), count: 2 });
    expect(emitTransition).toHaveBeenCalledWith(expect.objectContaining({ type: "slice.recovery.dispatched", sliceId: "s" }));
    // Fold-correctness: the escalated stage is explicitly reset to hatchery-pending.
    expect(emitTransition).toHaveBeenCalledWith({ type: "slice.stage.changed", sliceId: "s", stage: "hatchery-pending" });
  });

  it("emits a recovery_dispatch action-log event so the (replay-only) recovery span re-lights", async () => {
    const state: any = { slices: { s: escalated() }, transient_retry_counts: {} };
    const emit = vi.fn();
    await recoverDispatch(state, "T", item(), "s", 1, deps({ emit }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "recovery_dispatch", slice_id: "s", action: "recovery_dispatch" }));
  });

  it("counts the attempt even when the re-launch POST throws (so the budget can't be bypassed) and re-escalates", async () => {
    const state: any = { slices: { s: escalated() }, transient_retry_counts: {} };
    const emitTransition = vi.fn();
    const out = await recoverDispatch(state, "T", item(), "s", 1, deps({ emitTransition, postSpawn: vi.fn(async () => { throw new Error("hatchery 500"); }) }));
    expect(state.transient_retry_counts[recoveryAttemptKey("s")]).toBe(1);
    // launchDispatch's own catch re-escalated; we must NOT then clear the stage.
    expect(state.slices.s.stage).toBe("escalated");
    expect(emitTransition).not.toHaveBeenCalledWith({ type: "slice.stage.changed", sliceId: "s", stage: "hatchery-pending" });
    expect(out.failures).toHaveLength(1);
  });
});
