import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnRecordDir } from "../spawn-record.js";
import { sqliteAvailable } from "./sqlite.js";
import { SessionStore } from "./store.js";

const tmpDirs: string[] = [];

function makeStore(): SessionStore {
  return new SessionStore({ dbPath: ":memory:", importSpawnRecords: false });
}

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brood-store-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

  it("imports existing spawn JSON records, mapping steward + failure fields, skipping malformed", () => {
    const home = makeHome();
    const dir = spawnRecordDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "20260520-bbbbbb.json"),
      JSON.stringify({
        version: 1,
        id: "20260520-bbbbbb",
        repoPath: "/repo",
        branch: "march/spawn/20260520-bbbbbb",
        worktreePath: "/wt/bbbbbb",
        backend: "claude-code",
        status: "failed",
        createdAt: "2026-05-20T00:00:00.000Z",
        stewardSessionId: "ad-session-99",
        failureReason: "boom",
        exitCode: 1,
      }),
    );
    // Malformed file is skipped, not fatal.
    fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
    // Non-json (e.g. output log) ignored.
    fs.writeFileSync(path.join(dir, "20260520-bbbbbb.output.log"), "logs");

    const store = new SessionStore({ homeDir: home, importSpawnRecords: true });
    const rec = store.get("20260520-bbbbbb");
    expect(rec?.kind).toBe("spawn");
    expect(rec?.status).toBe("failed");
    expect(rec?.agentDeckSessionId).toBe("ad-session-99");
    expect(rec?.failureReason).toBe("boom");
    expect(rec?.exitCode).toBe(1);
    expect(store.get("broken")).toBeUndefined();
    store.close();
  });

  it("import never overwrites a row already owned by the registry", () => {
    const home = makeHome();
    const dir = spawnRecordDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "id-1.json"),
      JSON.stringify({ id: "id-1", status: "created", repoPath: "/json" }),
    );
    const store = new SessionStore({ homeDir: home, importSpawnRecords: false });
    store.register({ id: "id-1", kind: "spawn", status: "running", repoPath: "/live" });
    store.importSpawnRecords(home);
    const rec = store.get("id-1");
    expect(rec?.status).toBe("running"); // live state preserved
    expect(rec?.repoPath).toBe("/live");
    store.close();
  });
});
