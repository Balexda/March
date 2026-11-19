/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { gitHubAuthConfigArgs, redactGitCredentials } from "./git-auth.js";

describe("redactGitCredentials", () => {
  it("masks the token in a failed git command line built from gitHubAuthConfigArgs", () => {
    const args = gitHubAuthConfigArgs({ GH_TOKEN: "ghp_SECRET123" });
    const message =
      `Command failed: git ${args.join(" ")} fetch origin main\n` +
      "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com";
    const redacted = redactGitCredentials(message);
    expect(redacted).not.toContain("ghp_SECRET123");
    expect(redacted).toContain("https://x-access-token:***@github.com/");
    // The diagnostic part survives.
    expect(redacted).toContain("Could not resolve host: github.com");
  });

  it("leaves credential-free text unchanged", () => {
    const text = "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host";
    expect(redactGitCredentials(text)).toBe(text);
  });
});
