/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { TesseraClient, TesseraClientError } from "../tessera/client.js";
import { createGitHubRead } from "./github-read.js";

describe("createGitHubRead before a Herald client key is provisioned", () => {
  const parentEnv = { HOME: "/home/op", GH_TOKEN: "ambient-token", GH_CONFIG_DIR: "/home/op/.config/gh" };

  it("uses the explicit migration fallback for the scoped child call", async () => {
    const client = new TesseraClient({
      env: { ...parentEnv, MARCH_TESSERA_URL: "http://tessera:9477", MARCH_TESSERA_GH_TOKEN_FALLBACK: "1" },
    });
    const calls: Array<{ command: string; env: Record<string, string> }> = [];
    const read = createGitHubRead(client, parentEnv, async (command, _args, options) => {
      calls.push({ command, env: options.env as Record<string, string> });
      return "main";
    });
    await expect(read.gh("allowed/repo", ["repo", "view", "github.com/allowed/repo"])).resolves.toBe("main");
    expect(calls).toHaveLength(1);
    expect(calls[0].env.GH_TOKEN).toBe("ambient-token");
    expect(calls[0].env.GH_CONFIG_DIR).not.toBe(parentEnv.GH_CONFIG_DIR);
  });

  it("fails typed, before any GitHub call, when the fallback is not enabled", async () => {
    const client = new TesseraClient({ env: { ...parentEnv, MARCH_TESSERA_URL: "http://tessera:9477" } });
    let ran = false;
    const read = createGitHubRead(client, parentEnv, async () => { ran = true; return ""; });
    const err = await read.gh("allowed/repo", ["repo", "view"]).catch((e) => e);
    expect(err).toBeInstanceOf(TesseraClientError);
    expect(err.code).toBe("unconfigured");
    expect(ran).toBe(false);
  });
});
