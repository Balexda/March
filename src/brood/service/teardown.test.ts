/**
 * @l1 @deterministic @ci
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode } from "@opentelemetry/api";
import { getActiveOtel, initOtel } from "../../observability/otel.js";
import { sqliteAvailable } from "./sqlite.js";
import { broodArchiveDir, SessionStore } from "./store.js";
import {
  BroodConflictError,
  BroodNotFoundError,
  teardownSession,
  type TeardownDeps,
} from "./teardown.js";
import type { SessionRecord, ExtractionResult } from "./types.js";
import type { TeardownSubstrate } from "./substrate.js";

const tmpDirs: string[] = [];

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brood-teardown-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

interface Recorder {
  calls: string[];
  worktreeTargets: Array<{ worktreePath?: string; branch?: string }>;
  removed: Set<string>;
  deps: TeardownDeps;
}

/** Build injectable deps that record the order + arguments of side effects. */

function lastFinished(home: string, id: string): { stewardIds?: string[] } {
  const entries = fs.readFileSync(path.join(broodArchiveDir(id, home), "teardown.ndjson"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as { event?: string; stewardIds?: string[] });
  return entries.filter((entry) => entry.event === "finished").at(-1) ?? {};
}

function recordingDeps(
  home: string,
  overrides: Partial<TeardownDeps> = {},
  options: { stewardRemovesWorktree?: boolean } = {},
): Recorder {
  const calls: string[] = [];
  const worktreeTargets: Recorder["worktreeTargets"] = [];
  // Worktree paths that currently "exist" on disk; the steward fake can clear
  // one to model castra reclaiming the shared worktree.
  const present = new Set<string>();

  // Substrate adapter (#169): spawn + workspace reclamation behind one
  // injectable seam, mirroring how teardown depends on it in production.
  const substrate: TeardownSubstrate = {
    removeCompute: async ({ sessionId }) => {
      calls.push(`container:${sessionId}`);
    },
    removeWorkspace: (_repo, target) => {
      // The worktree step passes only `worktreePath`; the branch step passes
      // only `branch`. Record them distinctly so order assertions can tell
      // them apart.
      if (target.worktreePath) {
        calls.push(`worktree:${target.worktreePath}`);
        present.delete(target.worktreePath);
      } else if (target.branch) {
        calls.push(`branch:${target.branch}`);
      }
      worktreeTargets.push(target);
      return { worktreeRemoved: true, branchDeleted: true };
    },
  };

  const deps: TeardownDeps = {
    homeDir: home,
    substrate,
    readContainerLogs: (containerId) => {
      calls.push(`logs:${containerId}`);
      return `logs for ${containerId}`;
    },
    removeSteward: async (input) => {
      calls.push(`steward:${input.sessionId}`);
      if (options.stewardRemovesWorktree) {
        present.clear();
      }
      return { outcome: "removed", removedIds: [input.sessionId] };
    },
    pathExists: (p) => present.has(p),
    ...overrides,
  };

  return {
    calls,
    worktreeTargets,
    removed: present,
    deps: {
      ...deps,
      // expose a way for tests to seed "present" paths via removeWorkspace
    },
  };
}

function seedSpawnGroup(store: SessionStore): {
  spawnId: string;
  stewardId: string;
  worktreePath: string;
  branch: string;
} {
  const spawnId = "20260520-aaaaaa";
  const worktreePath = "/wt/aaaaaa";
  const branch = "march/spawn/20260520-aaaaaa";
  store.register({
    id: spawnId,
    kind: "spawn",
    status: "stopped",
    repoPath: "/repo",
    branch,
    worktreePath,
    containerId: "container-aaa",
  });
  const stewardId = "ad-session-aaa";
  store.register({
    id: stewardId,
    kind: "steward",
    parentId: spawnId,
    agentDeckSessionId: stewardId,
    profile: "march",
    status: "running",
  });
  return { spawnId, stewardId, worktreePath, branch };
}

describe.skipIf(!sqliteAvailable)("teardownSession", () => {
  it("runs steps in order: archive → container → steward → worktree → branch", async () => {
    const home = makeHome();
    const store = new SessionStore({ dbPath: ":memory:" });
    const group = seedSpawnGroup(store);
    const rec = recordingDeps(home);
    // worktree is present so the worktree step actually runs.
    rec.deps.pathExists = (p) => p === group.worktreePath;

    const result = await teardownSession(store, group.spawnId, { force: true }, rec.deps);

    const order = rec.calls.map((c) => c.split(":")[0]);
    expect(order).toEqual([
      "logs", // archive reads container logs first
      "container",
      "steward",
      "worktree",
      "branch",
    ]);
    expect(result.status).toBe("torndown");
    store.close();
  });

  it("removes the worktree by the exact registry path, and only that path", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    const group = seedSpawnGroup(store);
    const rec = recordingDeps(makeHome());
    rec.deps.pathExists = (p) => p === group.worktreePath;

    await teardownSession(store, group.spawnId, { force: true }, rec.deps);

    const worktreeCalls = rec.worktreeTargets.filter((t) => t.worktreePath);
    expect(worktreeCalls).toHaveLength(1);
    expect(worktreeCalls[0].worktreePath).toBe(group.worktreePath);
    // branch removal is a separate call carrying only the branch
    const branchCalls = rec.worktreeTargets.filter((t) => t.branch && !t.worktreePath);
    expect(branchCalls).toHaveLength(1);
    expect(branchCalls[0].branch).toBe(group.branch);
    store.close();
  });

  it("skips worktree removal when the steward (castra) already removed it", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    const group = seedSpawnGroup(store);
    const rec = recordingDeps(makeHome(), {}, { stewardRemovesWorktree: true });
    // Worktree exists until the steward fake clears it.
    let present = true;
    rec.deps.pathExists = (p) => present && p === group.worktreePath;
    rec.deps.removeSteward = async (input) => {
      rec.calls.push(`steward:${input.sessionId}`);
      present = false; // castra reclaimed the shared worktree
      return { outcome: "removed", removedIds: [input.sessionId] };
    };

    const result = await teardownSession(store, group.spawnId, { force: true }, rec.deps);

    const worktreeStep = result.steps.find((s) => s.step === "worktree");
    expect(worktreeStep?.outcome).toBe("skipped");
    expect(worktreeStep?.detail).toBe("already removed");
    // The worktree-removal side effect was never invoked.
    expect(rec.worktreeTargets.some((t) => t.worktreePath)).toBe(false);
    store.close();
  });

  it("is idempotent — a second teardown of a torndown session is a no-op", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    const group = seedSpawnGroup(store);
    const rec = recordingDeps(makeHome());
    await teardownSession(store, group.spawnId, { force: true }, rec.deps);

    rec.calls.length = 0;
    const second = await teardownSession(store, group.spawnId, { force: true }, rec.deps);
    expect(second.steps).toEqual([]);
    expect(rec.calls).toEqual([]);
    store.close();
  });

  it("continues after a failing step and records a warning", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    const group = seedSpawnGroup(store);
    const rec = recordingDeps(makeHome());
    rec.deps.pathExists = (p) => p === group.worktreePath;
    rec.deps.substrate = {
      ...rec.deps.substrate!,
      removeCompute: async () => {
        throw new Error("docker daemon down");
      },
    };

    const result = await teardownSession(store, group.spawnId, { force: true }, rec.deps);

    const containerStep = result.steps.find((s) => s.step === "container");
    expect(containerStep?.outcome).toBe("failed");
    expect(result.warnings.some((w) => w.includes("docker daemon down"))).toBe(true);
    // Later steps still ran.
    expect(result.steps.find((s) => s.step === "worktree")?.outcome).toBe("ok");
    expect(result.steps.find((s) => s.step === "branch")?.outcome).toBe("ok");
    expect(result.status).toBe("tearing-down");
    expect(store.get(group.spawnId)?.status).toBe("tearing-down");
    store.close();
  });

  it("marks both the spawn and steward rows torndown", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    const group = seedSpawnGroup(store);
    const rec = recordingDeps(makeHome());
    await teardownSession(store, group.spawnId, { force: true }, rec.deps);
    expect(store.get(group.spawnId)?.status).toBe("torndown");
    expect(store.get(group.stewardId)?.status).toBe("torndown");
    store.close();
  });

  it("resolves the parent spawn when teardown is keyed by the steward id", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    const group = seedSpawnGroup(store);
    const rec = recordingDeps(makeHome());
    rec.deps.pathExists = (p) => p === group.worktreePath;

    const result = await teardownSession(store, group.stewardId, { force: true }, rec.deps);

    // Resolved the spawn → removed the spawn container + worktree.
    expect(rec.calls).toContain(`container:${group.spawnId}`);
    expect(result.id).toBe(group.spawnId);
    store.close();
  });

  it("refuses to tear down a running spawn without force, allows it with force", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "live",
      kind: "spawn",
      status: "running",
      repoPath: "/repo",
      branch: "march/spawn/live",
      worktreePath: "/wt/live",
      containerId: "c-live",
    });
    const rec = recordingDeps(makeHome());

    await expect(
      teardownSession(store, "live", {}, rec.deps),
    ).rejects.toBeInstanceOf(BroodConflictError);

    const forced = await teardownSession(store, "live", { force: true }, rec.deps);
    expect(forced.status).toBe("torndown");
    store.close();
  });

  it("throws BroodNotFoundError for an unknown id", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    await expect(
      teardownSession(store, "nope", {}, recordingDeps(makeHome()).deps),
    ).rejects.toBeInstanceOf(BroodNotFoundError);
    store.close();
  });

  it("keeps requiring force after a lifecycle update moves an interrupted forced teardown out of tearing-down", async () => {
    const homeDir = makeHome();
    const store = new SessionStore({ dbPath: ":memory:" });
    const { spawnId, stewardId } = seedSpawnGroup(store);
    store.update(spawnId, { status: "running" });
    const failing = recordingDeps(homeDir, {
      removeSteward: async () => ({ outcome: "failed", detail: "Castra unavailable", removedIds: [] }),
    });
    try {
      const first = await teardownSession(store, spawnId, { force: true }, failing.deps);
      expect(first.status).toBe("tearing-down");
      store.update(spawnId, { status: "stopped" });
      const rec = recordingDeps(homeDir);
      const before = store.list();
      await expect(teardownSession(store, stewardId, {}, rec.deps))
        .rejects.toBeInstanceOf(BroodConflictError);
      expect(store.list()).toEqual(before);
      expect(rec.calls).toEqual([]);
      expect((await teardownSession(store, spawnId, { force: true }, rec.deps)).status)
        .toBe("torndown");
    } finally {
      store.close();
    }
  });

  it("preserves force admission and cleanup rationale across restart without an archive", async () => {
    const homeDir = makeHome();
    const store = new SessionStore({ homeDir });
    const { spawnId, stewardId } = seedSpawnGroup(store);
    store.update(spawnId, { status: "running", failureReason: "original failure" });
    const original = { session: store.get(spawnId), spawn: store.get(spawnId), steward: store.get(stewardId) };
    const archive = broodArchiveDir(spawnId, homeDir);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, "blocks archive directory creation");
    const unavailable = recordingDeps(homeDir, {
      removeSteward: async () => ({ outcome: "failed", detail: "Castra unavailable", removedIds: [] }),
    });
    try {
      const first = await teardownSession(store, spawnId, {
        force: true, reason: "operator cleanup",
      }, unavailable.deps);
      expect(first.status).toBe("tearing-down");
      expect(unavailable.calls).toEqual([]);
      expect(first.steps[0]).toMatchObject({ step: "archive", outcome: "failed" });
      expect(fs.existsSync(path.join(archive, "record.json"))).toBe(false);
    } finally {
      store.close();
    }

    const restarted = new SessionStore({ homeDir });
    const rec = recordingDeps(homeDir);
    try {
      const before = restarted.list();
      await expect(teardownSession(restarted, stewardId, {
        reason: "rejected overwrite",
      }, rec.deps)).rejects.toBeInstanceOf(BroodConflictError);
      expect(restarted.list()).toEqual(before);
      expect(rec.calls).toEqual([]);
      fs.unlinkSync(archive);
      expect((await teardownSession(restarted, stewardId, { force: true }, rec.deps)).status)
        .toBe("torndown");
    } finally {
      restarted.close();
    }

    expect(JSON.parse(fs.readFileSync(path.join(archive, "record.json"), "utf8"))).toEqual(original);
    const reopened = new SessionStore({ homeDir });
    try {
      expect(reopened.get(spawnId)).toMatchObject({
        status: "torndown",
        failureReason: "original failure",
        teardownReason: "operator cleanup",
      });
    } finally {
      reopened.close();
    }
  });

  it("uses the Legate session identity for cleanup and the recorded ID for logs", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    const home = makeHome();
    const rec = recordingDeps(home);
    const removeCompute = vi.fn(async () => {});
    rec.deps.substrate = { ...rec.deps.substrate!, removeCompute };
    store.register({ id: "ephemeral", kind: "legate", containerId: "march-legate" });

    const result = await teardownSession(store, "ephemeral", {}, rec.deps);

    expect(rec.calls).toEqual(["logs:march-legate"]);
    expect(removeCompute).toHaveBeenCalledOnce();
    expect(removeCompute).toHaveBeenCalledWith({
      sessionId: "ephemeral", kind: "legate", containerName: "march-legate-ephemeral",
    });
    expect(result.status).toBe("torndown");
    // The standalone legate row itself is archived, captured before tearing-down.
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(broodArchiveDir("ephemeral", home), "record.json"), "utf-8"),
    );
    expect(snapshot.session).toMatchObject({ id: "ephemeral", kind: "legate", containerId: "march-legate" });
    expect(snapshot.session.status).not.toBe("tearing-down");
    store.close();
  });

  it("defers all removal when readable logs cannot be written", async () => {
    const home = makeHome();
    const store = new SessionStore({ dbPath: ":memory:" });
    const { spawnId } = seedSpawnGroup(store);
    const rec = recordingDeps(home);
    fs.mkdirSync(path.join(broodArchiveDir(spawnId, home), "container.log"), { recursive: true });

    const result = await teardownSession(store, spawnId, {}, rec.deps);

    expect(result.status).toBe("tearing-down");
    expect(result.steps.map(({ outcome }) => outcome)).toEqual(["failed", "skipped", "skipped", "skipped", "skipped"]);
    expect(rec.calls).toEqual(["logs:container-aaa"]);
    store.close();
  });

  it("writes a record snapshot + container log to the archive dir", async () => {
    const home = makeHome();
    const store = new SessionStore({ dbPath: ":memory:" });
    const group = seedSpawnGroup(store);
    const rec = recordingDeps(home);
    await teardownSession(store, group.spawnId, { force: true }, rec.deps);

    const dir = broodArchiveDir(group.spawnId, home);
    expect(fs.existsSync(path.join(dir, "record.json"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "container.log"), "utf-8")).toContain(
      "logs for container-aaa",
    );
    store.close();
  });

  it("archives validated registry evidence before removal and keeps worktree files out", async () => {
    const home = makeHome();
    const store = new SessionStore({ dbPath: ":memory:" });
    const { spawnId } = seedSpawnGroup(store);
    const worktreePath = path.join(home, "worktree");
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "unrelated.txt"), "worktree evidence");
    const patchText = "registry patch\n";
    const sha256 = createHash("sha256").update(patchText).digest("hex");
    const extractionResult: ExtractionResult = {
      spawnId, backend: "codex", status: "succeeded", extractedAt: "2026-08-19T00:00:00Z",
      patch: { spawnId, backend: "codex", patchText, sha256, touchedPaths: [] },
    };
    store.update(spawnId, { worktreePath, extractionResult });
    const dir = broodArchiveDir(spawnId, home);
    const rec = recordingDeps(home);
    const remove = vi.spyOn(rec.deps.substrate!, "removeCompute").mockImplementation(async () => {
      expect(fs.readdirSync(dir).sort()).toEqual([
        "artifacts", "container.log", "record.json", "teardown.ndjson",
      ]);
      expect(fs.readdirSync(path.join(dir, "artifacts")).sort()).toEqual([
        "extraction-result.json", "spawn.patch",
      ]);
      expect(fs.readFileSync(path.join(dir, "container.log"), "utf8")).toBe("logs for container-aaa");
      expect(JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "extraction-result.json"), "utf8")))
        .toEqual(extractionResult);
      expect(createHash("sha256").update(fs.readFileSync(path.join(dir, "artifacts", "spawn.patch")))
        .digest("hex")).toBe(sha256);
    });
    try {
      expect((await teardownSession(store, spawnId, {}, rec.deps)).status).toBe("torndown");
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      store.close();
    }
  });

  it("serializes group requests and journals a failed steward removal followed by a retry", async () => {
    const home = makeHome();
    const store = new SessionStore({ dbPath: ":memory:" });
    const { spawnId, stewardId } = seedSpawnGroup(store);
    const original = { session: store.get(spawnId), spawn: store.get(spawnId), steward: store.get(stewardId) };
    const rec = recordingDeps(home);
    const dir = broodArchiveDir(spawnId, home);
    const snapshotPath = path.join(dir, "record.json");
    const journalPath = path.join(dir, "teardown.ndjson");
    const available = rec.deps.readContainerLogs!;
    rec.deps.readContainerLogs = vi.fn(available).mockImplementationOnce(available)
      .mockImplementation(() => { throw new Error("container gone"); });
    let firstSnapshot: string | undefined;
    const removeSteward = rec.deps.removeSteward!;
    rec.deps.removeSteward = vi.fn(removeSteward).mockImplementationOnce(async () => {
      firstSnapshot = fs.readFileSync(snapshotPath, "utf8");
      return { outcome: "failed", removedIds: [], detail: "unavailable" };
    });

    try {
      const [first, retry] = await Promise.all([
        teardownSession(store, spawnId, { reason: "cleanup" }, rec.deps),
        teardownSession(store, stewardId, {}, rec.deps),
      ]);
      expect(first.status).toBe("tearing-down");
      expect(retry.status).toBe("torndown");
      expect(retry.warnings).toContain("container logs unavailable: container gone");
      expect(fs.readFileSync(path.join(dir, "container.log"), "utf8")).toBe("logs for container-aaa");
      expect(fs.readFileSync(snapshotPath, "utf8")).toBe(firstSnapshot);
      expect(JSON.parse(firstSnapshot!)).toEqual(original);
      const history = fs.readFileSync(journalPath, "utf8");
      const entries = history.trim().split("\n").map((line) => JSON.parse(line));
      expect(entries).toMatchObject([
        { attempt: 1, event: "started", at: expect.any(String), request: { force: false, kill: false, reason: "cleanup" } },
        { attempt: 1, event: "finished", at: expect.any(String), status: first.status, steps: JSON.parse(JSON.stringify(first.steps)), warnings: first.warnings },
        { attempt: 2, event: "started", at: expect.any(String), request: { force: false, kill: false } },
        { attempt: 2, event: "finished", at: expect.any(String), status: retry.status, steps: JSON.parse(JSON.stringify(retry.steps)), warnings: retry.warnings },
      ]);
      expect((await teardownSession(store, spawnId, {}, rec.deps)).steps).toEqual([]);
      expect(fs.readFileSync(journalPath, "utf8")).toBe(history);
    } finally {
      store.close();
    }
  });

  it("keeps legacy snapshot bytes and treats malformed extraction as an optional source", async () => {
    const home = makeHome();
    const store = new SessionStore({ dbPath: ":memory:" });
    const { spawnId } = seedSpawnGroup(store);
    store.update(spawnId, {
      extractionResult: { status: "succeeded" } as SessionRecord["extractionResult"],
    });
    const dir = broodArchiveDir(spawnId, home);
    fs.mkdirSync(dir, { recursive: true });
    const legacy = '{"spawn":{"status":"stopped"},"torndownAt":"legacy"}\n';
    const snapshot = path.join(dir, "record.json");
    fs.writeFileSync(snapshot, legacy);
    try {
      const result = await teardownSession(store, spawnId, {}, recordingDeps(home).deps);
      expect(result.status).toBe("torndown");
      expect(result.warnings).toContain("registry extraction result unavailable or malformed");
      expect(fs.existsSync(path.join(dir, "artifacts"))).toBe(false);
      expect(fs.readFileSync(snapshot, "utf8")).toBe(legacy);
    } finally {
      store.close();
    }
  });

  it.each(["record.json", "teardown.ndjson", "container.log", "artifacts/extraction-result.json", "artifacts/spawn.patch"])(
    "blocks removal when the archive cannot write %s", async (blockedFile) => {
      const home = makeHome();
      const store = new SessionStore({ dbPath: ":memory:" });
      const { spawnId } = seedSpawnGroup(store);
      const patchText = "registry patch";
      store.update(spawnId, { extractionResult: {
        spawnId, backend: "codex", status: "succeeded", extractedAt: "2026-08-19T00:00:00Z",
        patch: { spawnId, backend: "codex", patchText, touchedPaths: [],
          sha256: createHash("sha256").update(patchText).digest("hex") },
      } });
      const blocked = path.join(broodArchiveDir(spawnId, home), blockedFile);
      let failedAppend: ReturnType<typeof vi.spyOn> | undefined;
      if (blockedFile === "teardown.ndjson") {
        const rename = fs.renameSync;
        failedAppend = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
          if (target === blocked) throw new Error("journal unavailable");
          rename(source, target);
        });
      } else {
        fs.mkdirSync(blocked, { recursive: true });
      }
      const rec = recordingDeps(home);
      try {
        const result = await teardownSession(store, spawnId, {}, rec.deps);
        expect(result.status).toBe("tearing-down");
        expect(result.steps[0]).toMatchObject({ step: "archive", outcome: "failed" });
        expect(result.steps.slice(1).every(({ outcome }) => outcome === "skipped")).toBe(true);
        expect(rec.calls.filter((call) => !call.startsWith("logs:"))).toEqual([]);
      } finally {
        failedAppend?.mockRestore();
        store.close();
      }
    },
  );

  it.each([false, true])("distinguishes source and archive digest mismatches (read-back: %s)", async (readBack) => {
    const home = makeHome();
    const store = new SessionStore({ dbPath: ":memory:" });
    const { spawnId } = seedSpawnGroup(store);
    const patchText = "registry patch";
    const patchPath = path.join(broodArchiveDir(spawnId, home), "artifacts", "spawn.patch");
    store.update(spawnId, { extractionResult: {
      spawnId, backend: "codex", status: "succeeded", extractedAt: "2026-08-19T00:00:00Z",
      patch: { spawnId, backend: "codex", patchText, touchedPaths: [],
        sha256: createHash("sha256").update(readBack ? patchText : "different text").digest("hex") },
    } });
    const rec = recordingDeps(home);
    const readFile = fs.readFileSync;
    const spy = readBack ? vi.spyOn(fs, "readFileSync").mockImplementation((file, options) =>
      file === patchPath ? Buffer.from("corrupt archive") : readFile(file, options)) : undefined;
    try {
      const result = await teardownSession(store, spawnId, {}, rec.deps);
      expect(result.status).toBe(readBack ? "tearing-down" : "torndown");
      expect(result.steps[0]?.outcome).toBe(readBack ? "failed" : "ok");
      expect(result.warnings).toContain(readBack
        ? "archive failed: archived extraction patch digest mismatch"
        : "registry extraction patch digest mismatch");
      expect(fs.existsSync(patchPath)).toBe(readBack);
      expect(rec.calls.includes(`container:${spawnId}`)).toBe(!readBack);
    } finally {
      spy?.mockRestore();
      store.close();
    }
  });

  it("keeps the archived patch and registry result consistent across source changes", async () => {
    const home = makeHome();
    const store = new SessionStore({ dbPath: ":memory:" });
    const { spawnId } = seedSpawnGroup(store);
    const patchText = "original registry patch";
    const result = {
      spawnId, backend: "codex", status: "succeeded", extractedAt: "2026-08-19T00:00:00Z",
      patch: { spawnId, backend: "codex", patchText, touchedPaths: [],
        sha256: createHash("sha256").update(patchText).digest("hex") },
    } satisfies ExtractionResult;
    store.update(spawnId, { extractionResult: result });
    const artifacts = path.join(broodArchiveDir(spawnId, home), "artifacts");
    const resultPath = path.join(artifacts, "extraction-result.json");
    const patchPath = path.join(artifacts, "spawn.patch");
    const retryable = recordingDeps(home, {
      removeSteward: async () => ({ outcome: "failed", detail: "unavailable", removedIds: [] }),
    }).deps;
    try {
      expect((await teardownSession(store, spawnId, {}, retryable)).status).toBe("tearing-down");
      store.update(spawnId, {
        extractionResult: { ...result, patch: { ...result.patch, patchText: "changed bytes" } },
      });
      const mismatch = await teardownSession(store, spawnId, {}, retryable);
      expect(mismatch.warnings).toContain("registry extraction patch digest mismatch");
      expect(JSON.parse(fs.readFileSync(resultPath, "utf8"))).toEqual(result);
      expect(fs.readFileSync(patchPath, "utf8")).toBe(patchText);

      const failure = {
        spawnId, backend: "codex", status: "failed",
        failureReason: "no changes exported", extractedAt: result.extractedAt,
      } satisfies ExtractionResult;
      store.update(spawnId, { extractionResult: failure });
      const retry = await teardownSession(store, spawnId, {}, recordingDeps(home).deps);
      expect(retry.status).toBe("torndown");
      expect(JSON.parse(fs.readFileSync(resultPath, "utf8"))).toEqual(failure);
      expect(fs.existsSync(patchPath)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("keeps an unmatched start when journal finalization fails after removal", async () => {
    const home = makeHome();
    const store = new SessionStore({ dbPath: ":memory:" });
    const { spawnId } = seedSpawnGroup(store);
    const dir = broodArchiveDir(spawnId, home);
    const journal = path.join(dir, "teardown.ndjson");
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (target === journal && fs.existsSync(journal)) throw new Error("archive unavailable");
      rename(source, target);
    });
    const rec = recordingDeps(home);
    try {
      const result = await teardownSession(store, spawnId, {}, rec.deps);
      expect(result.status).toBe("tearing-down");
      expect(result.steps.find(({ step }) => step === "container")?.outcome).toBe("ok");
      expect(result.warnings).toContain("archive finalization failed: archive unavailable");
      expect(store.get(spawnId)?.status).toBe("tearing-down");
      const interrupted = fs.readFileSync(journal, "utf8");
      expect(JSON.parse(interrupted)).toMatchObject({ attempt: 1, event: "started" });
      const snapshot = fs.readFileSync(path.join(dir, "record.json"), "utf8");
      spy.mockRestore();
      expect((await teardownSession(store, spawnId, {}, rec.deps)).status).toBe("torndown");
      expect(fs.readFileSync(path.join(dir, "record.json"), "utf8")).toBe(snapshot);
      const history = fs.readFileSync(journal, "utf8");
      expect(history.startsWith(interrupted)).toBe(true);
      expect(history.trim().split("\n").map((line) => JSON.parse(line))).toMatchObject([
        { attempt: 1, event: "started" },
        { attempt: 2, event: "started" },
        { attempt: 2, event: "finished", status: "torndown" },
      ]);
    } finally {
      spy.mockRestore();
      store.close();
    }
  });

  it("recovers the registry after a restart following journal finalization", async () => {
    const homeDir = makeHome();
    const store = new SessionStore({ homeDir });
    const { spawnId, stewardId } = seedSpawnGroup(store);
    store.update(spawnId, { status: "running" });
    const update = store.update.bind(store);
    vi.spyOn(store, "update").mockImplementation((id, changes) => {
      if (id === spawnId && changes.status === "torndown") throw new Error("registry unavailable");
      return update(id, changes);
    });
    const rec = recordingDeps(homeDir);
    const journal = path.join(broodArchiveDir(spawnId, homeDir), "teardown.ndjson");
    try {
      await expect(teardownSession(store, spawnId, { force: true }, rec.deps))
        .rejects.toThrow("registry unavailable");
      expect(store.get(spawnId)?.status).toBe("tearing-down");
    } finally {
      store.close();
    }

    const restarted = new SessionStore({ homeDir });
    try {
      const history = fs.readFileSync(journal, "utf8");
      const finished = JSON.parse(history.trim().split("\n").at(-1)!);
      expect(finished).toMatchObject({ event: "finished", status: "torndown" });
      rec.calls.length = 0;
      const result = await teardownSession(restarted, stewardId, {}, rec.deps);
      expect(result).toMatchObject({ status: "torndown", steps: [], warnings: [] });
      for (const id of [spawnId, stewardId]) {
        expect(restarted.get(id)).toMatchObject({ status: finished.status, torndownAt: finished.at });
      }
      expect(rec.calls).toEqual([]);
      expect(fs.readFileSync(journal, "utf8")).toBe(history);

      restarted.update(spawnId, { status: "running" });
      await expect(teardownSession(restarted, spawnId, {}, rec.deps))
        .rejects.toBeInstanceOf(BroodConflictError);
      expect(restarted.get(spawnId)?.status).toBe("running");
      expect(fs.readFileSync(journal, "utf8")).toBe(history);
    } finally {
      restarted.close();
    }
  });

  it("reconciles a pending completion after a status-only PATCH without repeating cleanup", async () => {
    const homeDir = makeHome();
    const store = new SessionStore({ homeDir });
    const { spawnId, stewardId } = seedSpawnGroup(store);
    const update = store.update.bind(store);
    const fail = vi.spyOn(store, "update").mockImplementation((id, changes) => {
      if (id === spawnId && changes.status === "torndown") throw new Error("registry unavailable");
      return update(id, changes);
    });
    const rec = recordingDeps(homeDir);
    try {
      await expect(teardownSession(store, spawnId, {}, rec.deps)).rejects.toThrow("registry unavailable");
      fail.mockRestore();
      store.update(spawnId, { status: "stopped" });
      rec.calls.length = 0;
      const result = await teardownSession(store, spawnId, {}, rec.deps);
      expect(result).toMatchObject({ status: "torndown", steps: [] });
      expect(rec.calls).toEqual([]);
      expect(store.get(spawnId)?.status).toBe("torndown");
      expect(store.get(stewardId)?.status).toBe("torndown");
    } finally {
      store.close();
    }
  });

  it("recovers only the steward the completed attempt verified", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const created = captureSpans();
    const homeDir = makeHome();
    const store = new SessionStore({ homeDir });
    const { spawnId, stewardId } = seedSpawnGroup(store);
    const update = store.update.bind(store);
    const fail = vi.spyOn(store, "update").mockImplementation((id, changes) => {
      if (id === spawnId && changes.status === "torndown") throw new Error("registry unavailable");
      return update(id, changes);
    });
    const rec = recordingDeps(homeDir);
    try {
      await expect(teardownSession(store, spawnId, {}, rec.deps)).rejects.toThrow("registry unavailable");
      fail.mockRestore();
      // The failed transaction rolled back the verified steward's update.
      expect(store.get(stewardId)?.status).toBe("tearing-down");
      store.register({ id: "ad-session-bbb", kind: "steward", parentId: spawnId, status: "running" });
      created.length = 0;
      rec.calls.length = 0;

      const result = await teardownSession(store, "ad-session-bbb", {}, rec.deps);
      expect(rec.calls).toEqual([]);
      expect(result.status).toBe("tearing-down");
      expect(result.warnings).toEqual([expect.stringContaining('"ad-session-bbb"')]);
      expect(store.get(spawnId)?.status).toBe("torndown");
      expect(store.get(stewardId)?.status).toBe("torndown");
      expect(store.get("ad-session-bbb")?.status).toBe("running");
      const root = created.find((span) => span.name === "brood.teardown");
      expect(root?.attributes["march.teardown.outcome"]).toBe("partial");
    } finally {
      store.close();
    }
  });

  it("tears down a re-registered resource identity instead of recovering over it", async () => {
    const homeDir = makeHome();
    const store = new SessionStore({ homeDir });
    const { spawnId } = seedSpawnGroup(store);
    const update = store.update.bind(store);
    const fail = vi.spyOn(store, "update").mockImplementation((id, changes) => {
      if (id === spawnId && changes.status === "torndown") throw new Error("registry unavailable");
      return update(id, changes);
    });
    const rec = recordingDeps(homeDir);
    try {
      await expect(teardownSession(store, spawnId, {}, rec.deps)).rejects.toThrow("registry unavailable");
      fail.mockRestore();
      store.register({
        id: spawnId, kind: "spawn", status: "running", containerId: "container-new", worktreePath: "/wt/new",
      });
      rec.calls.length = 0;
      rec.deps.pathExists = (candidate) => candidate === "/wt/new";
      await expect(teardownSession(store, spawnId, {}, rec.deps)).rejects.toBeInstanceOf(BroodConflictError);
      expect(store.get(spawnId)?.status).toBe("running");

      const result = await teardownSession(store, spawnId, { force: true }, rec.deps);
      expect(result.status).toBe("torndown");
      expect(result.steps.map((step) => step.step)).toEqual(["archive", "container", "steward", "worktree", "branch"]);
      expect(rec.calls).toContain("logs:container-new");
      expect(rec.worktreeTargets).toContainEqual(expect.objectContaining({ worktreePath: "/wt/new" }));
    } finally {
      store.close();
    }
  });

  it("keeps a spawn-addressed recovery open until every later steward is removed", async () => {
    const homeDir = makeHome();
    const store = new SessionStore({ homeDir });
    const { spawnId, stewardId } = seedSpawnGroup(store);
    const update = store.update.bind(store);
    const fail = vi.spyOn(store, "update").mockImplementation((id, changes) => {
      if (id === spawnId && changes.status === "torndown") throw new Error("registry unavailable");
      return update(id, changes);
    });
    const rec = recordingDeps(homeDir);
    try {
      await expect(teardownSession(store, spawnId, {}, rec.deps)).rejects.toThrow("registry unavailable");
      fail.mockRestore();
      store.register({ id: "ad-session-bbb", kind: "steward", parentId: spawnId, status: "running" });
      rec.calls.length = 0;

      const recovered = await teardownSession(store, spawnId, {}, rec.deps);
      expect(rec.calls).toEqual([]);
      expect(recovered.status).toBe("tearing-down");
      const firstTorndownAt = store.get(spawnId)?.torndownAt;
      expect(firstTorndownAt).toBeDefined();
      expect(recovered.warnings).toEqual([expect.stringContaining('"ad-session-bbb"')]);
      expect(store.get(stewardId)?.status).toBe("torndown");
      expect(store.get("ad-session-bbb")?.status).toBe("running");

      const retried = await teardownSession(store, spawnId, {}, rec.deps);
      expect(retried.status).toBe("torndown");
      expect(rec.calls).toContain("steward:ad-session-bbb");
      expect(store.get("ad-session-bbb")?.status).toBe("torndown");
      expect(store.get(spawnId)?.torndownAt).toBe(firstTorndownAt);
    } finally {
      store.close();
    }
  });

  it("removes every live steward under the spawn before reclaiming the shared worktree", async () => {
    const homeDir = makeHome();
    const store = new SessionStore({ homeDir });
    const { spawnId, stewardId } = seedSpawnGroup(store);
    store.register({ id: "ad-session-bbb", kind: "steward", parentId: spawnId, status: "running" });
    store.register({ id: "ad-session-ccc", kind: "steward", parentId: spawnId, status: "running" });
    const rec = recordingDeps(homeDir);
    try {
      const result = await teardownSession(store, spawnId, {}, rec.deps);
      expect(result.status).toBe("torndown");
      const stewardCalls = rec.calls.filter((call) => call.startsWith("steward:"));
      expect(stewardCalls).toHaveLength(3);
      for (const id of [stewardId, "ad-session-bbb", "ad-session-ccc"]) {
        expect(store.get(id)?.status, id).toBe("torndown");
      }
      const lastSteward = Math.max(...stewardCalls.map((call) => rec.calls.indexOf(call)));
      const firstGit = rec.calls.findIndex((call) => call.startsWith("worktree:") || call.startsWith("branch:"));
      if (firstGit >= 0) expect(firstGit).toBeGreaterThan(lastSteward);
    } finally {
      store.close();
    }
  });

  it("defers worktree cleanup when a second steward under the spawn cannot be removed", async () => {
    const homeDir = makeHome();
    const store = new SessionStore({ homeDir });
    const { spawnId, stewardId } = seedSpawnGroup(store);
    store.register({ id: "ad-session-ccc", kind: "steward", parentId: spawnId, status: "running" });
    const rec = recordingDeps(homeDir);
    const remove = rec.deps.removeSteward!;
    rec.deps.removeSteward = async (input) => input.sessionId === "ad-session-ccc"
      ? (rec.calls.push(`steward:${input.sessionId}`), { outcome: "failed", detail: "still live", removedIds: [] })
      : remove(input);
    try {
      const result = await teardownSession(store, spawnId, {}, rec.deps);
      expect(result.status).not.toBe("torndown");
      expect(result.warnings.join("\n")).toContain("ad-session-ccc");
      expect(rec.calls.some((call) => call.startsWith("worktree:") || call.startsWith("branch:"))).toBe(false);
      expect(store.get("ad-session-ccc")?.status).not.toBe("torndown");
      expect(lastFinished(homeDir, spawnId).stewardIds).toEqual([stewardId]);
    } finally {
      store.close();
    }
  });

  it("defers Git cleanup when a steward registers while another is being removed", async () => {
    const homeDir = makeHome();
    const store = new SessionStore({ homeDir });
    const { spawnId, stewardId } = seedSpawnGroup(store);
    const rec = recordingDeps(homeDir);
    const remove = rec.deps.removeSteward!;
    rec.deps.removeSteward = async (input) => {
      if (!store.get("ad-session-late")) {
        store.register({ id: "ad-session-late", kind: "steward", parentId: spawnId, status: "running" });
      }
      return remove(input);
    };
    try {
      const result = await teardownSession(store, spawnId, {}, rec.deps);
      expect(result.status).toBe("tearing-down");
      expect(result.warnings.join("\n")).toContain('"ad-session-late"');
      expect(rec.calls.some((call) => call.startsWith("worktree:") || call.startsWith("branch:"))).toBe(false);
      expect(result.steps.find((step) => step.step === "worktree")?.detail)
        .toBe("deferred: steward registered during teardown");
      expect(lastFinished(homeDir, spawnId).stewardIds).toEqual([stewardId]);

      rec.calls.length = 0;
      const retried = await teardownSession(store, spawnId, {}, rec.deps);
      expect(retried.status).toBe("torndown");
      expect(rec.calls).toContain("steward:ad-session-late");
      expect(store.get("ad-session-late")?.status).toBe("torndown");
    } finally {
      store.close();
    }
  });

  it("journals no verified stewards when archiving fails before removal", async () => {
    const homeDir = makeHome();
    const store = new SessionStore({ homeDir });
    const { spawnId } = seedSpawnGroup(store);
    const patchText = "registry patch";
    const patchPath = path.join(broodArchiveDir(spawnId, homeDir), "artifacts", "spawn.patch");
    store.update(spawnId, { extractionResult: {
      spawnId, backend: "codex", status: "succeeded", extractedAt: "2026-08-19T00:00:00Z",
      patch: { spawnId, backend: "codex", patchText, touchedPaths: [],
        sha256: createHash("sha256").update(patchText).digest("hex") },
    } });
    const readFile = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) =>
      file === patchPath ? Buffer.from("corrupt archive") : readFile(file, options));
    const rec = recordingDeps(homeDir);
    try {
      const result = await teardownSession(store, spawnId, {}, rec.deps);
      expect(result.steps[0]?.outcome).toBe("failed");
      expect(rec.calls.some((call) => call.startsWith("steward:"))).toBe(false);
      expect(lastFinished(homeDir, spawnId).stewardIds).toEqual([]);
    } finally {
      spy.mockRestore();
      store.close();
    }
  });

  it("leaves a steward that moved to another spawn mid-teardown under its new owner", async () => {
    const homeDir = makeHome();
    const store = new SessionStore({ homeDir });
    const { spawnId, stewardId } = seedSpawnGroup(store);
    store.register({ id: "20260520-qqqqqq", kind: "spawn", status: "stopped" });
    const rec = recordingDeps(homeDir);
    const remove = rec.deps.removeSteward!;
    rec.deps.removeSteward = async (input) => {
      const result = await remove(input);
      store.register({ id: stewardId, kind: "steward", parentId: "20260520-qqqqqq", status: "running" });
      return result;
    };
    try {
      expect((await teardownSession(store, spawnId, {}, rec.deps)).status).toBe("torndown");
      expect(store.get(stewardId)).toMatchObject({ parentId: "20260520-qqqqqq", status: "running" });
      expect(store.get(stewardId)?.torndownAt).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it.each([
    ["re-parented to another spawn", { parentId: "20260520-qqqqqq" }, false],
    ["re-registered with a new Castra session", { agentDeckSessionId: "ad-session-new" }, true],
  ] as const)("does not recover a verified steward that was %s", async (_label, change, sameSpawn) => {
    const homeDir = makeHome();
    const store = new SessionStore({ homeDir });
    const { spawnId, stewardId } = seedSpawnGroup(store);
    store.register({ id: "20260520-qqqqqq", kind: "spawn", status: "stopped" });
    const update = store.update.bind(store);
    const fail = vi.spyOn(store, "update").mockImplementation((id, changes) => {
      if (id === spawnId && changes.status === "torndown") throw new Error("registry unavailable");
      return update(id, changes);
    });
    const rec = recordingDeps(homeDir);
    try {
      await expect(teardownSession(store, spawnId, {}, rec.deps)).rejects.toThrow("registry unavailable");
      fail.mockRestore();
      store.register({ id: stewardId, kind: "steward", status: "running", ...change });
      rec.calls.length = 0;

      const recovered = await teardownSession(store, spawnId, {}, rec.deps);
      expect(rec.calls).toEqual([]);
      expect(store.get(spawnId)?.status).toBe("torndown");
      expect(store.get(stewardId)?.status).toBe("running");
      expect(recovered.status).toBe(sameSpawn ? "tearing-down" : "torndown");
      if (sameSpawn) {
        expect(recovered.warnings.join("\n")).toContain(`"${stewardId}"`);
        const retried = await teardownSession(store, spawnId, {}, rec.deps);
        expect(retried.status).toBe("torndown");
        expect(rec.calls).toContain("steward:ad-session-new");
        expect(store.get(stewardId)?.status).toBe("torndown");
      }
    } finally {
      store.close();
    }
  });

  it("records a successful registry recovery in the teardown span", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const created = captureSpans();
    const homeDir = makeHome();
    const store = new SessionStore({ homeDir });
    const { spawnId } = seedSpawnGroup(store);
    const update = store.update.bind(store);
    const fail = vi.spyOn(store, "update").mockImplementation((id, changes) => {
      if (id === spawnId && changes.status === "torndown") throw new Error("registry unavailable");
      return update(id, changes);
    });
    const rec = recordingDeps(homeDir);
    try {
      await expect(teardownSession(store, spawnId, {}, rec.deps)).rejects.toThrow("registry unavailable");
      fail.mockRestore();
      created.length = 0;
      expect((await teardownSession(store, spawnId, {}, rec.deps)).status).toBe("torndown");
      const root = created.find((span) => span.name === "brood.teardown");
      expect(root?.attributes["march.teardown.outcome"]).toBe("success");
      expect(root?.status.code).not.toBe(SpanStatusCode.ERROR);
    } finally {
      store.close();
    }
  });

  it("archives an extraction result committed while container logs are read", async () => {
    const home = makeHome();
    const store = new SessionStore({ dbPath: ":memory:" });
    const { spawnId } = seedSpawnGroup(store);
    const patchText = "late patch\n";
    const sha256 = createHash("sha256").update(patchText).digest("hex");
    const extractionResult: ExtractionResult = {
      spawnId, backend: "codex", status: "succeeded", extractedAt: "2026-08-19T00:00:00Z",
      patch: { spawnId, backend: "codex", patchText, sha256, touchedPaths: [] },
    };
    const rec = recordingDeps(home, {
      readContainerLogs: async () => {
        store.update(spawnId, { extractionResult });
        return "logs";
      },
    });
    try {
      const result = await teardownSession(store, spawnId, {}, rec.deps);
      expect(result.status).toBe("torndown");
      expect(result.warnings).not.toContain("registry extraction result unavailable or malformed");
      expect(fs.readFileSync(path.join(broodArchiveDir(spawnId, home), "artifacts", "spawn.patch"), "utf8"))
        .toBe(patchText);
    } finally {
      store.close();
    }
  });

  it("queues a steward on its new spawn's archive when it is re-parented while waiting", async () => {
    const home = makeHome();
    const store = new SessionStore({ dbPath: ":memory:" });
    const { spawnId, stewardId } = seedSpawnGroup(store);
    store.register({
      id: "20260520-bbbbbb", kind: "spawn", status: "stopped", repoPath: "/repo",
      branch: "march/spawn/20260520-bbbbbb", worktreePath: "/wt/bbbbbb", containerId: "container-bbb",
    });
    let releaseP!: () => void;
    let releaseQ!: () => void;
    const gateP = new Promise<void>((resolve) => { releaseP = resolve; });
    const gateQ = new Promise<void>((resolve) => { releaseQ = resolve; });
    const order: string[] = [];
    const rec = recordingDeps(home, {
      readContainerLogs: async (containerId) => {
        order.push(`start:${containerId}`);
        if (containerId === "container-aaa") await gateP;
        if (containerId === "container-bbb" && !order.includes("end:container-bbb")) await gateQ;
        order.push(`end:${containerId}`);
        return "logs";
      },
    });
    try {
      const first = teardownSession(store, spawnId, { reason: "P" }, rec.deps);
      await vi.waitFor(() => expect(order).toContain("start:container-aaa"));
      const queued = teardownSession(store, stewardId, { reason: "steward" }, rec.deps);
      // Re-parent the waiting steward, then start Q's teardown.
      store.register({ id: stewardId, kind: "steward", parentId: "20260520-bbbbbb" });
      const q = teardownSession(store, "20260520-bbbbbb", { reason: "Q" }, rec.deps);
      await vi.waitFor(() => expect(order).toContain("start:container-bbb"));
      releaseP();
      await first;
      // The re-parented request must wait for Q rather than run beside it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(order.filter((entry) => entry === "start:container-bbb")).toHaveLength(1);
      releaseQ();
      await Promise.all([q, queued]);
      const journal = fs.readFileSync(
        path.join(broodArchiveDir("20260520-bbbbbb", home), "teardown.ndjson"), "utf8",
      ).trim().split("\n").map((line) => JSON.parse(line));
      expect(journal.map((entry) => `${entry.attempt}:${entry.event}`)).toEqual(
        journal.map((_, index) => `${Math.floor(index / 2) + 1}:${index % 2 ? "finished" : "started"}`),
      );
    } finally {
      store.close();
    }
  });

  it("defers worktree + branch when steward removal fails (does not orphan a live checkout)", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    const group = seedSpawnGroup(store);
    const rec = recordingDeps(makeHome());
    rec.deps.pathExists = (p) => p === group.worktreePath;
    // Castra unreachable → removeSteward throws.
    rec.deps.removeSteward = async () => {
      throw new Error("Could not reach Castra");
    };

    const result = await teardownSession(store, group.spawnId, { force: true }, rec.deps);

    expect(result.status).toBe("tearing-down"); // deferred, not torndown
    expect(result.steps.find((s) => s.step === "steward")?.outcome).toBe("failed");
    const worktree = result.steps.find((s) => s.step === "worktree");
    expect(worktree?.outcome).toBe("skipped");
    expect(worktree?.detail).toContain("deferred");
    // The worktree was never actually removed...
    expect(rec.worktreeTargets.some((t) => t.worktreePath)).toBe(false);
    // ...and the registry row is left retryable (not torndown).
    expect(store.get(group.spawnId)?.status).toBe("tearing-down");
    store.close();
  });

  it("defers (does not mark torndown) when steward removal returns failed", async () => {
    // The verifying removal couldn't confirm Castra dropped the session — Brood
    // must NOT mark torndown over an unconfirmed removal (#304).
    const store = new SessionStore({ dbPath: ":memory:" });
    const group = seedSpawnGroup(store);
    const rec = recordingDeps(makeHome());
    rec.deps.pathExists = (p) => p === group.worktreePath;
    rec.deps.removeSteward = async () => ({
      outcome: "failed",
      detail: "castra list failed: Could not reach Castra",
      removedIds: [],
    });

    const result = await teardownSession(store, group.spawnId, { force: true }, rec.deps);

    expect(result.status).toBe("tearing-down");
    expect(result.steps.find((s) => s.step === "steward")?.outcome).toBe("failed");
    expect(result.steps.find((s) => s.step === "worktree")?.detail).toContain("deferred");
    expect(store.get(group.spawnId)?.status).toBe("tearing-down");
    expect(store.get(group.stewardId)?.status).not.toBe("torndown");
    store.close();
  });

  it("marks torndown and passes the worktree match key when the steward is verified absent", async () => {
    // `absent` = Castra confirmed no session for this worktree → safe to reclaim.
    const store = new SessionStore({ dbPath: ":memory:" });
    const group = seedSpawnGroup(store);
    const rec = recordingDeps(makeHome());
    rec.deps.pathExists = (p) => p === group.worktreePath;
    let received: { worktreePath?: string; branch?: string } | undefined;
    rec.deps.removeSteward = async (input) => {
      received = { worktreePath: input.worktreePath, branch: input.branch };
      return { outcome: "absent", removedIds: [] };
    };

    const result = await teardownSession(store, group.spawnId, { force: true }, rec.deps);

    // Teardown handed the spawn's exact worktree/branch as the match key (#304).
    expect(received?.worktreePath).toBe(group.worktreePath);
    expect(received?.branch).toBe(group.branch);
    expect(result.steps.find((s) => s.step === "steward")?.outcome).toBe("skipped");
    expect(result.status).toBe("torndown");
    expect(store.get(group.stewardId)?.status).toBe("torndown");
    store.close();
  });
});

/** Spy on the active tracer so we can inspect the spans teardown creates. */
function captureSpans(): Span[] {
  const tracer = getActiveOtel().getTracer();
  const created: Span[] = [];
  const real = tracer.startSpan.bind(tracer);
  vi.spyOn(tracer, "startSpan").mockImplementation(
    (...args: Parameters<typeof real>) => {
      const span = real(...args) as Span;
      created.push(span);
      return span;
    },
  );
  return created;
}

describe.skipIf(!sqliteAvailable)("teardownSession tracing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    initOtel({});
  });

  it("ends rejected teardown spans with errors under the inbound parent", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const created = captureSpans();
    const store = new SessionStore({ dbPath: ":memory:" });
    const { spawnId, stewardId } = seedSpawnGroup(store);
    store.update(spawnId, { status: "running" });
    const traceId = "12345678901234567890123456789012";
    const spanId = "1234567890123456";
    const { deps } = recordingDeps(makeHome(), { traceparent: `00-${traceId}-${spanId}-01` });
    try {
      await expect(teardownSession(store, "missing", {}, deps)).rejects.toThrow(/No session/);
      await expect(teardownSession(store, stewardId, {}, deps)).rejects.toThrow(/Pass force/);
      await expect(teardownSession(store, spawnId, { kill: true, force: true }, deps))
        .rejects.toThrow(/unsupported/);
      expect(created.map((span) => span.attributes["march.teardown.outcome"]))
        .toEqual(["not-found", "conflict", "unsupported-mode"]);
      for (const span of created) {
        expect(span.name).toBe("brood.teardown");
        expect(span.ended).toBe(true);
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        expect(span.spanContext().traceId).toBe(traceId);
        expect(span.parentSpanContext?.spanId).toBe(spanId);
      }
    } finally {
      store.close();
    }
  });

  it("ends the teardown and archive spans with errors when evidence cannot be saved", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const created = captureSpans();
    const home = makeHome();
    const store = new SessionStore({ dbPath: ":memory:" });
    const { spawnId } = seedSpawnGroup(store);
    fs.mkdirSync(path.join(broodArchiveDir(spawnId, home), "container.log"), { recursive: true });
    try {
      expect((await teardownSession(store, spawnId, {}, recordingDeps(home).deps)).status)
        .toBe("tearing-down");
      for (const name of ["brood.teardown", "brood.teardown.archive"]) {
        const span = created.find((candidate) => candidate.name === name);
        expect(span?.ended, name).toBe(true);
        expect(span?.status.code, name).toBe(SpanStatusCode.ERROR);
      }
    } finally {
      store.close();
    }
  });

  it("child-spans each reclamation sub-step under brood.teardown with an outcome", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const created = captureSpans();
    const store = new SessionStore({ dbPath: ":memory:" });
    const group = seedSpawnGroup(store);
    const rec = recordingDeps(makeHome());
    rec.deps.pathExists = (p) => p === group.worktreePath;

    await teardownSession(store, group.spawnId, { force: true }, rec.deps);

    const parent = created.find((s) => s.name === "brood.teardown");
    expect(parent).toBeDefined();
    const children = created.filter((s) => s.name.startsWith("brood.teardown."));
    const byName = new Map(children.map((c) => [c.name, c]));
    // Each sub-step is a child of the teardown span...
    for (const name of [
      "brood.teardown.container",
      "brood.teardown.steward",
      "brood.teardown.worktree",
      "brood.teardown.branch",
    ]) {
      const child = byName.get(name);
      expect(child, name).toBeDefined();
      expect(child!.parentSpanContext?.spanId).toBe(parent!.spanContext().spanId);
      expect(child!.attributes["march.teardown.outcome"]).toBe("removed");
    }
    expect(byName.get("brood.teardown.worktree")!.attributes["march.worktree.path"]).toBe(
      group.worktreePath,
    );
    store.close();
  });

  it("marks the steward span errored and worktree/branch deferred when steward removal fails", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const created = captureSpans();
    const store = new SessionStore({ dbPath: ":memory:" });
    const group = seedSpawnGroup(store);
    const rec = recordingDeps(makeHome());
    rec.deps.pathExists = (p) => p === group.worktreePath;
    rec.deps.removeSteward = async () => {
      throw new Error("Could not reach Castra");
    };

    await teardownSession(store, group.spawnId, { force: true }, rec.deps);

    const byName = new Map(created.map((c) => [c.name, c]));
    expect(byName.get("brood.teardown.steward")!.attributes["march.teardown.outcome"]).toBe(
      "failed",
    );
    expect(byName.get("brood.teardown.worktree")!.attributes["march.teardown.outcome"]).toBe(
      "deferred",
    );
    expect(byName.get("brood.teardown.branch")!.attributes["march.teardown.outcome"]).toBe(
      "deferred",
    );
    store.close();
  });
});
