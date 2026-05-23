import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnBackend } from "../spawn/backends.js";
import type { BranchSafetyVerdict } from "./orphan-branch.js";

// Issue #243: when `manager.launch` fails because the dispatch branch already
// exists, `manager` is undefined, so the standard rollback's `mgr && !handedOff`
// branch never runs and the colliding branch leaks forever (self-perpetuating
// wedge). The self-heal resolves the real orphan ref, classifies it, and removes
// it by EXACT path when safe — or escalates with the verdict when unsafe.
//
// These tests drive runHatcherySpawn to a manager.launch "branch already exists"
// failure with the classifier + worktree-finder mocked so each verdict branch is
// exercised deterministically, and assert what the exact-path rollback helper
// receives.

const { removeSpawnWorktreeSpy, classifyVerdict, worktreeForBranch } = vi.hoisted(
  () => ({
    removeSpawnWorktreeSpy: vi.fn(),
    classifyVerdict: { value: { kind: "safe", reason: "orphan-ref" } as BranchSafetyVerdict },
    worktreeForBranch: { value: "/wt/orphan" as string | undefined },
  }),
);

vi.mock("../brood/worktree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../brood/worktree.js")>();
  return { ...actual, removeSpawnWorktree: removeSpawnWorktreeSpy };
});

vi.mock("./orphan-branch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./orphan-branch.js")>();
  return {
    ...actual,
    classifyBranchSafety: vi.fn(() => classifyVerdict.value),
    findWorktreePathForBranch: vi.fn(() => worktreeForBranch.value),
  };
});

vi.mock("../castra/client.js", () => {
  class CastraClientError extends Error {}
  class CastraClient {}
  const createCastraClientFromEnv = vi.fn(() => ({
    launchSession: vi.fn(async () => {
      throw new CastraClientError(
        "agent-deck launch failed: Error: branch 'feature/smithy/mark/m1-f6' already exists (remove -b flag to use the existing branch)",
      );
    }),
    removeSession: vi.fn(async () => ({ removed: true })),
    sendPrompt: vi.fn(async () => {}),
  }));
  return { CastraClient, CastraClientError, createCastraClientFromEnv };
});

vi.mock("../spawn/snapshot-build.js", () => {
  class BuildError extends Error {}
  return {
    BuildError,
    writeSpawnDockerfile: vi.fn(() => "/ctx/Dockerfile"),
    buildSpawnImage: vi.fn(() => "img"),
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "self-heal-"));
  tmpDirs.push(dir);
  return dir;
}

function run(home: string) {
  return runHatcherySpawn({
    repoPath: "/repo",
    prompt: "do the thing",
    backend,
    agentDeckProfile: "march",
    branch: "smithy/mark/m1-f6",
    homeDir: home,
  });
}

beforeEach(() => {
  classifyVerdict.value = { kind: "safe", reason: "orphan-ref" };
  worktreeForBranch.value = "/wt/orphan";
  vi.stubEnv("MARCH_BROOD_URL", "");
  vi.stubEnv("MARCH_HERALD_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("runHatcherySpawn manager.launch orphan-branch self-heal (#243)", () => {
  it("removes a SAFE orphan branch by exact path so the next dispatch succeeds", async () => {
    const home = makeHome();

    await expect(run(home)).rejects.toThrow(/already exists/);

    // The orphan branch (feature-prefixed) + its worktree are removed by the
    // exact-path helper — never a blanket prune (#155).
    expect(removeSpawnWorktreeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpawnWorktreeSpy).toHaveBeenCalledWith("/repo", {
      spawnId: expect.stringMatching(/^\d{8}-[0-9a-f]{6}$/),
      branch: "feature/smithy/mark/m1-f6",
      worktreePath: "/wt/orphan",
    });
  });

  it("deletes only the branch when no worktree holds it", async () => {
    worktreeForBranch.value = undefined;
    const home = makeHome();

    await expect(run(home)).rejects.toThrow(/already exists/);

    expect(removeSpawnWorktreeSpy).toHaveBeenCalledWith("/repo", {
      spawnId: expect.any(String),
      branch: "feature/smithy/mark/m1-f6",
      worktreePath: "",
    });
  });

  it("does NOT delete an UNSAFE branch (open PR) and escalates with the verdict", async () => {
    classifyVerdict.value = { kind: "unsafe", reason: "open-pr", detail: "#7" };
    const home = makeHome();

    await expect(run(home)).rejects.toThrow(/NOT auto-removed.*open-pr.*#7/s);
    expect(removeSpawnWorktreeSpy).not.toHaveBeenCalled();
  });

  it("does NOT delete a diverged branch and escalates", async () => {
    classifyVerdict.value = { kind: "unsafe", reason: "diverged" };
    const home = makeHome();

    await expect(run(home)).rejects.toThrow(/NOT auto-removed.*diverged/s);
    expect(removeSpawnWorktreeSpy).not.toHaveBeenCalled();
  });

  it("re-throws the original error (no escalation) when the branch is already gone", async () => {
    classifyVerdict.value = { kind: "absent" };
    const home = makeHome();

    const err = await run(home).then(
      () => {
        throw new Error("expected runHatcherySpawn to reject");
      },
      (e: Error) => e,
    );
    expect(err.message).toMatch(/already exists/);
    expect(err.message).not.toMatch(/NOT auto-removed/);
    expect(removeSpawnWorktreeSpy).not.toHaveBeenCalled();
  });

  it("does not self-heal a non-collision launch failure", async () => {
    // A launch failure whose message is not "branch already exists" must fall
    // through untouched — no orphan-branch surgery.
    const home = makeHome();
    const { createCastraClientFromEnv } = await import("../castra/client.js");
    vi.mocked(createCastraClientFromEnv).mockReturnValueOnce({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      launchSession: vi.fn(async () => {
        throw new Error("network down");
      }),
      removeSession: vi.fn(async () => ({ removed: true })),
      sendPrompt: vi.fn(async () => {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await expect(run(home)).rejects.toThrow(/network down/);
    expect(removeSpawnWorktreeSpy).not.toHaveBeenCalled();
  });
});
