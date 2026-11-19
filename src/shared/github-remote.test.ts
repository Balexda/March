import { describe, expect, it } from "vitest";
import { githubRepoFromRemote, sameGitHubRepo } from "./github-remote.js";

describe("githubRepoFromRemote", () => {
  it.each([
    ["git@github.com:Octo/March.git", "Octo/March"],
    ["https://github.com/octo/march", "octo/march"],
    ["https://github.com/octo/march.git/", "octo/march"],
    ["ssh://git@github.com/octo/march.git\n", "octo/march"],
  ])("parses %s", (remote, repo) => expect(githubRepoFromRemote(remote)).toBe(repo));

  it.each(["", "https://gitlab.com/octo/march", "git@github.com:octo/../march", "https://github.com/octo"])(
    "rejects %s",
    remote => expect(githubRepoFromRemote(remote)).toBeNull(),
  );

  it("compares slugs case-insensitively", () => {
    expect(sameGitHubRepo("Octo/March", "octo/march")).toBe(true);
    expect(sameGitHubRepo("octo/march", "fork/march")).toBe(false);
  });
});
