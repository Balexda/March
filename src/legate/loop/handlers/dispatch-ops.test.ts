/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import type { DispatchIoDeps } from "./dispatch-io.js";
import {
  completePendingHatcheryDispatches,
  launchDispatch,
  launchHatcheryDispatch,
  recoverDispatch,
} from "./dispatch-ops.js";
import { DISPATCH_RECOVERY_LIMIT, recoveryAttemptKey } from "../pure/slice.js";

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
    // The action key rides along so a cold-start rebuild can tell rows apart (#653).
    expect(emitTransition).toHaveBeenCalledWith(expect.objectContaining({
      type: "slice.dispatched", sliceId: "s", jobId: "job-7",
      command: "smithy.forge", arguments: ["specs/a.spec.md", "1"], artifactPath: "specs/a.spec.md",
    }));
    // The spawn runs under the same slice id as the in-memory slice + transition.
    expect((postSpawn.mock.calls[0]![0] as any).sliceId).toBe("s");
  });

  it("escalates + records the failure when the launch throws, but holds the operator ping within budget", async () => {
    const state: any = { slices: {} };
    const emit = vi.fn();
    const log = vi.fn();
    const emitTransition = vi.fn();
    const out = await launchDispatch(state, "T", item(), "s", deps({ emit, log, emitTransition, postSpawn: vi.fn(async () => { throw new Error("hatchery 500"); }) }));
    expect(state.slices.s.stage).toBe("escalated");
    expect(state.slices.s.escalated_reason).toBe("hatchery_dispatch_failed");
    expect(out.failures).toHaveLength(1);
    // Within budget the loop will auto-recover (#211), so no premature operator ping.
    expect(out.notifications).toHaveLength(0);
    expect(emitTransition).toHaveBeenCalledWith(expect.objectContaining({ type: "slice.escalated", sliceId: "s" }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "dispatch_failure", slice_id: "s" }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("dispatch failed s"));
  });

  it("fires the operator judgement on a launch throw once the recovery budget is exhausted", async () => {
    const state: any = { slices: {}, transient_retry_counts: { [recoveryAttemptKey("s")]: DISPATCH_RECOVERY_LIMIT } };
    const out = await launchDispatch(state, "T", item(), "s", deps({ postSpawn: vi.fn(async () => { throw new Error("hatchery 500"); }) }));
    expect(out.notifications[0]).toMatchObject({ sliceId: "s", reason: "hatchery_dispatch_failed" });
    // #460: the operator is still pinged once the threshold is crossed, but the
    // wording reflects that the loop keeps re-dispatching with backoff (no give-up).
    expect(out.notifications[0].detail).toContain("KEEPS re-dispatching");
  });

  it("culls the orphaned steward on a launch-throw escalation", async () => {
    const state: any = { slices: {} };
    const cullStewardForSlice = vi.fn(async () => ({ culled: true, sessionId: "sess-9" }));
    const out = await launchDispatch(state, "T", item(), "s", deps({
      cullStewardForSlice,
      postSpawn: vi.fn(async () => { throw new Error("hatchery 500"); }),
    }));
    expect(cullStewardForSlice).toHaveBeenCalledWith("s", expect.any(String));
    expect(out.actions).toContainEqual(
      expect.objectContaining({ action: "steward-cull", sliceId: "s", sessionId: "sess-9" }),
    );
  });

  it("swallows a cull failure — the escalation still records", async () => {
    const state: any = { slices: {} };
    const log = vi.fn();
    const out = await launchDispatch(state, "T", item(), "s", deps({
      log,
      cullStewardForSlice: vi.fn(async () => { throw new Error("castra unreachable"); }),
      postSpawn: vi.fn(async () => { throw new Error("hatchery 500"); }),
    }));
    expect(state.slices.s.stage).toBe("escalated");
    expect(out.actions.some((a: any) => a.action === "steward-cull")).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("steward cull failed for s"));
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

  it("escalates (not strands) on a non-transient getJob lookup failure when the budget is exhausted", async () => {
    const state: any = { slices: { s: pending() }, transient_retry_counts: { [recoveryAttemptKey("s")]: DISPATCH_RECOVERY_LIMIT } };
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
    // The clear is made DURABLE (#211 review): without a retry.counted(0) per cleared
    // key the counter would reappear from the fold's sys.retries after a restart.
    expect(emitTransition).toHaveBeenCalledWith({ type: "retry.counted", key: "s", count: 0 });
    expect(emitTransition).toHaveBeenCalledWith({ type: "retry.counted", key: "spawn-error:s", count: 0 });
  });

  it("escalates the slice + records the failure when the job failed, holding the operator ping within budget", async () => {
    const state: any = { slices: { s: pending() } };
    const emitTransition = vi.fn();
    const out = await completePendingHatcheryDispatches(state, "T", deps({ getJob: vi.fn(async () => ({ status: "failed", error: { message: "git apply --index failed" } })), emitTransition }));
    expect(state.slices.s.stage).toBe("escalated");
    // Tags the recoverable class so bounded auto-recovery (#211) can re-dispatch it.
    expect(state.slices.s.escalated_reason).toBe("hatchery_dispatch_failed");
    expect(out.failures[0]).toMatchObject({ slice_id: "s" });
    // Within budget → the dispatch handler will auto-recover; no premature ping.
    expect(out.notifications).toHaveLength(0);
    expect(emitTransition).toHaveBeenCalledWith(expect.objectContaining({ type: "slice.escalated", sliceId: "s" }));
  });

  it("fires the operator judgement only once the recovery budget is exhausted", async () => {
    const state: any = { slices: { s: pending() }, transient_retry_counts: { [recoveryAttemptKey("s")]: DISPATCH_RECOVERY_LIMIT } };
    const out = await completePendingHatcheryDispatches(state, "T", deps({ getJob: vi.fn(async () => ({ status: "failed", error: { message: "git apply --index failed" } })) }));
    expect(state.slices.s.stage).toBe("escalated");
    expect(out.notifications[0]).toMatchObject({ sliceId: "s", reason: "hatchery_dispatch_failed" });
    expect(out.notifications[0].detail).toContain("KEEPS re-dispatching");
  });

  it("culls the orphaned steward when a failed job escalates the slice", async () => {
    const state: any = { slices: { s: { ...pending(), branch: "smithy/forge/a" } } };
    const cullStewardForSlice = vi.fn(async () => ({ culled: true, sessionId: "sess-orphan" }));
    const out = await completePendingHatcheryDispatches(state, "T", deps({
      getJob: vi.fn(async () => ({ status: "failed", error: { message: "Castra session launch failed: timeout" } })),
      cullStewardForSlice,
    }));
    expect(state.slices.s.stage).toBe("escalated");
    expect(cullStewardForSlice).toHaveBeenCalledWith("s", "smithy/forge/a");
    expect(out.actions).toContainEqual(
      expect.objectContaining({ action: "steward-cull", sliceId: "s", sessionId: "sess-orphan" }),
    );
  });

  it("does NOT cull on a branch-collision failure (the adopt/self-heal path owns it)", async () => {
    // No observed PR yet, so adoptOpenPrOnCollision returns null and the slice
    // escalates — but the branch belongs to a prior spawn whose open PR the fold
    // may simply not have observed, so culling its steward here would delete a
    // PR's live backing before #173 adoption gets a chance to run.
    const state: any = { slices: { s: { ...pending(), branch: "smithy/forge/a" } } };
    const cullStewardForSlice = vi.fn(async () => ({ culled: true, sessionId: "x" }));
    const out = await completePendingHatcheryDispatches(state, "T", deps({
      getJob: vi.fn(async () => ({ status: "failed", error: { message: "branch 'feature/smithy/forge/a' already exists" } })),
      cullStewardForSlice,
    }));
    expect(state.slices.s.stage).toBe("escalated");
    expect(cullStewardForSlice).not.toHaveBeenCalled();
    expect(out.actions.some((a: any) => a.action === "steward-cull")).toBe(false);
  });

  it("escalates on a non-transient getJob lookup failure (e.g. 404), holding the ping within budget", async () => {
    const state: any = { slices: { s: pending() } };
    const emitTransition = vi.fn();
    const out = await completePendingHatcheryDispatches(state, "T", deps({ getJob: vi.fn(async () => { throw new Error("hatchery GET /spawns/job-1 failed with status 404"); }), emitTransition }));
    expect(state.slices.s.stage).toBe("escalated");
    expect(state.slices.s.escalated_reason).toBe("hatchery_dispatch_failed");
    expect(out.notifications).toHaveLength(0);
    expect(emitTransition).toHaveBeenCalledWith(expect.objectContaining({ type: "slice.escalated", sliceId: "s" }));
  });

  it("escalates on a succeeded job whose result carries an error (holding the ping within budget)", async () => {
    const state: any = { slices: { s: pending() } };
    const out = await completePendingHatcheryDispatches(state, "T", deps({ getJob: vi.fn(async () => ({ status: "succeeded", result: { error: "session already exists: t (ghost-1)" } })) }));
    expect(state.slices.s.stage).toBe("escalated");
    expect(out.notifications).toHaveLength(0);
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
    expect(out.actions[0].detail).toContain("auto-recovery attempt 1: ");
  });

  it("reports the attempt without a fake limit (recovery retries indefinitely since #460)", async () => {
    const state: any = { slices: { s: escalated() }, transient_retry_counts: {} };
    const log = vi.fn();
    const out = await recoverDispatch(state, "T", item(), "s", 7, deps({ log, postSpawn: vi.fn(async () => ({ id: "job-7" })) }));
    expect(out.actions[0].detail).toMatch(/^auto-recovery attempt 7: /);
    expect(out.actions[0].detail).not.toContain("7/");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("(attempt 7)"));
  });

  it("persists the bumped retry counter and emits retry.counted + recovery.dispatched, no stage clear (#255)", async () => {
    const state: any = { slices: { s: escalated() }, transient_retry_counts: {} };
    const emitTransition = vi.fn();
    await recoverDispatch(state, "T", item(), "s", 2, deps({ emitTransition }));
    expect(state.transient_retry_counts[recoveryAttemptKey("s")]).toBe(2);
    expect(emitTransition).toHaveBeenCalledWith({ type: "retry.counted", key: recoveryAttemptKey("s"), count: 2 });
    expect(emitTransition).toHaveBeenCalledWith(expect.objectContaining({
      type: "slice.recovery.dispatched", sliceId: "s",
      command: "smithy.forge", arguments: ["specs/a.spec.md", "1"], artifactPath: "specs/a.spec.md",
    }));
    // The recovery.dispatched reducer sets stage=hatchery-pending in the fold, so the
    // dispatch path emits no compensating slice.stage.changed (#255); the in-memory
    // warm state is still hatchery-pending (launchDispatch sets it).
    expect(emitTransition).not.toHaveBeenCalledWith({ type: "slice.stage.changed", sliceId: "s", stage: "hatchery-pending" });
    expect(state.slices.s.stage).toBe("hatchery-pending");
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
    // attempt 1 of 2 → still within budget, so no premature operator ping.
    expect(out.notifications).toHaveLength(0);
  });

  it("escalates to the operator when the FINAL recovery attempt's POST throws (budget exhausted)", async () => {
    const state: any = { slices: { s: escalated() }, transient_retry_counts: {} };
    const out = await recoverDispatch(state, "T", item(), "s", DISPATCH_RECOVERY_LIMIT, deps({ postSpawn: vi.fn(async () => { throw new Error("hatchery 500"); }) }));
    expect(state.transient_retry_counts[recoveryAttemptKey("s")]).toBe(DISPATCH_RECOVERY_LIMIT);
    expect(state.slices.s.stage).toBe("escalated");
    expect(out.notifications[0]).toMatchObject({ sliceId: "s", reason: "hatchery_dispatch_failed" });
  });
});

describe("durable integration completion", () => {
  const deadline = "2026-11-27T12:00:00.000Z";
  const beforeDeadline = "2026-11-27T11:59:00.000Z";
  const spawnId = "artifact-spawn";
  const result = {
    spawnId, status: "succeeded", completedAt: beforeDeadline,
    stewardSessionId: "steward", worktreePath: "/worktree",
    application: { spawnId, status: "applied", touchedPaths: ["README.md"] },
    commit: { spawnId, branch: "branch", commitSha: "sha", patchSha256: "digest", committedAt: beforeDeadline },
    pullRequest: {
      provider: "github", repository: "a/b", number: 1, url: "https://github.com/a/b/pull/1",
      headBranch: "branch", baseBranch: "main", state: "open", observedAt: beforeDeadline,
    },
  } as const;
  const pending = () => ({
    slices: { s: { stage: "hatchery-pending", hatchery: {
      job_id: "attempt", attempt_id: "attempt", steward_deadline: deadline,
    } } },
  });
  const attempt = { attemptId: "attempt", spawnId, stewardDeadline: deadline, fenced: false, outcome: null };
  const io = (over: Partial<NonNullable<DispatchIoDeps["integration"]>> = {}) => ({
    stewardDeadline: () => deadline,
    appendTransition: vi.fn(async () => {}),
    readAttempt: vi.fn(async () => attempt),
    confirmFailure: vi.fn(async () => ({ ...attempt, fenced: true })),
    ...over,
  });

  it("records the attempt and deadline before submitting the same identity to Hatchery", async () => {
    const state = { slices: {} };
    const integration = io();
    const postSpawn = vi.fn(async (request) => {
      expect(integration.appendTransition).toHaveBeenCalledWith(expect.objectContaining({
        type: "slice.dispatched", sliceId: "s", attemptId: request.attemptId,
        jobId: request.attemptId, stewardDeadline: deadline,
      }));
      throw new Error("acknowledgement lost");
    });
    await launchDispatch(state, beforeDeadline, item(), "s", deps({ integration, postSpawn }));
    expect(state.slices).toMatchObject({ s: { stage: "hatchery-pending", hatchery: { steward_deadline: deadline } } });
  });

  const rejected = () => Object.assign(new Error("invalid spawn request"), { status: 400 });

  it("fails a dispatch Hatchery rejected once Brood fences the attempt", async () => {
    const state: any = { slices: {} };
    const integration = io();
    const postSpawn = vi.fn(async () => { throw rejected(); });
    const out = await launchDispatch(state, beforeDeadline, item(), "s", deps({ integration, postSpawn }));
    expect(integration.confirmFailure).toHaveBeenCalledWith("s", expect.any(String));
    expect(state.slices.s).toMatchObject({ stage: "escalated", escalated_reason: "hatchery_dispatch_failed" });
    expect(out.failures).toHaveLength(1);
  });

  it("fails a dispatch that never left Legate", async () => {
    const state: any = { slices: {} };
    const integration = io();
    const meta = { profile: "prof", worker_group: "wg", repo: {}, processor_name: "proc", paired_legate: "leg" };
    await launchDispatch(state, beforeDeadline, item(), "s", deps({ integration, meta } as any));
    expect(integration.confirmFailure).toHaveBeenCalledOnce();
    expect(state.slices.s.stage).toBe("escalated");
  });

  it("keeps polling a rejected dispatch when Brood cannot fence it", async () => {
    const state: any = { slices: {} };
    const integration = io({ confirmFailure: vi.fn(async () => { throw new Error("Brood down"); }) });
    const postSpawn = vi.fn(async () => { throw rejected(); });
    await launchDispatch(state, beforeDeadline, item(), "s", deps({ integration, postSpawn }));
    expect(state.slices.s.stage).toBe("hatchery-pending");
  });

  it("keeps polling when the attempt already has an outcome", async () => {
    const state: any = { slices: {} };
    const integration = io({ confirmFailure: vi.fn(async () => ({ ...attempt, fenced: true, outcome: result })) });
    const postSpawn = vi.fn(async () => { throw rejected(); });
    await launchDispatch(state, beforeDeadline, item(), "s", deps({ integration, postSpawn }));
    expect(state.slices.s.stage).toBe("hatchery-pending");
  });

  it("keeps polling a server error without fencing", async () => {
    const state: any = { slices: {} };
    const integration = io();
    const postSpawn = vi.fn(async () => { throw Object.assign(new Error("boom"), { status: 503 }); });
    await launchDispatch(state, beforeDeadline, item(), "s", deps({ integration, postSpawn }));
    expect(integration.confirmFailure).not.toHaveBeenCalled();
    expect(state.slices.s.stage).toBe("hatchery-pending");
  });

  it("recovers published success when the Hatchery job is gone", async () => {
    const state = pending();
    const integration = io({ readAttempt: async () => ({ ...attempt, outcome: result }) });
    const getJob = async () => { throw new Error("job not found"); };
    await completePendingHatcheryDispatches(state, beforeDeadline, deps({ integration, getJob }));
    expect(state.slices.s).toMatchObject({
      stage: "implementing", worker_session_id: "steward", branch: "branch", integration_outcome: result,
    });
    expect(integration.confirmFailure).not.toHaveBeenCalled();
  });

  it("lets the durable outcome win over a persistence failure reported by Hatchery", async () => {
    const state = pending();
    const integration = io({ confirmFailure: async () => ({ ...attempt, outcome: result }) });
    const getJob = async () => ({ status: "failed", integrationOutcome: { status: "failed", failureReason: "persistence" } });
    await completePendingHatcheryDispatches(state, beforeDeadline, deps({ integration, getJob }));
    expect(state.slices.s.stage).toBe("implementing");
    expect(integration.appendTransition).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: "slice.stage.changed", attemptId: "attempt", branch: "branch", worktreePath: "/worktree", spawnId,
    }));
  });

  it("records a persistence failure only after Brood fences an empty lookup", async () => {
    const state = pending();
    const integration = io();
    const outcome = {
      spawnId, status: "failed", failureReason: "persistence", completedAt: beforeDeadline,
      diagnostic: "Brood could not confirm the integration outcome.",
      commit: result.commit, pullRequest: result.pullRequest,
    };
    const getJob = async () => ({ status: "failed", integrationOutcome: outcome });
    await completePendingHatcheryDispatches(state, beforeDeadline, deps({ integration, getJob }));
    expect(integration.confirmFailure).toHaveBeenCalledWith("s", "attempt");
    expect(integration.appendTransition).toHaveBeenCalledExactlyOnceWith({
      type: "slice.integration.failed", sliceId: "s", attemptId: "attempt", outcome,
    });
    expect(state.slices.s.stage).toBe("escalated");
  });

  it("escalates with the outcome Herald kept when a retried failure append returns the first write", async () => {
    const state: any = pending();
    const stored = {
      spawnId, status: "failed", failureReason: "persistence", completedAt: beforeDeadline,
      diagnostic: "Brood could not confirm the integration outcome.",
    } as const;
    const integration = io({
      appendTransition: vi.fn(async () => ({ type: "slice.integration.failed", sliceId: "s", attemptId: "attempt", outcome: stored })),
    });
    const completion = await completePendingHatcheryDispatches(state, deadline, deps({ integration }));
    expect(state.slices.s.integration_outcome).toEqual(stored);
    expect(completion.failures).toEqual([expect.objectContaining({ failure_reason: "persistence" })]);
  });

  it("culls only the attempt's own session when an integration failure has no commit or PR", async () => {
    const state: any = pending();
    const cullStewardForSlice = vi.fn(async () => ({ culled: true, sessionId: "late" }));
    const completion = await completePendingHatcheryDispatches(state, deadline, deps({ integration: io(), cullStewardForSlice }));
    expect(cullStewardForSlice).toHaveBeenCalledWith("s", undefined, "attempt");
    expect(completion.actions).toEqual(expect.arrayContaining([expect.objectContaining({ action: "steward-cull", sessionId: "late" })]));
  });

  it("keeps the Steward of an integration failure that preserved a commit", async () => {
    const state: any = pending();
    const failed = {
      spawnId, status: "failed", failureReason: "push_failed", completedAt: beforeDeadline,
      diagnostic: "The integration commit could not be pushed.", commit: result.commit,
    } as const;
    const cullStewardForSlice = vi.fn(async () => ({ culled: true }));
    const integration = io({ confirmFailure: async () => ({ ...attempt, fenced: true, outcome: failed }) });
    const getJob = async () => ({ status: "failed", integrationOutcome: failed });
    await completePendingHatcheryDispatches(state, beforeDeadline, deps({ integration, getJob, cullStewardForSlice }));
    expect(state.slices.s.stage).toBe("escalated");
    expect(cullStewardForSlice).not.toHaveBeenCalled();
  });

  it("leaves an expired dispatch pending when Brood is unavailable and records timeout after fencing", async () => {
    const state = pending();
    const confirmFailure = vi.fn()
      .mockRejectedValueOnce(new Error("Brood down"))
      .mockResolvedValueOnce({ ...attempt, fenced: true });
    const integration = io({ confirmFailure });
    await completePendingHatcheryDispatches(state, deadline, deps({ integration }));
    expect(state.slices.s.stage).toBe("hatchery-pending");
    expect(integration.appendTransition).not.toHaveBeenCalled();
    const completion = await completePendingHatcheryDispatches(state, deadline, deps({ integration }));
    expect(confirmFailure).toHaveBeenLastCalledWith("s", "attempt");
    expect(integration.appendTransition).toHaveBeenCalledWith({
      type: "slice.integration.failed", sliceId: "s", attemptId: "attempt",
      outcome: expect.objectContaining({ status: "failed", spawnId, failureReason: "timeout" }),
    });
    expect(state.slices.s.stage).toBe("escalated");
    expect(completion.failures).toEqual([expect.objectContaining({ failure_reason: "timeout" })]);
  });
});
