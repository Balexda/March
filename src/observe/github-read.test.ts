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

describe("createGitHubRead git transport", () => {
  const url = "https://github.com/allowed/repo.git";
  function issuingClient() {
    const refreshes: Array<boolean | undefined> = [];
    return {
      refreshes,
      client: {
        async issueGitHubToken(req: { refresh?: boolean }) {
          refreshes.push(req.refresh);
          return { token: req.refresh ? "fresh" : "stale", expiresAt: null, identity: "march[bot]", commitIdentity: null };
        },
      } as any,
    };
  }

  it("pins TLS verification and trust anchors on the credentialed fetch", async () => {
    const { client } = issuingClient();
    const seen: string[][] = [];
    const read = createGitHubRead(client, {}, async (_command, args) => {
      seen.push(args);
      return args[0] === "ls-remote" ? url : "";
    });
    await read.git("allowed/repo", "/repo", ["fetch"], "refs/heads/main");
    const fetch = seen.find((args) => args.includes("fetch"))!;
    const pairs = fetch.flatMap((arg, i) => (fetch[i - 1] === "-c" ? [arg] : []));
    expect(pairs).toEqual(expect.arrayContaining([
      "http.sslVerify=true",
      `http.${url}.sslVerify=true`,
      expect.stringMatching(/^http\.sslCAInfo=\/.+/),
      expect.stringMatching(new RegExp(`^http\\.${url.replace(/[.\\/]/g, "\\$&")}\\.sslCAInfo=/.+`)),
      expect.stringMatching(/^http\.sslCAPath=\/.+/),
    ]));
  });

  it.each([
    `fatal: unable to access '${url}/': The requested URL returned error: 401`,
    `fatal: Authentication failed for '${url}/'`,
    "error: unable to read askpass response from '/bin/false'\nfatal: could not read Username for 'https://github.com': terminal prompts disabled",
  ])("refreshes the credential once on a git 401 reported as %s", async (stderr) => {
    const { client, refreshes } = issuingClient();
    let fetches = 0;
    const read = createGitHubRead(client, {}, async (_command, args) => {
      if (args[0] === "ls-remote") return url;
      if (fetches++ === 0) throw Object.assign(new Error("git failed"), { stderr });
      return "ok";
    });
    await expect(read.git("allowed/repo", "/repo", ["fetch"], "refs/heads/main")).resolves.toBe("ok");
    expect(refreshes).toEqual([undefined, true]);
  });

  it("does not refresh on a non-auth git failure", async () => {
    const { client, refreshes } = issuingClient();
    const read = createGitHubRead(client, {}, async (_command, args) => {
      if (args[0] === "ls-remote") return url;
      throw Object.assign(new Error("git failed"), { stderr: "fatal: couldn't find remote ref refs/heads/main" });
    });
    await expect(read.git("allowed/repo", "/repo", ["fetch"], "refs/heads/main")).rejects.toThrow("GitHub read failed");
    expect(refreshes).toEqual([undefined]);
  });
});
