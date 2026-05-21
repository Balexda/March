import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BroodClient } from "../../brood/service/client.js";
import { SessionStore } from "../../brood/service/store.js";
import { sqliteAvailable } from "../../brood/service/sqlite.js";
import {
  markSpawnRecordRunning,
  markSpawnRecordStopped,
  writeInitialSpawnRecord,
} from "../../brood/spawn-record.js";
import type { HatcherySpawnResult } from "../spawn-handoff.js";
import type { SpawnRequest } from "./types.js";
import { JobStore } from "./jobs.js";
import {
  registerSpawnWithBrood,
  registerStewardLaunchWithBrood,
} from "./brood-registration.js";

const tmpDirs: string[] = [];

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brood-reg-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function fakeResult(spawnId: string): HatcherySpawnResult {
  return {
    spawnId,
    backend: "codex",
    branch: `march/spawn/${spawnId}`,
    managerSession: {
      sessionId: "ad-session-1",
      worktreePath: `/wt/${spawnId}`,
    },
    artifacts: {},
    exitCode: 0,
    summary: "ok",
  } as unknown as HatcherySpawnResult;
}

const request: SpawnRequest = {
  prompt: "do it",
  backend: "codex",
  repoPath: "/repo",
  agentDeckProfile: "march",
  managerGroup: "march-spawn-managers",
};

/** A BroodClient backed by a fetch stub that captures registered bodies. */
function capturingClient(bodies: Record<string, unknown>[]): BroodClient {
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    return new Response(JSON.stringify(body), { status: 201 });
  }) as unknown as typeof fetch;
  return new BroodClient({ baseUrl: "http://brood", fetchImpl });
}

/** A BroodClient whose POST /sessions delegates to a real (in-memory) store, so
 *  tests can assert the store's idempotent upsert end-to-end through the client. */
function storeBackedClient(store: SessionStore): BroodClient {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { pathname } = new URL(url);
    if (init.method === "POST" && pathname === "/sessions") {
      const record = store.register(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(record), { status: 201 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return new BroodClient({ baseUrl: "http://brood", fetchImpl });
}

describe("registerSpawnWithBrood", () => {
  it("registers spawn + steward rows, reading container/status from the record", async () => {
    const home = makeHome();
    const spawnId = "20260520-reg111";
    writeInitialSpawnRecord(
      { id: spawnId, repoPath: "/repo", branch: `march/spawn/${spawnId}`, worktreePath: `/wt/${spawnId}` },
      home,
    );
    markSpawnRecordRunning(spawnId, "container-xyz", home);
    markSpawnRecordStopped(spawnId, 0, home);

    const bodies: Record<string, unknown>[] = [];
    await registerSpawnWithBrood(fakeResult(spawnId), request, {
      client: capturingClient(bodies),
      homeDir: home,
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      id: spawnId,
      kind: "spawn",
      status: "stopped",
      containerId: "container-xyz",
      branch: `march/spawn/${spawnId}`,
      worktreePath: `/wt/${spawnId}`,
      repoPath: "/repo",
    });
    expect(bodies[1]).toMatchObject({
      id: "ad-session-1",
      kind: "steward",
      parentId: spawnId,
      agentDeckSessionId: "ad-session-1",
      profile: "march",
      group: "march-spawn-managers",
    });
  });

  it("is a no-op when brood is unconfigured (no client, no MARCH_BROOD_URL)", async () => {
    await expect(
      registerSpawnWithBrood(fakeResult("s2"), request, { env: {} }),
    ).resolves.toBeUndefined();
  });

  it("swallows a brood failure with a warning (never throws)", async () => {
    const warn = vi.fn();
    const failingClient = new BroodClient({
      baseUrl: "http://brood",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(
      registerSpawnWithBrood(fakeResult("s3"), request, {
        client: failingClient,
        warn,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("registerStewardLaunchWithBrood", () => {
  const launchInput = {
    spawnId: "20260520-lnch01",
    stewardSessionId: "ad-launch-1",
    repoPath: "/repo",
    branch: "march/spawn/20260520-lnch01",
    worktreePath: "/wt/20260520-lnch01",
    backend: "codex",
    profile: "march",
    group: "march-spawn-managers",
  };

  it("registers a created spawn row + running steward row from launch facts", async () => {
    const bodies: Record<string, unknown>[] = [];
    await registerStewardLaunchWithBrood(launchInput, {
      client: capturingClient(bodies),
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      id: launchInput.spawnId,
      kind: "spawn",
      status: "created",
      repoPath: "/repo",
      branch: launchInput.branch,
      worktreePath: launchInput.worktreePath,
      backend: "codex",
    });
    // The spawn container does not exist yet at launch time.
    expect(bodies[0].containerId).toBeUndefined();
    expect(bodies[1]).toMatchObject({
      id: "ad-launch-1",
      kind: "steward",
      parentId: launchInput.spawnId,
      agentDeckSessionId: "ad-launch-1",
      profile: "march",
      group: "march-spawn-managers",
      status: "running",
      repoPath: "/repo",
      branch: launchInput.branch,
      worktreePath: launchInput.worktreePath,
    });
  });

  it("is a no-op when brood is unconfigured (no client, no MARCH_BROOD_URL)", async () => {
    await expect(
      registerStewardLaunchWithBrood(launchInput, { env: {} }),
    ).resolves.toBeUndefined();
  });

  it("swallows a brood failure with a warning (never throws)", async () => {
    const warn = vi.fn();
    const failingClient = new BroodClient({
      baseUrl: "http://brood",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(
      registerStewardLaunchWithBrood(launchInput, {
        client: failingClient,
        warn,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!sqliteAvailable)("launch + success registration idempotency", () => {
  it("coalesces into one spawn row and one steward row without clobbering", async () => {
    const home = makeHome();
    const spawnId = "20260520-idem01";
    const branch = `march/spawn/${spawnId}`;
    const worktreePath = `/wt/${spawnId}`;
    const store = new SessionStore({ dbPath: ":memory:" });
    const client = storeBackedClient(store);

    // 1. Launch-time registration — before the spawn container exists. The
    //    steward id must match the success-path result's managerSession id
    //    ("ad-session-1") so the two registrations target the SAME rows.
    await registerStewardLaunchWithBrood(
      {
        spawnId,
        stewardSessionId: "ad-session-1",
        repoPath: "/repo",
        branch,
        worktreePath,
        backend: "codex",
        profile: "march",
        group: "march-spawn-managers",
      },
      { client },
    );

    const launched = store.get(spawnId);
    expect(launched?.status).toBe("created");
    expect(launched?.containerId).toBeUndefined();
    const createdAt = launched?.createdAt;
    expect(store.list({ kind: "spawn" })).toHaveLength(1);
    expect(store.list({ kind: "steward" })).toHaveLength(1);

    // 2. Success-time enrich reads the finished SpawnRecord from disk.
    writeInitialSpawnRecord(
      { id: spawnId, repoPath: "/repo", branch, worktreePath },
      home,
    );
    markSpawnRecordRunning(spawnId, "container-xyz", home);
    markSpawnRecordStopped(spawnId, 0, home);
    await registerSpawnWithBrood(fakeResult(spawnId), request, {
      client,
      homeDir: home,
    });

    // Still one spawn + one steward — enriched, nothing duplicated or clobbered.
    expect(store.list({ kind: "spawn" })).toHaveLength(1);
    expect(store.list({ kind: "steward" })).toHaveLength(1);
    const enriched = store.get(spawnId);
    expect(enriched?.status).toBe("stopped");
    expect(enriched?.containerId).toBe("container-xyz");
    expect(enriched?.branch).toBe(branch);
    expect(enriched?.worktreePath).toBe(worktreePath);
    expect(enriched?.createdAt).toBe(createdAt); // survives the upsert
    expect(store.get("ad-session-1")?.status).toBe("running");
    store.close();
  });
});

describe("JobStore onSucceeded hook", () => {
  it("invokes onSucceeded after a successful job", async () => {
    const onSucceeded = vi.fn();
    const store = new JobStore({
      executor: async () => fakeResult("s4"),
      onSucceeded,
    });
    const job = store.create(request);
    await vi.waitFor(() => expect(store.get(job.id)?.status).toBe("succeeded"));
    expect(onSucceeded).toHaveBeenCalledOnce();
  });

  it("swallows an onSucceeded failure (job stays succeeded)", async () => {
    const store = new JobStore({
      executor: async () => fakeResult("s5"),
      onSucceeded: async () => {
        throw new Error("brood down");
      },
      logger: { info() {}, error() {} },
    });
    const job = store.create(request);
    await vi.waitFor(() => expect(store.get(job.id)?.status).toBe("succeeded"));
  });
});
