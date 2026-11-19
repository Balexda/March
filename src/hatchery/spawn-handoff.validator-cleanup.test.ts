/**
 * @l1 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnBackend } from "../spawn/backends.js";
import { loadSpawnRecord } from "../brood/spawn-record.js";

const {
  cleanupSpy,
  copyPromptToContainerSpy,
  createSpawnContainerSpy,
  removeSessionSpy,
  removeSpawnContainerSpy,
  removeSpawnImageSpy,
  removeSpawnWorktreeSpy,
  startSpawnContainerSpy,
} = vi.hoisted(() => ({
  cleanupSpy: vi.fn(),
  copyPromptToContainerSpy: vi.fn(),
  createSpawnContainerSpy: vi.fn(),
  removeSessionSpy: vi.fn(async () => ({ removed: true })),
  removeSpawnContainerSpy: vi.fn(),
  removeSpawnImageSpy: vi.fn(),
  removeSpawnWorktreeSpy: vi.fn(),
  startSpawnContainerSpy: vi.fn(),
}));

vi.mock("../brood/worktree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../brood/worktree.js")>();
  return { ...actual, removeSpawnWorktree: removeSpawnWorktreeSpy };
});

vi.mock("../castra/client.js", () => {
  class CastraClientError extends Error {}
  class CastraClient {}
  const createCastraClientFromEnv = () => ({
    launchSession: vi.fn(
      async (req: { title: string; group?: string; branch: string }) => ({
        sessionId: "manager-session",
        title: req.title,
        group: req.group ?? "workers",
        branch: req.branch,
        worktreePath: "/worktrees/manager-session",
      }),
    ),
    removeSession: removeSessionSpy,
    sendPrompt: vi.fn(async () => {}),
  });
  return { CastraClient, CastraClientError, createCastraClientFromEnv };
});

vi.mock("../spawn/snapshot.js", () => {
  class SnapshotError extends Error {}
  const createBuildContext = vi.fn(() => ({
    contextPath: "/ctx",
    cleanup: cleanupSpy,
  }));
  return { SnapshotError, createBuildContext };
});

vi.mock("../spawn/snapshot-build.js", () => {
  class BuildError extends Error {}
  return {
    BuildError,
    writeSpawnDockerfile: vi.fn(() => "/ctx/Dockerfile"),
    buildSpawnImage: vi.fn(() => "march-spawn-test-id"),
    removeSpawnImage: removeSpawnImageSpy,
  };
});

vi.mock("../spawn/container-launch.js", () => {
  class LaunchError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "LaunchError";
    }
  }
  return {
    LaunchError,
    createSpawnContainer: createSpawnContainerSpy,
    copyOtelEmitterToContainer: vi.fn(),
    copyPromptToContainer: copyPromptToContainerSpy,
    readSpawnContainerLogs: vi.fn(() => ""),
    removeSpawnContainer: removeSpawnContainerSpy,
    startSpawnContainer: startSpawnContainerSpy,
    waitForSpawnContainer: vi.fn(() => ({ exitCode: 0 })),
  };
});

import { LaunchError } from "../spawn/container-launch.js";
import { orphanManagerBranch, runHatcherySpawn } from "./spawn-handoff.js";

const backend: SpawnBackend = {
  name: "claude-code",
  baseImage: "march-spawn-claude:latest",
  requiredEnvVars: [],
  credentialMounts: [],
  buildEntrypoint: () => ["sh", "-c", "true"],
  allowedEgressHosts: ["api.anthropic.com"],
};

const tmpDirs: string[] = [];

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validator-cleanup-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv("MARCH_BROOD_URL", "");
  vi.stubEnv("MARCH_HERALD_URL", "");
  // #460 parking KEEPS the image/worktree instead of rolling them back. This
  // slice asserts the destructive reverse-order path, so the gate is pinned off
  // rather than inherited from the ambient operator environment.
  vi.stubEnv("MARCH_HATCHERY_PARK_FAILED", "");
  createSpawnContainerSpy.mockImplementation(() => {
    throw new LaunchError(
      'docker create rejected undeclared bind mount "-v /host/oauth:/march/oauth:ro" ' +
        'for backend "claude-code". Only backend-declared credential mounts are permitted. ' +
        "Declared credential mounts: none.",
    );
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("runHatcherySpawn validator cleanup", () => {
  it("routes bind-mount validator rejection through launch rollback before container creation", async () => {
    const home = makeHome();
    const branch = "smithy/cut/05-us5-s3";

    await expect(
      runHatcherySpawn({
        repoPath: "/repo",
        prompt: "do the thing",
        backend,
        agentDeckProfile: "march",
        branch,
        homeDir: home,
      }),
    ).rejects.toThrow(/undeclared bind mount/);

    expect(createSpawnContainerSpy).toHaveBeenCalledTimes(1);
    expect(copyPromptToContainerSpy).not.toHaveBeenCalled();
    expect(startSpawnContainerSpy).not.toHaveBeenCalled();
    expect(removeSpawnContainerSpy).not.toHaveBeenCalled();

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(removeSpawnImageSpy).toHaveBeenCalledTimes(1);
    const spawnId = (removeSpawnImageSpy.mock.calls[0] as unknown as [string])[0];
    expect(spawnId).toMatch(/^\d{8}-[0-9a-f]{6}$/);

    expect(removeSessionSpy).toHaveBeenCalledTimes(1);
    const removeSessionInput = (removeSessionSpy.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ])[0];
    expect(removeSessionInput).toMatchObject({
      sessionId: "manager-session",
      profile: "march",
    });
    expect(removeSpawnWorktreeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpawnWorktreeSpy).toHaveBeenCalledWith("/repo", {
      spawnId,
      branch: orphanManagerBranch(branch),
      worktreePath: "/worktrees/manager-session",
    });

    const record = loadSpawnRecord(spawnId, home);
    expect(record).toMatchObject({
      id: spawnId,
      status: "failed",
      backend: "claude-code",
      branch,
      imageId: "march-spawn-test-id",
      failureReason: expect.stringContaining("undeclared bind mount"),
    });
    expect(record?.containerId).toBeUndefined();
    expect(record?.startedAt).toBeUndefined();
  });
});
