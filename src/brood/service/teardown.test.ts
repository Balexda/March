/**
 * @l1 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { getActiveOtel, initOtel } from "../../observability/otel.js";
import { sqliteAvailable } from "./sqlite.js";
import { broodArchiveDir, SessionStore } from "./store.js";
import {
  BroodConflictError,
  BroodNotFoundError,
  teardownSession,
  type TeardownDeps,
} from "./teardown.js";
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
    removeSpawn: (spawnId) => {
      calls.push(`container:${spawnId}`);
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
      removeSpawn: () => {
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
    expect(result.status).toBe("torndown");
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
