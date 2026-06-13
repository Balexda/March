/**
 * @l1 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnBackend } from "../spawn/backends.js";

// Mock the side-effecting build/launch dependencies so we can exercise
// runHatcherySpawn end-to-end without docker, git, or a real Castra. The Brood
// client is NOT mocked — it talks to a stubbed global fetch — so this proves the
// real launch-time registration path fires (#172).

vi.mock("../castra/client.js", () => {
  class CastraClientError extends Error {}
  class CastraClient {}
  const createCastraClientFromEnv = () => ({
    launchSession: vi.fn(async (req: { title: string; group?: string; branch: string }) => ({
      sessionId: "ad-xyz",
      title: req.title,
      group: req.group ?? "g",
      branch: req.branch,
      worktreePath: "/wt/ad-xyz",
    })),
    removeSession: vi.fn(async () => ({ removed: true })),
    sendPrompt: vi.fn(async () => {}),
  });
  return { CastraClient, CastraClientError, createCastraClientFromEnv };
});

vi.mock("../spawn/snapshot.js", () => {
  class SnapshotError extends Error {}
  const createBuildContext = vi.fn(() => ({
    contextPath: "/ctx",
    cleanup: vi.fn(),
  }));
  return { SnapshotError, createBuildContext };
});

vi.mock("../spawn/snapshot-build.js", () => {
  class BuildError extends Error {}
  return {
    BuildError,
    writeSpawnDockerfile: vi.fn(() => "/ctx/Dockerfile"),
    // Fail right after launch-time registration, before the container exists —
    // the exact mid-launch window that used to strand an unregistered steward.
    buildSpawnImage: vi.fn(() => {
      throw new BuildError("image build failed");
    }),
    removeSpawnImage: vi.fn(),
  };
});

import { runHatcherySpawn } from "./spawn-handoff.js";

const backend: SpawnBackend = {
  name: "codex",
  baseImage: "march-spawn-codex:latest",
  requiredEnvVars: [],
  credentialMounts: [],
  buildEntrypoint: () => ["sh", "-c", "true"],
  allowedEgressHosts: ["chatgpt.com"],
};

const tmpDirs: string[] = [];
function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brood-launch-"));
  tmpDirs.push(dir);
  return dir;
}

let broodBodies: Array<Record<string, unknown>>;

beforeEach(() => {
  broodBodies = [];
  vi.stubEnv("MARCH_BROOD_URL", "http://brood");
  vi.stubGlobal("fetch", (async (url: string, init: RequestInit) => {
    if (String(url).includes("/sessions")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      broodBodies.push(body);
      return new Response(JSON.stringify(body), { status: 201 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("runHatcherySpawn launch-time brood registration (#172)", () => {
  it("registers the steward with brood at launch, before a build failure", async () => {
    const home = makeHome();

    await expect(
      runHatcherySpawn({
        repoPath: "/repo",
        prompt: "do the thing",
        backend,
        agentDeckProfile: "march",
        homeDir: home,
      }),
    ).rejects.toThrow(/image build failed/);

    const spawnRow = broodBodies.find((b) => b.kind === "spawn");
    const stewardRow = broodBodies.find((b) => b.kind === "steward");

    expect(spawnRow).toMatchObject({
      kind: "spawn",
      status: "created",
      repoPath: "/repo",
      worktreePath: "/wt/ad-xyz",
      backend: "codex",
    });
    // No container yet — the failure happened before it was created.
    expect(spawnRow?.containerId).toBeUndefined();
    expect(String(spawnRow?.branch)).toMatch(/^march\/spawn\//);

    expect(stewardRow).toMatchObject({
      kind: "steward",
      parentId: spawnRow?.id,
      agentDeckSessionId: "ad-xyz",
      profile: "march",
      status: "running",
      repoPath: "/repo",
      worktreePath: "/wt/ad-xyz",
    });
  });

  it("does not register at launch when brood is unconfigured", async () => {
    const home = makeHome();
    vi.stubEnv("MARCH_BROOD_URL", "");

    await expect(
      runHatcherySpawn({
        repoPath: "/repo",
        prompt: "do the thing",
        backend,
        agentDeckProfile: "march",
        homeDir: home,
      }),
    ).rejects.toThrow(/image build failed/);

    expect(broodBodies).toHaveLength(0);
  });
});
