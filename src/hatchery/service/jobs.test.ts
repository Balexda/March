import { describe, expect, it, vi } from "vitest";
import { errorMessage, JobStore } from "./jobs.js";
import type { HatcherySpawnResult } from "../spawn-handoff.js";
import type { SpawnRequest } from "./types.js";

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
