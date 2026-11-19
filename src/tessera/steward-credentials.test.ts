/**
 * @l1 @deterministic @ci
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "../../dist/cli.js");
const wrapper = resolve(import.meta.dirname, "../templates/steward/bin/gh");
const token = "fake-issued-token";
const ambient = "fake-ambient-token";
const hostLogin = "fake-host-login";
const key = "fake-tessera-key";
const ghArgs = ["pr", "create", "--title", "a title; with spaces", "--body", "line 1\nline 2"];
const githubRequest = "protocol=https\nhost=github.com\npath=other/target.git\n\n";

let root: string;
let cwd: string;
let bin: string;
let config: string;
let env: NodeJS.ProcessEnv;
let server: Server | undefined;
let requests: unknown[];

function run(executable: string, args: string[], input = "", overrides?: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(executable, args, {
      cwd, env: { ...env, ...overrides }, timeout: 15_000, killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", part => { stdout += part; });
    child.stderr.setEncoding("utf8").on("data", part => { stderr += part; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) reject(new Error(`Subprocess exited on ${signal}`));
      else done({ code, stdout, stderr });
    });
    // A subprocess may exit before reading stdin; its exit status is the result.
    child.stdin.on("error", error => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

async function listen(deny = false) {
  server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const parsed = JSON.parse(body);
    requests.push([request.method, request.url, request.headers.authorization, parsed]);
    response.setHeader("content-type", "application/json");
    if (deny) {
      response.writeHead(403);
      response.end(JSON.stringify({ error: { code: "policy_denied", message: key } }));
      return;
    }
    response.end(JSON.stringify({
      token: token + requests.length,
      identity: "test-bot[bot]",
      repo: parsed.repo,
      access: "write",
      expires_at: "2030-01-01T00:00:00Z",
      commit_identity: { name: "Test Bot", email: "bot@example.com" },
    }));
  });
  await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
  env.MARCH_TESSERA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function setupRealExecutable() {
  await writeFile(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const env = process.env;
const isolated = env.GH_CONFIG_DIR !== ${JSON.stringify(config)} &&
  fs.readdirSync(env.GH_CONFIG_DIR).length === 0;
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2), isolated, configDir: env.GH_CONFIG_DIR,
  botIssuance: /^${token}(\\d+)$/.exec(env.GH_TOKEN)?.[1],
  noOtherToken: !env.GITHUB_TOKEN && !env.GH_ENTERPRISE_TOKEN && !env.GITHUB_ENTERPRISE_TOKEN,
  noClientKey: !env.MARCH_TESSERA_CLIENT_KEY,
  noDebug: !env.GH_DEBUG,
}));
process.stderr.write("substitute stderr\\n");
process.exitCode = 7;
`, { mode: 0o755 });
}

function runWrapper(overrides?: NodeJS.ProcessEnv) {
  return run(wrapper, ghArgs, "", overrides);
}

function gitCredential(operation: string, input: string, fallback = false) {
  return run("git", [
    "-c", "credential.useHttpPath=true",
    "-c", "credential.helper=",
    "-c", `credential.helper=!'${process.execPath}' '${cli}' tessera git-credential`,
    ...(fallback ? ["-c", "credential.helper=!echo fallback-ran >&2; echo username=ambient; echo password=ambient; #"] : []),
    "credential", operation,
  ], input);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "march-credentials-test-"));
  cwd = join(root, "repo");
  bin = join(root, "bin");
  config = join(root, "host-gh-config");
  const shimBin = join(root, "shims");
  const scratch = join(root, "scratch");
  await Promise.all([cwd, bin, config, shimBin, scratch].map(directory => mkdir(directory)));
  await writeFile(join(config, "hosts.yml"), hostLogin);
  await symlink(wrapper, join(shimBin, "gh"));
  await symlink(cli, join(bin, "march"));
  await writeFile(join(bin, "askpass"), '#!/bin/sh\necho askpass-ran >&2\necho ambient\n', { mode: 0o755 });
  env = {
    PATH: [shimBin, bin, dirname(process.execPath), "/usr/bin", "/bin", "/usr/local/bin"].join(":"),
    HOME: root,
    TMPDIR: scratch,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ASKPASS: join(bin, "askpass"),
    GIT_TERMINAL_PROMPT: "0",
    GH_CONFIG_DIR: config,
    GH_DEBUG: "api",
    GH_TOKEN: ambient,
    GITHUB_TOKEN: ambient,
    GH_ENTERPRISE_TOKEN: ambient,
    GITHUB_ENTERPRISE_TOKEN: ambient,
    MARCH_TESSERA_CLIENT_KEY: key,
    MARCH_TESSERA_GH_TOKEN_FALLBACK: "1",
    MARCH_OTEL: "0",
  };
  requests = [];
});

afterEach(async () => {
  if (server) {
    const closing = new Promise<void>(done => server!.close(() => done()));
    server.closeAllConnections();
    await closing;
    server = undefined;
  }
  await rm(root, { recursive: true, force: true });
});

async function setOrigin(url: string) {
  expect((await run("git", ["init", "-q"])).code).toBe(0);
  expect((await run("git", ["remote", "add", "origin", url])).code).toBe(0);
}

// Each case spawns several Node subprocesses; allow for a loaded CI host.
describe("steward GitHub CLI shim", { timeout: 30_000 }, () => {
  it("issues an app/write request for each call and preserves arguments, output and exit status", async () => {
    await listen();
    await setupRealExecutable();
    await setOrigin("git@github.com:acme/widgets.git");
    for (let i = 0; i < 3; i++) {
      const result = await runWrapper();
      expect(result.code).toBe(7);
      expect(result.stderr).toBe("substitute stderr\n");
      expect(JSON.parse(result.stdout)).toEqual({
        args: ghArgs, isolated: true, configDir: expect.stringContaining(env.TMPDIR!),
        botIssuance: String(i + 1), noOtherToken: true, noClientKey: true, noDebug: true,
      });
      expect(await readdir(env.TMPDIR!)).toEqual([]);
    }
    expect(requests).toEqual(Array.from({ length: 3 }, () =>
      ["POST", "/v1/github/token", `Bearer ${key}`, { repo: "acme/widgets", access: "write", identity: "app" }]));
    expect(await readFile(join(config, "hosts.yml"), "utf8")).toBe(hostLogin);
  });

  it.each(["deny", "unreachable"])("does not invoke the real binary on %s", async failure => {
    await listen(true);
    if (failure === "unreachable") await new Promise<void>(done => server!.close(() => done()));
    await setupRealExecutable();
    await setOrigin("https://github.com/acme/widgets.git");
    expect(await runWrapper()).toEqual({
      code: 1, stdout: "", stderr: "Tessera gh: Tessera token request failed.\n",
    });
  });

  it("fails before issuance when the worktree cannot identify its GitHub repository", async () => {
    await listen();
    await setupRealExecutable();
    await setOrigin("https://example.org/acme/widgets.git");
    expect(await runWrapper()).toEqual({
      code: 1, stdout: "", stderr: "Tessera gh: GitHub origin repository unavailable.\n",
    });
    expect(requests).toEqual([]);
  });

  it("rejects resolution back to the wrapper and handles an absent executable", async () => {
    await listen();
    await setOrigin("ssh://git@github.com/acme/widgets.git");
    const runtime = join(root, "node-only");
    await mkdir(runtime);
    await symlink(process.execPath, join(runtime, "node"));
    expect(await runWrapper({ PATH: `${join(root, "shims")}:${runtime}` })).toEqual({
      code: 1, stdout: "", stderr: "Tessera gh: no real executable beyond the wrapper.\n",
    });
    expect(await runWrapper({ PATH: runtime })).toEqual({
      code: 1, stdout: "", stderr: "Tessera gh: real executable unavailable.\n",
    });
    expect(await runWrapper({ MARCH_TESSERA_GH_WRAPPED: "1" })).toEqual({
      code: 1, stdout: "", stderr: "Tessera gh: recursive wrapper invocation.\n",
    });
    expect(requests).toEqual([]);
  });

  it("terminates a stalled real executable and fails with a sanitized diagnostic", async () => {
    await listen();
    await setOrigin("https://github.com/acme/widgets.git");
    await writeFile(join(bin, "gh"), "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
    const started = Date.now();
    expect(await runWrapper({ MARCH_TESSERA_GH_TIMEOUT_MS: "300" })).toEqual({
      code: 1, stdout: "", stderr: "Tessera gh: real executable timed out.\n",
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(requests).toHaveLength(1);
    expect(await readdir(join(root, "scratch"))).toEqual([]);
  });

  it("rejects an invalid execution deadline before issuance", async () => {
    await listen();
    await setupRealExecutable();
    await setOrigin("https://github.com/acme/widgets.git");
    expect(await runWrapper({ MARCH_TESSERA_GH_TIMEOUT_MS: "soon" })).toEqual({
      code: 1, stdout: "", stderr: "Tessera gh: invalid MARCH_TESSERA_GH_TIMEOUT_MS.\n",
    });
    expect(requests).toEqual([]);
  });
});

describe("Tessera Git credential helper", { timeout: 30_000 }, () => {
  it("returns app/write credentials for the actual HTTPS request and ignores approve/reject", async () => {
    await listen();
    await setOrigin("git@github.com:acme/widgets.git");
    const first = await gitCredential("fill", "url=https://github.com/other/target.git\n\n");
    expect(first).toEqual({
      code: 0, stdout: githubRequest.replace(/\n\n$/, `\nusername=x-access-token\npassword=${token}1\n`), stderr: "",
    });
    for (const operation of ["approve", "reject"]) {
      expect(await gitCredential(operation, first.stdout)).toEqual({ code: 0, stdout: "", stderr: "" });
    }
    expect((await gitCredential("fill", githubRequest)).stdout).toContain(`password=${token}2\n`);
    expect(requests).toEqual(Array.from({ length: 2 }, () =>
      ["POST", "/v1/github/token", `Bearer ${key}`, { repo: "other/target", access: "write", identity: "app" }]));
  });

  it("returns no credentials for another host", async () => {
    await listen();
    const result = await run(process.execPath, [cli, "tessera", "git-credential", "get"],
      githubRequest.replace("github.com", "example.org"));
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(requests).toEqual([]);
  });

  it.each(["denial", "outage", "missing path", "extra path"])("stops Git before fallback or prompting on %s", async failure => {
    await listen(true);
    if (failure === "outage") await new Promise<void>(done => server!.close(() => done()));
    const input = failure === "missing path" ? githubRequest.replace("path=other/target.git\n", "")
      : failure === "extra path" ? githubRequest.replace("target.git", "target.git/extra")
      : githubRequest;
    const result = await gitCredential("fill", input, true);
    const code = failure === "denial" ? "policy_denied"
      : failure === "outage" ? "unreachable" : "invalid_repository_context";
    expect(result.code).toBe(128);
    expect(result.stdout).toBe("");
    const [diagnostic, gitError, extra] = result.stderr.trimEnd().split("\n");
    expect(diagnostic).toBe(`Tessera Git credential request failed (${code}).`);
    expect(gitError).toMatch(/^fatal: credential helper .* told us to quit$/);
    expect(extra).toBeUndefined();
    expect(requests).toHaveLength(failure === "denial" ? 1 : 0);
  });
});
