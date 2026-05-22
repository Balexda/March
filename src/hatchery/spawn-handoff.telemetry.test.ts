import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnBackend } from "../spawn/backends.js";

// Phase 1 of the spawn-failure observability work: the dispatch OUTCOME and the
// `failure_stage` label must reflect the real handoff result, not the container
// exit code. A spawn whose container exits 0 but whose `git apply` then fails is
// a FAILED spawn at stage `patch_apply` (issue #211) — it used to be recorded as
// a success because the metric keyed off the exit code alone.
//
// These tests drive runHatcherySpawn to a chosen failure stage with mocked
// seams and assert what `recordSpawnRun` receives.

const {
  recordSpawnRunSpy,
  removeSpawnWorktreeSpy,
  removeSessionSpy,
  buildShouldThrow,
  worktreePath,
} = vi.hoisted(() => ({
  recordSpawnRunSpy: vi.fn(),
  removeSpawnWorktreeSpy: vi.fn(),
  removeSessionSpy: vi.fn(async () => ({ removed: true })),
  buildShouldThrow: { value: false },
  worktreePath: { value: "/wt/ad-xyz" },
}));

vi.mock("../observability/spawn-metrics.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../observability/spawn-metrics.js")>();
  return { ...actual, recordSpawnRun: recordSpawnRunSpy };
});

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
        sessionId: "ad-xyz",
        title: req.title,
        group: req.group ?? "g",
        branch: req.branch,
        worktreePath: worktreePath.value,
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
    cleanup: vi.fn(),
  }));
  return { SnapshotError, createBuildContext };
});

vi.mock("../spawn/snapshot-build.js", () => {
  class BuildError extends Error {}
  return {
    BuildError,
    writeSpawnDockerfile: vi.fn(() => "/ctx/Dockerfile"),
    buildSpawnImage: vi.fn(() => {
      if (buildShouldThrow.value) throw new BuildError("image build failed");
      return "march-spawn-img:latest";
    }),
    removeSpawnImage: vi.fn(),
  };
});

vi.mock("../spawn/container-launch.js", () => {
  class LaunchError extends Error {}
  return {
    LaunchError,
    createSpawnContainer: vi.fn(() => "container-id"),
    copyPromptToContainer: vi.fn(),
    copyOtelEmitterToContainer: vi.fn(),
    startSpawnContainer: vi.fn(),
    waitForSpawnContainer: vi.fn(() => ({ exitCode: 0 })),
    // A valid unified diff so patch extraction succeeds and we reach git apply.
    readSpawnContainerLogs: vi.fn(
      () => "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n",
    ),
    removeSpawnContainer: vi.fn(),
  };
});

import { runHatcherySpawn } from "./spawn-handoff.js";

const backend: SpawnBackend = {
  name: "codex",
  baseImage: "march-spawn-codex:latest",
  requiredEnvVars: [],
  credentialMounts: [],
  buildEntrypoint: () => ["sh", "-c", "true"],
};

const tmpDirs: string[] = [];
function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-telemetry-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  buildShouldThrow.value = false;
  worktreePath.value = "/wt/ad-xyz";
  vi.stubEnv("MARCH_BROOD_URL", ""); // disable launch-time brood registration
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("runHatcherySpawn outcome + failure_stage telemetry", () => {
  it("records failure at stage image_build when the image build fails", async () => {
    buildShouldThrow.value = true;
    const home = makeHome();

    await expect(
      runHatcherySpawn({
        repoPath: "/repo",
        prompt: "do the thing",
        backend,
        agentDeckProfile: "march",
        branch: "smithy/cut/01-spawn-f3-s3",
        homeDir: home,
      }),
    ).rejects.toThrow(/image build failed/);

    expect(recordSpawnRunSpy).toHaveBeenCalledTimes(1);
    expect(recordSpawnRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failure", failureStage: "image_build" }),
    );
  });

  it("records failure at stage patch_apply when the container exits 0 but git apply fails (#211)", async () => {
    // Point the manager worktree at a path that does not exist so the real
    // applyPatchToManagerWorktree throws — the post-container failure that used
    // to be mislabeled a success.
    worktreePath.value = path.join(os.tmpdir(), "does-not-exist-" + Date.now());
    const home = makeHome();

    await expect(
      runHatcherySpawn({
        repoPath: "/repo",
        prompt: "do the thing",
        backend,
        agentDeckProfile: "march",
        branch: "smithy/cut/01-spawn-f3-s3",
        homeDir: home,
      }),
    ).rejects.toThrow(/manager worktree not found/);

    // Outcome is failure even though the container exited 0.
    expect(recordSpawnRunSpy).toHaveBeenCalledTimes(1);
    expect(recordSpawnRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failure", failureStage: "patch_apply" }),
    );
    // And the rollback removed the orphan branch (issue #211 cleanup).
    expect(removeSpawnWorktreeSpy).toHaveBeenCalledWith("/repo", {
      spawnId: expect.stringMatching(/^\d{8}-[0-9a-f]{6}$/),
      branch: "feature/smithy/cut/01-spawn-f3-s3",
      worktreePath: worktreePath.value,
    });
  });
});
