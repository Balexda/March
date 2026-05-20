import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BroodClient } from "../../brood/service/client.js";
import {
  markSpawnRecordRunning,
  markSpawnRecordStopped,
  writeInitialSpawnRecord,
} from "../../brood/spawn-record.js";
import type { HatcherySpawnResult } from "../spawn-handoff.js";
import type { SpawnRequest } from "./types.js";
import { JobStore } from "./jobs.js";
import { registerSpawnWithBrood } from "./brood-registration.js";

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
