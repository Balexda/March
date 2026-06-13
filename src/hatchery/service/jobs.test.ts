/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { errorMessage, JobStore, type JobLogger } from "./jobs.js";
import type { HatcherySpawnResult } from "../spawn-handoff.js";
import type { SpawnRequest } from "./types.js";

interface LogCall {
  readonly level: "info" | "error";
  readonly obj: Record<string, unknown>;
  readonly msg?: string;
}

/** Captures structured log records so tests can assert their fields. */
function recordingLogger(): { logger: JobLogger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const logger: JobLogger = {
    info: (obj, msg) => calls.push({ level: "info", obj: obj as Record<string, unknown>, msg }),
    error: (obj, msg) => calls.push({ level: "error", obj: obj as Record<string, unknown>, msg }),
  };
  return { logger, calls };
}

function fakeResult(spawnId = "spawn-123"): HatcherySpawnResult {
  return {
    spawnId,
    backend: "codex",
    branch: `march/spawn/${spawnId}`,
    managerSession: {
      sessionId: "sess-1",
      title: "t",
      group: "g",
      branch: `march/spawn/${spawnId}`,
      worktreePath: "/repo/feature-march-spawn",
    },
    artifacts: {
      dir: "/logs",
      spawnOutputPath: "/logs/out.log",
      patchPath: "/logs/patch.diff",
      managerPromptPath: "/logs/prompt.md",
      metadataPath: "/logs/meta.json",
    },
    exitCode: 0,
    summary: "ok",
  };
}

const request: SpawnRequest = {
  prompt: "do it",
  backend: "codex",
  repoPath: "/repo",
};

describe("JobStore", () => {
  it("runs a job to succeeded with the executor result", async () => {
    const store = new JobStore({ executor: async () => fakeResult() });
    const record = store.create(request);
    expect(record.status).toBe("pending");

    await vi.waitFor(() => expect(store.get(record.id)?.status).toBe("succeeded"));
    const done = store.get(record.id)!;
    expect(done.result?.spawnId).toBe("spawn-123");
    expect(done.startedAt).toBeTruthy();
    expect(done.finishedAt).toBeTruthy();
    expect(done.error).toBeUndefined();
  });

  it("marks a job failed with the error message", async () => {
    const store = new JobStore({
      executor: async () => {
        throw new Error("boom");
      },
    });
    const record = store.create(request);

    await vi.waitFor(() => expect(store.get(record.id)?.status).toBe("failed"));
    expect(store.get(record.id)?.error?.message).toBe("boom");
  });

  it("logs profile/task_type/slice_id on the spawn-start record", async () => {
    const { logger, calls } = recordingLogger();
    const store = new JobStore({ executor: async () => fakeResult(), logger });
    const detailed: SpawnRequest = {
      ...request,
      profile: "smithy",
      taskType: "render",
      taskName: "render-foo",
      sliceId: "slice-7",
    };
    const record = store.create(detailed);
    await vi.waitFor(() => expect(store.get(record.id)?.status).toBe("succeeded"));

    const start = calls.find((c) => c.msg === "spawn job started");
    expect(start?.obj).toMatchObject({
      job_id: record.id,
      backend: "codex",
      task_name: "render-foo",
      task_type: "render",
      profile: "smithy",
      slice_id: "slice-7",
    });
  });

  it("omits undefined optional fields from the log record", async () => {
    const { logger, calls } = recordingLogger();
    // `request` carries no profile/taskType/taskName/sliceId.
    const store = new JobStore({ executor: async () => fakeResult(), logger });
    const record = store.create(request);
    await vi.waitFor(() => expect(store.get(record.id)?.status).toBe("succeeded"));

    const start = calls.find((c) => c.msg === "spawn job started")!;
    expect(start.obj).toEqual({ job_id: record.id, backend: "codex" });
    expect(Object.keys(start.obj)).not.toContain("profile");
    expect(Object.keys(start.obj)).not.toContain("task_type");
  });

  it("logs the structured fields on the failure record", async () => {
    const { logger, calls } = recordingLogger();
    const store = new JobStore({
      executor: async () => {
        throw new Error("boom");
      },
      logger,
    });
    const detailed: SpawnRequest = {
      ...request,
      profile: "smithy",
      taskType: "render",
      sliceId: "slice-7",
    };
    const record = store.create(detailed);
    await vi.waitFor(() => expect(store.get(record.id)?.status).toBe("failed"));

    const failure = calls.find((c) => c.msg === "spawn job failed");
    expect(failure?.level).toBe("error");
    expect(failure?.obj).toMatchObject({
      job_id: record.id,
      profile: "smithy",
      task_type: "render",
      slice_id: "slice-7",
      err: "boom",
    });
  });

  it("assigns distinct ids to concurrent jobs", () => {
    const store = new JobStore({ executor: async () => fakeResult() });
    const a = store.create(request);
    const b = store.create(request);
    expect(a.id).not.toBe(b.id);
    expect(store.size()).toBe(2);
  });

  it("reaps terminal jobs older than the TTL but keeps fresh ones", async () => {
    const store = new JobStore({
      executor: async () => fakeResult(),
      terminalTtlMs: 1000,
    });
    const record = store.create(request);
    await vi.waitFor(() => expect(store.get(record.id)?.status).toBe("succeeded"));

    // Not yet past TTL.
    expect(store.reapNow(Date.now())).toBe(0);
    expect(store.size()).toBe(1);

    // Far in the future -> evicted.
    expect(store.reapNow(Date.now() + 10_000)).toBe(1);
    expect(store.size()).toBe(0);
  });
});

describe("errorMessage", () => {
  it("extracts a message from Error/string/other", () => {
    expect(errorMessage(new Error("x"))).toBe("x");
    expect(errorMessage("y")).toBe("y");
    expect(errorMessage(42)).toBe("42");
  });
});
