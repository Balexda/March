import { describe, expect, it } from "vitest";
import {
  MAX_EXTRACTION_DIAGNOSTIC_CHARS,
  type ExtractionResult,
  persistExtractionResult,
} from "./extraction-result.js";
import type { SessionRepository } from "./repository.js";
import { sqliteAvailable } from "./sqlite.js";
import { SessionStore } from "./store.js";
import type {
  ListSessionsFilter,
  RegisterSessionInput,
  SessionRecord,
  UpdateSessionInput,
} from "./types.js";

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

  it("persists one current successful extraction result on a spawn row", () => {
    const store = makeStore();
    store.register({ id: "spawn-1", kind: "spawn", backend: "codex" });

    const persisted = persistExtractionResult(store, {
      spawnId: "spawn-1",
      backend: "codex",
      extractedAt: "2026-06-13T00:00:00.000Z",
      outcome: {
        status: "accepted",
        patchText: "diff --git a/README.md b/README.md\n",
        touchedPaths: ["README.md"],
        sha256: "digest-1",
      },
    });

    expect(persisted.ok).toBe(true);
    expect(store.get("spawn-1")?.extractionResult).toEqual({
      status: "succeeded",
      spawnId: "spawn-1",
      backend: "codex",
      extractedAt: "2026-06-13T00:00:00.000Z",
      patch: {
        spawnId: "spawn-1",
        backend: "codex",
        patchText: "diff --git a/README.md b/README.md\n",
        touchedPaths: ["README.md"],
        sha256: "digest-1",
      },
    });
    store.close();
  });

  it("persists bounded failed extraction diagnostics", () => {
    const store = makeStore();
    store.register({ id: "spawn-2", kind: "spawn", backend: "claude-code" });
    const diagnostic = "x".repeat(MAX_EXTRACTION_DIAGNOSTIC_CHARS + 10);

    const persisted = persistExtractionResult(store, {
      spawnId: "spawn-2",
      backend: "claude-code",
      extractedAt: "2026-06-13T00:01:00.000Z",
      outcome: {
        status: "failed",
        failureReason: "malformed-output",
        diagnostic,
      },
    });

    expect(persisted.ok).toBe(true);
    const result = store.get("spawn-2")?.extractionResult;
    expect(result).toMatchObject({
      status: "failed",
      spawnId: "spawn-2",
      backend: "claude-code",
      failureReason: "malformed-output",
      extractedAt: "2026-06-13T00:01:00.000Z",
    });
    expect(result?.status === "failed" && result.diagnostic.length).toBe(
      MAX_EXTRACTION_DIAGNOSTIC_CHARS,
    );
    expect(result).not.toHaveProperty("patch");
    store.close();
  });

  it("retries replace the current extraction result instead of appending rows", () => {
    const store = makeStore();
    store.register({ id: "spawn-3", kind: "spawn", backend: "codex" });
    const outcome = {
      status: "accepted" as const,
      patchText: "diff --git a/src/a.ts b/src/a.ts\n",
      touchedPaths: ["src/a.ts"],
      sha256: "stable-digest",
    };

    persistExtractionResult(store, {
      spawnId: "spawn-3",
      backend: "codex",
      extractedAt: "2026-06-13T00:02:00.000Z",
      outcome,
    });
    persistExtractionResult(store, {
      spawnId: "spawn-3",
      backend: "codex",
      extractedAt: "2026-06-13T00:03:00.000Z",
      outcome,
    });

    expect(store.list({ kind: "spawn" }).map((row) => row.id)).toEqual([
      "spawn-3",
    ]);
    const result = store.get("spawn-3")?.extractionResult;
    expect(result?.status).toBe("succeeded");
    expect(result?.status === "succeeded" && result.patch.sha256).toBe(
      "stable-digest",
    );
    expect(result?.extractedAt).toBe("2026-06-13T00:03:00.000Z");
    store.close();
  });

  it("returns a terminal persistence diagnostic when the recorded backend differs", () => {
    const store = makeStore();
    store.register({ id: "spawn-4", kind: "spawn", backend: "claude-code" });

    const persisted = persistExtractionResult(store, {
      spawnId: "spawn-4",
      backend: "codex",
      extractedAt: "2026-06-13T00:06:00.000Z",
      outcome: {
        status: "accepted",
        patchText: "diff --git a/README.md b/README.md\n",
        touchedPaths: ["README.md"],
        sha256: "digest-1",
      },
    });

    expect(persisted.ok).toBe(false);
    expect(persisted.result).toMatchObject({
      status: "failed",
      spawnId: "spawn-4",
      backend: "codex",
      failureReason: "backend-mismatch",
    });
    expect(store.get("spawn-4")?.extractionResult).toBeUndefined();
    store.close();
  });

  it("treats a malformed extraction_result_json column as absent instead of throwing", () => {
    const store = makeStore();
    store.register({ id: "spawn-5", kind: "spawn", backend: "codex" });
    // Simulate a partial write / manual edit / corruption directly in the DB.
    store["db"]
      .prepare(
        "UPDATE sessions SET extraction_result_json = ? WHERE id = ?",
      )
      .run("{not valid json", "spawn-5");

    const record = store.get("spawn-5");
    expect(record).toBeDefined();
    expect(record?.extractionResult).toBeUndefined();
    store.close();
  });

  it("returns a terminal persistence diagnostic when the spawn row is absent", () => {
    const store = makeStore();
    const persisted = persistExtractionResult(store, {
      spawnId: "missing",
      backend: "codex",
      extractedAt: "2026-06-13T00:04:00.000Z",
      outcome: {
        status: "failed",
        failureReason: "no-patch-produced",
        diagnostic: "no patch",
      },
    });

    expect(persisted).toEqual({
      ok: false,
      result: {
        status: "failed",
        spawnId: "missing",
        backend: "codex",
        failureReason: "spawn-session-missing",
        diagnostic:
          'Brood has no spawn session "missing" for extraction persistence.',
        extractedAt: "2026-06-13T00:04:00.000Z",
      },
    });
    expect(store.list()).toEqual([]);
    store.close();
  });

  it("returns a terminal persistence diagnostic when the spawn row goes stale", () => {
    const existing: SessionRecord = {
      id: "stale",
      kind: "spawn",
      status: "stopped",
      createdAt: "2026-06-13T00:00:00.000Z",
      updatedAt: "2026-06-13T00:00:00.000Z",
    };
    const repository: SessionRepository = {
      register(_input: RegisterSessionInput): SessionRecord {
        return existing;
      },
      update(_id: string, _changes: UpdateSessionInput): SessionRecord | undefined {
        return undefined;
      },
      recordExtractionResult(
        _id: string,
        _result: ExtractionResult,
      ): SessionRecord | undefined {
        return undefined;
      },
      get(_id: string): SessionRecord | undefined {
        return existing;
      },
      list(_filter?: ListSessionsFilter): SessionRecord[] {
        return [existing];
      },
      markTorndown(_id: string): SessionRecord | undefined {
        return existing;
      },
      close(): void {
        return undefined;
      },
    };

    const persisted = persistExtractionResult(repository, {
      spawnId: "stale",
      backend: "codex",
      extractedAt: "2026-06-13T00:05:00.000Z",
      outcome: {
        status: "accepted",
        patchText: "diff --git a/README.md b/README.md\n",
        touchedPaths: ["README.md"],
        sha256: "digest-1",
      },
    });

    expect(persisted).toEqual({
      ok: false,
      result: {
        status: "failed",
        spawnId: "stale",
        backend: "codex",
        failureReason: "spawn-session-stale",
        diagnostic:
          'Brood spawn session "stale" disappeared during extraction persistence.',
        extractedAt: "2026-06-13T00:05:00.000Z",
      },
    });
  });
});
