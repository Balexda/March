/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { extractionReadiness } from "./extraction-readiness.js";
import { sqliteAvailable } from "./sqlite.js";
import { SessionStore } from "./store.js";

function makeStore(): SessionStore {
  return new SessionStore({ dbPath: ":memory:" });
}

describe.skipIf(!sqliteAvailable)("SessionStore", () => {
  it("registers a session and reads it back", () => {
    const store = makeStore();
    const rec = store.register({
      id: "20260520-aaaaaa",
      kind: "spawn",
      repoPath: "/repo",
      branch: "march/spawn/20260520-aaaaaa",
      worktreePath: "/repo/../worktrees/march/20260520-aaaaaa",
    });
    expect(rec.status).toBe("created");
    expect(rec.createdAt).toBeTruthy();
    const fetched = store.get("20260520-aaaaaa");
    expect(fetched?.worktreePath).toBe(
      "/repo/../worktrees/march/20260520-aaaaaa",
    );
    expect(fetched?.kind).toBe("spawn");
    store.close();
  });

  it("upserts idempotently: re-register merges, preserves createdAt, never nulls omitted fields", () => {
    const store = makeStore();
    const first = store.register({
      id: "s1",
      kind: "spawn",
      repoPath: "/repo",
      branch: "b",
      worktreePath: "/wt",
    });
    // Re-register with only a container id — must not wipe branch/worktree.
    const second = store.register({
      id: "s1",
      kind: "spawn",
      containerId: "container-xyz",
    });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.containerId).toBe("container-xyz");
    expect(second.branch).toBe("b");
    expect(second.worktreePath).toBe("/wt");
    store.close();
  });

  it("updates lifecycle fields and bumps updatedAt; unknown id returns undefined", async () => {
    const store = makeStore();
    const created = store.register({ id: "s2", kind: "spawn" });
    await new Promise((r) => setTimeout(r, 2));
    const running = store.update("s2", {
      status: "running",
      containerId: "c1",
    });
    expect(running?.status).toBe("running");
    expect(running?.containerId).toBe("c1");
    expect(
      new Date(running!.updatedAt).getTime(),
    ).toBeGreaterThanOrEqual(new Date(created.updatedAt).getTime());
    expect(store.update("missing", { status: "failed" })).toBeUndefined();
    store.close();
  });

  it("filters list by kind, status, and parentId (spawn<->steward link)", () => {
    const store = makeStore();
    store.register({ id: "spawn-1", kind: "spawn", status: "running" });
    store.register({
      id: "steward-1",
      kind: "steward",
      parentId: "spawn-1",
      agentDeckSessionId: "steward-1",
      status: "running",
    });
    store.register({ id: "spawn-2", kind: "spawn", status: "stopped" });

    expect(store.list({ kind: "spawn" }).map((r) => r.id).sort()).toEqual([
      "spawn-1",
      "spawn-2",
    ]);
    expect(store.list({ kind: "steward" }).map((r) => r.id)).toEqual([
      "steward-1",
    ]);
    expect(store.list({ status: "stopped" }).map((r) => r.id)).toEqual([
      "spawn-2",
    ]);
    expect(store.list({ parentId: "spawn-1" }).map((r) => r.id)).toEqual([
      "steward-1",
    ]);
    store.close();
  });

  it("marks a session torn down", () => {
    const store = makeStore();
    store.register({ id: "s3", kind: "spawn", status: "stopped" });
    const torndown = store.markTorndown("s3");
    expect(torndown?.status).toBe("torndown");
    expect(torndown?.torndownAt).toBeTruthy();
    store.close();
  });

  it("treats kind as immutable on re-register", () => {
    const store = makeStore();
    store.register({ id: "s4", kind: "spawn" });
    const rereg = store.register({ id: "s4", kind: "steward", containerId: "c1" });
    expect(rereg.kind).toBe("spawn"); // kind not flipped
    expect(rereg.containerId).toBe("c1"); // other fields still merge
    store.close();
  });

  it("derives PR-ready extraction lifecycle reads for succeeded results", () => {
    const store = makeStore();
    const result = {
      spawnId: "spawn-ready",
      backend: "codex" as const,
      status: "succeeded" as const,
      patch: {
        spawnId: "spawn-ready",
        backend: "codex" as const,
        patchText: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n",
        touchedPaths: ["a.txt"],
        sha256: "abc123",
      },
      extractedAt: "2026-06-13T00:00:00.000Z",
    };
    store.register({
      id: "spawn-ready",
      kind: "spawn",
      extractionResult: result,
    });

    const read = extractionReadiness(store.get("spawn-ready")!);

    expect(read).toEqual({
      spawnId: "spawn-ready",
      status: "succeeded",
      prReady: true,
      result,
    });
    if (read.status === "succeeded") {
      expect(read.result.patch.patchText).toContain("diff --git");
      expect(read.result.patch.touchedPaths).toEqual(["a.txt"]);
      expect(read.result.patch.sha256).toBe("abc123");
    }
    store.close();
  });

  it("derives terminal non-ready extraction lifecycle reads for failed results without patch payload", () => {
    const store = makeStore();
    const result = {
      spawnId: "spawn-failed",
      backend: "claude-code" as const,
      status: "failed" as const,
      failureReason: "malformed-output",
      diagnostic: "backend JSON was malformed",
      extractedAt: "2026-06-13T00:00:00.000Z",
    };
    store.register({
      id: "spawn-failed",
      kind: "spawn",
      extractionResult: result,
    });

    const read = extractionReadiness(store.get("spawn-failed")!);

    expect(read).toEqual({
      spawnId: "spawn-failed",
      status: "failed",
      prReady: false,
      result,
    });
    if (read.status === "failed") {
      expect(read.result.failureReason).toBe("malformed-output");
      expect(read.result).not.toHaveProperty("patch");
    }
    store.close();
  });

  it("represents missing extraction state distinctly from terminal statuses", () => {
    const store = makeStore();
    store.register({ id: "spawn-missing", kind: "spawn" });

    expect(extractionReadiness(store.get("spawn-missing")!)).toEqual({
      spawnId: "spawn-missing",
      status: "missing",
      prReady: false,
    });
    store.close();
  });

  it("reads one current extraction result after retries rather than duplicate artifacts", () => {
    const store = makeStore();
    store.register({ id: "spawn-retry", kind: "spawn" });
    const first = {
      spawnId: "spawn-retry",
      backend: "codex" as const,
      status: "succeeded" as const,
      patch: {
        spawnId: "spawn-retry",
        backend: "codex" as const,
        patchText: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n",
        touchedPaths: ["a.txt"],
        sha256: "same-digest",
      },
      extractedAt: "2026-06-13T00:00:00.000Z",
    };
    const retry = {
      ...first,
      extractedAt: "2026-06-13T00:01:00.000Z",
    };

    store.update("spawn-retry", { extractionResult: first });
    store.update("spawn-retry", { extractionResult: retry });
    const read = extractionReadiness(store.get("spawn-retry")!);

    expect(read.status).toBe("succeeded");
    expect(read.prReady).toBe(true);
    if (read.status === "succeeded") {
      expect(read.result.patch.sha256).toBe("same-digest");
      expect(read.result.extractedAt).toBe("2026-06-13T00:01:00.000Z");
      expect(read.result.patch).toEqual(retry.patch);
    }
    expect(store.list({ kind: "spawn" })).toHaveLength(1);
    store.close();
  });
});
