import { describe, expect, it, vi } from "vitest";
import {
  buildRepoInfoArgs,
  createGhForgeAdapter,
  parseRepoInfoGhJson,
  type StatioCommandRunner,
} from "./adapter.js";
import { StatioForgeError } from "./types.js";

function runnerReturning(stdout: string): StatioCommandRunner {
  return vi.fn(async () => stdout);
}

describe("statio gh forge adapter — repoInfo", () => {
  it("builds a single gh repo view read for owner and default branch", () => {
    expect(buildRepoInfoArgs()).toEqual([
      "repo",
      "view",
      "--json",
      "nameWithOwner,defaultBranchRef",
    ]);
  });

  it("returns owner and default branch from the same gh repo view result", async () => {
    const runCommand = runnerReturning(
      JSON.stringify({
        nameWithOwner: "Balexda/March",
        defaultBranchRef: { name: "main" },
      }),
    );
    const adapter = createGhForgeAdapter({
      cwd: "/repo",
      timeoutMs: 1234,
      runCommand,
    });

    await expect(adapter.repoInfo()).resolves.toEqual({
      owner: "Balexda/March",
      defaultBranch: "main",
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith("gh", buildRepoInfoArgs(), {
      cwd: "/repo",
      timeoutMs: 1234,
    });
  });

  it("wraps malformed gh output as forge_error", async () => {
    const adapter = createGhForgeAdapter({
      runCommand: runnerReturning(
        JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: {},
        }),
      ),
    });

    await expect(adapter.repoInfo()).rejects.toMatchObject({
      name: "StatioForgeError",
      code: "forge_error",
    });
  });

  it("wraps gh failures as forge_error without leaking dependency details", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async () => {
      throw new Error("gh auth token secret failed");
    });
    const adapter = createGhForgeAdapter({ runCommand });

    await expect(adapter.repoInfo()).rejects.toMatchObject({
      name: "StatioForgeError",
      code: "forge_error",
      message: "gh repo view failed while resolving repository metadata.",
    });
  });

  it("parses only the expected repo metadata shape", () => {
    expect(() => parseRepoInfoGhJson("not-json")).toThrow(StatioForgeError);
    expect(() => parseRepoInfoGhJson("[]")).toThrow(StatioForgeError);
    expect(() =>
      parseRepoInfoGhJson(JSON.stringify({ nameWithOwner: "", defaultBranchRef: { name: "main" } })),
    ).toThrow(StatioForgeError);
  });
});
