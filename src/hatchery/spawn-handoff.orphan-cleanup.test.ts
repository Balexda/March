import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnBackend } from "../spawn/backends.js";

// Issue #211: a spawn that fails AFTER the Castra manager session is launched
// (e.g. `git apply --index` rejects a bad worker patch) used to leave the local
// branch behind — Castra's removeSession prunes the worktree but not the branch
// — so the next re-dispatch of the same slice collided on "branch already
// exists" and stranded the slice operator-only. The rollback now removes the
// orphan branch by exact path.
//
// These tests mock the side-effecting launch/build deps so runHatcherySpawn can
// be driven to a post-launch failure without docker, git, or a real Castra.
// `../brood/worktree.js` is mocked PARTIALLY so the real `generateSpawnId` still
// runs while `removeSpawnWorktree` is a spy we can assert on.

// Hoisted so the vi.mock factories (themselves hoisted to the top of the file)
// can reference these without a "cannot access before initialization" error.
const { removeSpawnWorktreeSpy, removeSessionSpy, launchShouldThrow } =
  vi.hoisted(() => ({
    removeSpawnWorktreeSpy: vi.fn(),
    removeSessionSpy: vi.fn(async () => ({ removed: true })),
    launchShouldThrow: { value: false },
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
      async (req: { title: string; group?: string; branch: string }) => {
        if (launchShouldThrow.value) {
          throw new CastraClientError("launch boom");
        }
        return {
          sessionId: "ad-xyz",
          title: req.title,
          group: req.group ?? "g",
          branch: req.branch,
          worktreePath: "/wt/ad-xyz",
        };
      },
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
    // Fail after the manager launch but before the container exists — the
    // branch already exists at this point, so the rollback must delete it.
    buildSpawnImage: vi.fn(() => {
      throw new BuildError("image build failed");
    }),
    removeSpawnImage: vi.fn(),
  };
});

import {
  orphanManagerBranch,
  runHatcherySpawn,
} from "./spawn-handoff.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-cleanup-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  launchShouldThrow.value = false;
  vi.stubEnv("MARCH_BROOD_URL", ""); // disable launch-time brood registration
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("orphanManagerBranch", () => {
  it("feature-prefixes the bare dispatch branch", () => {
    expect(orphanManagerBranch("smithy/cut/01-spawn-f3-s3")).toBe(
      "feature/smithy/cut/01-spawn-f3-s3",
    );
  });

  it("is idempotent when the branch is already feature-prefixed", () => {
    expect(orphanManagerBranch("feature/smithy/mark/x")).toBe(
      "feature/smithy/mark/x",
    );
  });
});

describe("runHatcherySpawn orphan-branch rollback (#211)", () => {
  it("removes the orphan worktree+branch by exact path on a post-launch failure", async () => {
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

    // Steward removed (worktree pruned by Castra) AND the orphan branch deleted
    // by the exact-path rollback helper.
    expect(removeSessionSpy).toHaveBeenCalledTimes(1);
    expect(removeSpawnWorktreeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpawnWorktreeSpy).toHaveBeenCalledWith("/repo", {
      spawnId: expect.stringMatching(/^\d{8}-[0-9a-f]{6}$/),
      branch: "feature/smithy/cut/01-spawn-f3-s3",
      worktreePath: "/wt/ad-xyz",
    });
  });

  it("does not attempt branch rollback when the manager launch itself fails", async () => {
    const home = makeHome();
    launchShouldThrow.value = true;

    await expect(
      runHatcherySpawn({
        repoPath: "/repo",
        prompt: "do the thing",
        backend,
        agentDeckProfile: "march",
        branch: "smithy/cut/01-spawn-f3-s3",
        homeDir: home,
      }),
    ).rejects.toThrow(/Castra session launch failed/);

    // No manager session was created, so there is no orphan branch to remove.
    expect(removeSpawnWorktreeSpy).not.toHaveBeenCalled();
  });
});
