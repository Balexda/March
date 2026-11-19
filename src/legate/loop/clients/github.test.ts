/** @l0 @deterministic @ci */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGitHubToken } from "../../../tessera/client.js";
import { resolveOriginRepo } from "../../../shared/github-remote.js";
import { execText } from "./exec.js";
import { requestCopilotReview } from "./github.js";

vi.mock("../../../tessera/client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../tessera/client.js")>(),
  getGitHubToken: vi.fn(),
}));
vi.mock("../../../shared/github-remote.js", () => ({ resolveOriginRepo: vi.fn() }));
vi.mock("./exec.js", () => ({ execText: vi.fn() }));

describe("the Copilot GitHub adapter", () => {
  const token = "test-user-token";
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveOriginRepo).mockResolvedValue("owner/repo");
    vi.mocked(getGitHubToken).mockResolvedValue({
      token, identity: "operator", expiresAt: null, commitIdentity: null, source: "tessera",
    });
    vi.mocked(execText).mockResolvedValue("");
  });

  it("uses a slice-scoped Tessera user token only in the bounded reviewer call", async () => {
    expect(await requestCopilotReview("/repo", 42, "s")).toEqual({ ok: true });
    expect(getGitHubToken).toHaveBeenCalledExactlyOnceWith({ identity: "user", access: "write", sliceId: "s" });
    expect(execText).toHaveBeenCalledExactlyOnceWith("gh", [
      "api", "--include", "--method", "POST", "repos/owner/repo/pulls/42/requested_reviewers",
      "-f", "reviewers[]=copilot-pull-request-reviewer[bot]",
    ], expect.objectContaining({
      cwd: "/repo", timeout: 30_000, killSignal: "SIGKILL",
      env: expect.objectContaining({ GH_TOKEN: token, GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" }),
    }));
    expect(vi.mocked(execText).mock.calls[0][2]?.env).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("does not post or acquire substitute credentials after identity refusal", async () => {
    vi.mocked(getGitHubToken).mockRejectedValueOnce(new Error(token));
    const outcome = await requestCopilotReview("/repo", 42, "s");
    expect(outcome).toMatchObject({ ok: false, kind: "identity_unavailable" });
    expect(JSON.stringify(outcome)).not.toContain(token);
    expect(getGitHubToken).toHaveBeenCalledTimes(1);
    expect(execText).not.toHaveBeenCalled();
  });

  it("returns the rate-limit reset without disclosing command output", async () => {
    vi.mocked(execText).mockRejectedValueOnce(Object.assign(new Error(token), {
      stderr: "gh: rate limit exceeded (HTTP 429)",
      stdout: "HTTP/2.0 429 Too Many Requests\r\nRetry-After: Sun, 17 Jan 2027 01:00:00 GMT\r\n\r\n" + token,
    }));
    expect(await requestCopilotReview("/repo", 42, "s")).toEqual({
      ok: false, kind: "rate_limited", resetAt: "2027-01-17T01:00:00.000Z",
    });
  });
});
