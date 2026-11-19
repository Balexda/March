/**
 * @l1 @deterministic @ci
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { traceIdForDispatch } from "../observability/trace-ids.js";
import { initLegate } from "./init.js";

const exec = promisify(execFile);
const cli = resolve(import.meta.dirname, "../../dist/cli.js");

describe("deployed conductor forge scripts", () => {
  async function fixture(deny = false, extraEnv: Record<string, string> = {}) {
    const home = await mkdtemp(join(tmpdir(), "march-conductor-forge-"));
    const checkout = join(home, "checkout");
    const bin = join(home, "bin");
    const childLog = join(home, "commands.jsonl");
    await mkdir(join(checkout, ".git"), { recursive: true });
    await mkdir(bin);
    const ghHome = join(home, ".config", "gh");
    await mkdir(ghHome, { recursive: true });
    await writeFile(join(ghHome, "hosts.yml"), "github.com:\n  oauth_token: mounted-operator-token\n");
    const traces: string[] = [];
    const requests: { [key: string]: unknown }[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/github/token") {
        requests.push({ ...JSON.parse(body), slice: req.headers["x-march-slice-id"] });
        if (deny) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: { code: "policy_denied", detail: "fake-private-error" } }));
          return;
        }
        res.end(JSON.stringify({
          token: "fake-app-token", identity: "test[bot]", repo: "acme/checkout",
          commit_identity: { name: "App", email: "app@example.test" },
          access: requests.at(-1)?.access, expires_at: "2099-01-01T00:00:00Z",
        }));
        return;
      }
      if (req.url === "/v1/traces") traces.push(body);
      res.end("{}");
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    try {
      const binaries = {
        march: `#!/usr/bin/env bash\nexec "${process.execPath}" "${cli}" "$@"\n`,
        gh: `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const valid = process.env.GH_TOKEN === "fake-app-token" && !process.env.GITHUB_TOKEN
  && !process.env.MARCH_TESSERA_CLIENT_KEY && fs.readdirSync(process.env.GH_CONFIG_DIR).length === 0;
fs.appendFileSync(process.env.CHILD_LOG, JSON.stringify({ tool: "gh", args, valid, config: process.env.GH_CONFIG_DIR }) + "\\n");
if (!valid) process.exit(2);
if (args[0] === "repo") {
  if (args[1] !== "view" || args[2] !== "acme/checkout" || args.includes("--repo")) process.exit(3);
  console.log("main");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({ number: 42, state: "OPEN" }));
  process.exit(0);
}
if (args[0] === "api") {
  if (args[1] !== "graphql" || process.env.GH_REPO !== "github.com/acme/checkout") process.exit(4);
  console.log("[]");
  process.exit(0);
}
if (args[0] === "run") {
  console.error("gh: Resource not accessible by integration (HTTP 403) fake-app-token");
  process.exit(1);
}
if (args[2] === "8" && fs.readFileSync(process.env.CHILD_LOG, "utf8").trim().split("\\n").length === 1) {
  fs.writeFileSync(process.env.GH_CONFIG_DIR + "/fixture.yml", "");
  console.error("gh: Bad credentials (HTTP 401)");
  process.exit(1);
}
console.log(JSON.stringify({ number: 7, title: "Fixture issue", state: "OPEN" }));
`,
        git: `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "config") console.log(process.env.GIT_DIR ? "git@github.com:other/elsewhere.git" : "git@github.com:acme/checkout.git");
if (args[0] === "symbolic-ref") {
  if (!process.env.FIXTURE_STALE_HEAD) process.exit(1);
  console.log(process.env.FIXTURE_STALE_HEAD);
}
if (args[0] === "ls-remote") console.log(process.env.FIXTURE_REWRITE || args[args.length - 1]);
if (args[0] === "rev-parse") console.log("fixture-head");
if (args[0] === "branch") {
  fs.appendFileSync(process.env.CHILD_LOG, JSON.stringify({ tool: "git", args }) + "\\n");
}
if (args.includes("fetch")) {
  const valid = process.env.MARCH_GIT_AUTH === "Authorization: Basic " + Buffer.from("x-access-token:fake-app-token").toString("base64")
    && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN && !process.env.MARCH_TESSERA_CLIENT_KEY
    && process.env.GIT_CONFIG_NOSYSTEM === "1" && process.env.GIT_CONFIG_GLOBAL === "/dev/null"
    && !process.env.GIT_CONFIG_COUNT && !process.env.GIT_CONFIG_PARAMETERS
    && !process.env.GIT_SSL_NO_VERIFY && args.includes("http.sslVerify=true")
    && args.includes("http.https://github.com/acme/checkout.git.sslVerify=true")
    && args.some(arg => arg.startsWith("http.https://github.com/acme/checkout.git.sslCAInfo="));
  fs.appendFileSync(process.env.CHILD_LOG, JSON.stringify({ tool: "git", args, valid }) + "\\n");
  if (!valid) process.exit(2);
}
`,
        jq: `#!/usr/bin/env bash\nif [[ "$1" == -nc ]]; then echo '{"synced":true}'; else cat; fi\n`,
      };
      await Promise.all(Object.entries(binaries).map(([name, body]) =>
        writeFile(join(bin, name), body, { mode: 0o755 }),
      ));
      const { skills } = await initLegate({ repoPath: checkout, homeDir: home, runSetup: false });
      const port = (server.address() as AddressInfo).port;
      const endpoint = `http://127.0.0.1:${port}`;
      const env = {
        PATH: [bin, process.env.PATH].join(delimiter),
        HOME: home,
        CHILD_LOG: childLog,
        MARCH_TESSERA_URL: endpoint,
        MARCH_TESSERA_CLIENT_KEY: "fake-client-key",
        MARCH_OTEL: deny ? "1" : "0",
        MARCH_OTEL_ENDPOINT: endpoint,
        // An inherited TLS bypass must never reach the credentialed fetch.
        GIT_SSL_NO_VERIFY: "1",
      };
      return {
        requests, traces,
        invoked: async () => (await readFile(childLog, "utf8").catch(() => "")).trim().split("\n")
          .filter(Boolean).map(line => JSON.parse(line)),
        run: async (skill: string, script: string, ...args: string[]) => {
          const deployed = skills.find(entry => entry.name === skill)!;
          try {
            const result = await exec(join(deployed.stagedDir, "scripts", script), [checkout, ...args], {
              cwd: home, env: { ...env, ...extraEnv }, timeout: 10_000,
            });
            return { ...result, code: 0 };
          } catch (error) {
            const result = error as { stdout: string; stderr: string; code: number };
            if (typeof result.code !== "number") throw error;
            return result;
          }
        },
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>(done => server.close(() => done()));
          await rm(home, { force: true, recursive: true });
        },
      };
    } catch (error) {
      server.close();
      await rm(home, { force: true, recursive: true });
      throw error;
    }
  }

  it("scopes issue reads and Git fetches to the checkout with app/read", async () => {
    const test = await fixture();
    try {
      const issue = await test.run("legate.issue", "fetch-issue.sh", "7");
      expect(issue.code).toBe(0);
      expect(JSON.parse(issue.stdout)).toMatchObject({ number: 7, title: "Fixture issue" });
      expect((await test.run("legate.issue", "sync-default-branch.sh", "issue-7")).code).toBe(0);
      expect(test.requests).toEqual(Array(3).fill({
        repo: "acme/checkout", access: "read", identity: "app", slice: "issue-7",
      }));
      const [gh, repo, git] = await test.invoked();
      expect(gh).toMatchObject({ tool: "gh", valid: true, args: expect.arrayContaining(["--repo", "acme/checkout"]) });
      await expect(readFile(gh.config)).rejects.toMatchObject({ code: "ENOENT" });
      expect(repo).toMatchObject({
        tool: "gh", valid: true,
        args: ["repo", "view", "acme/checkout", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
      });
      expect(git).toMatchObject({
        tool: "git", valid: true,
        args: expect.arrayContaining(["--no-recurse-submodules", "https://github.com/acme/checkout.git", "+refs/heads/main:refs/remotes/origin/main"]),
      });
      expect(git.args.join(" ")).not.toContain("fake-app-token");
    } finally {
      await test.close();
    }
  }, 20_000);

  it("syncs the GitHub-confirmed default branch, never a stale local origin/HEAD", async () => {
    const test = await fixture(false, { FIXTURE_STALE_HEAD: "origin/old-default" });
    try {
      const sync = await test.run("legate.issue", "sync-default-branch.sh", "issue-7");
      expect(sync.code).toBe(0);
      const git = (await test.invoked()).find(entry => entry.tool === "git" && entry.args.includes("fetch"));
      expect(git).toMatchObject({ valid: true, args: expect.arrayContaining(["+refs/heads/main:refs/remotes/origin/main"]) });
    } finally {
      await test.close();
    }
  }, 20_000);

  it("resolves origin without inherited GIT_* so GIT_DIR cannot redirect the entitlement", async () => {
    const test = await fixture(false, { GIT_DIR: "/elsewhere/.git" });
    try {
      expect((await test.run("legate.issue", "fetch-issue.sh", "7")).code).toBe(0);
      expect(test.requests).toEqual([{ repo: "acme/checkout", access: "read", identity: "app", slice: "issue-7" }]);
    } finally {
      await test.close();
    }
  }, 20_000);

  it("refuses the credentialed fetch when an insteadOf rule rewrites the GitHub URL", async () => {
    const test = await fixture(false, { FIXTURE_REWRITE: "https://evil.example/acme/checkout.git" });
    try {
      const sync = await test.run("legate.issue", "sync-default-branch.sh", "issue-7");
      expect(sync.code).not.toBe(0);
      expect(sync.stderr).toContain("GitHub fetch failed.");
      // Only the default-branch read was issued; no entitlement for the rewritten fetch.
      expect(test.requests).toHaveLength(1);
      expect((await test.invoked()).some(entry => entry.tool === "git" && entry.args.includes("fetch"))).toBe(false);
    } finally {
      await test.close();
    }
  }, 20_000);

  it("scopes the PR read and GraphQL review-thread query to the same selected repository", async () => {
    const test = await fixture();
    try {
      const result = await test.run("legate.babysit", "babysit-pr.sh", "42", "slice-42");
      expect(result.code).toBe(0);
      expect(test.requests).toEqual(Array(2).fill({
        repo: "acme/checkout", access: "read", identity: "app", slice: "slice-42",
      }));
      const [pr, query] = await test.invoked();
      expect(pr).toMatchObject({
        tool: "gh", valid: true, args: expect.arrayContaining(["pr", "view", "42", "--repo", "acme/checkout"]),
      });
      expect(query).toMatchObject({
        tool: "gh", valid: true, args: expect.arrayContaining(["api", "graphql", "owner=acme", "name=checkout", "pr=42"]),
      });
    } finally {
      await test.close();
    }
  }, 20_000);

  it("uses app/write for an Actions rerun and surfaces an unsupported rerun without retry", async () => {
    const test = await fixture();
    try {
      const result = await test.run("legate.babysit", "rerun-ci.sh", "17", "slice-17");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Ask the operator to rerun");
      expect(result.stderr).not.toContain("fake-app-token");
      expect(test.requests).toEqual([{ repo: "acme/checkout", access: "write", identity: "app", slice: "slice-17" }]);
      expect(await test.invoked()).toHaveLength(1);
    } finally {
      await test.close();
    }
  }, 20_000);

  it("refreshes once after a confirmed 401 and gives the retry an empty gh config", async () => {
    const test = await fixture();
    try {
      const result = await test.run("legate.issue", "fetch-issue.sh", "8");
      expect(result.code).toBe(0);
      expect(test.requests).toEqual([
        { repo: "acme/checkout", access: "read", identity: "app", slice: "issue-8" },
        { repo: "acme/checkout", access: "read", identity: "app", slice: "issue-8", refresh: true },
      ]);
      const children = await test.invoked();
      expect(children.map(child => child.valid)).toEqual([true, true]);
      expect(children[0].config).not.toEqual(children[1].config);
    } finally {
      await test.close();
    }
  }, 20_000);

  it("stops before gh on a denied entitlement and exports a sanitized error span on the slice", async () => {
    const test = await fixture(true);
    try {
      const result = await test.run("legate.issue", "fetch-issue.sh", "7");
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Tessera token request failed (policy_denied).");
      expect(result.stderr).not.toContain("fake-private-error");
      expect(await test.invoked()).toEqual([]);
      const spans = test.traces.flatMap(body => JSON.parse(body).resourceSpans)
        .flatMap(resource => resource.scopeSpans).flatMap(scope => scope.spans);
      expect(spans).toEqual(expect.arrayContaining([expect.objectContaining({
        name: "tessera.issue", traceId: traceIdForDispatch("issue-7"), status: expect.objectContaining({ code: 2 }),
      })]));
      expect(JSON.stringify(spans)).not.toContain("fake-private-error");
    } finally {
      await test.close();
    }
  }, 20_000);

  it("refuses stale-branch cleanup when the repository cannot be inspected", async () => {
    const test = await fixture(true);
    try {
      const result = await test.run("legate.unwedge", "clean-stale-branch.sh", "stale-branch", "slice-stale");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Tessera token request failed (policy_denied).");
      expect(result.stdout).toBe("");
      expect(test.requests).toEqual([{ repo: "acme/checkout", access: "read", identity: "app", slice: "slice-stale" }]);
      expect(await test.invoked()).toEqual([]);
    } finally {
      await test.close();
    }
  }, 20_000);
});
