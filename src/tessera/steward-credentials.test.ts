/**
 * @l1 @deterministic @ci
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentDeckAdapter } from "../castra/adapter.js";
import { ensureStewardSkills } from "../castra/steward-skills.js";

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

async function listen(deny: boolean | (() => boolean) = false) {
  server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const parsed = JSON.parse(body);
    requests.push([request.method, request.url, request.headers.authorization, parsed]);
    response.setHeader("content-type", "application/json");
    if (typeof deny === "function" ? deny() : deny) {
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
  cwd = join(root, "feature-slice-2");
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

describe("steward Git shim", { timeout: 30_000 }, () => {
  const gitShim = resolve(import.meta.dirname, "../templates/steward/bin/git");

  it("passes GitHub URLs in non-transport command data through unchanged", async () => {
    await setOrigin("git@github.com:acme/widgets.git");
    for (const [name, value] of [["user.name", "Operator"], ["user.email", "operator@example.test"]]) {
      expect((await run("git", ["config", name, value])).code).toBe(0);
    }
    await writeFile(join(cwd, "README.md"), "see https://github.com/acme/widgets\n");
    expect((await run("git", ["add", "README.md"])).code).toBe(0);

    const message = "http://github.com/acme/widgets";
    const commit = await run(process.execPath, [gitShim, "commit", "-q", "-m", message]);
    expect(commit.code, commit.stderr).toBe(0);
    expect((await run("git", ["log", "-1", "--format=%s"])).stdout.trim()).toBe(message);

    const grep = await run(process.execPath, [gitShim, "-C", cwd, "grep", "-F", "https://github.com"]);
    expect(grep).toEqual({ code: 0, stdout: "README.md:see https://github.com/acme/widgets\n", stderr: "" });
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

describe("Castra steward launch credentials", { timeout: 30_000 }, () => {
  async function launchCommand(createBranch: boolean) {
    const skills = join(root, "host's steward assets");
    const launched = join(root, "launch-args.json");
    await writeFile(join(bin, "agent-deck"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const launched = ${JSON.stringify(launched)};
if (args[2] === "launch") fs.writeFileSync(launched, JSON.stringify(args));
if (args[2] === "list") {
  console.log(fs.existsSync(launched) ? ${JSON.stringify(JSON.stringify([{
    id: "test-steward", group: "stewards", worktree_path: cwd, branch: "slice-2",
  }]))} : "[]");
}
`, { mode: 0o755 });
    const launchEnv = {
      PATH: env.PATH!.split(":").slice(1).join(":"),
      MARCH_STEWARD_SKILLS_DIR: skills,
      MARCH_TESSERA_PORT: new URL(env.MARCH_TESSERA_URL!).port,
    };
    const saved = { ...process.env };
    try {
      Object.assign(process.env, launchEnv);
      await ensureStewardSkills();
      await writeFile(join(skills, "tessera-client-key"), key + "\n", { mode: 0o600 });
      createAgentDeckAdapter().launch({
        repoPath: cwd, profile: "march", group: "stewards", title: "Steward",
        branch: "slice-2", createBranch,
      });
      const args: string[] = JSON.parse(await readFile(launched, "utf8"));
      expect(args.includes("-b")).toBe(createBranch);
      // Agent-deck substitutes the Claude command on the host. Shell startup
      // can re-export credentials after the launcher has cleaned its environment.
      return (command: string) => run("sh", ["-c", args[args.indexOf("--wrapper") + 1]
        .replace("{command}", 'sh -c "$1"'), "agent-deck", `
          export GH_TOKEN=from-shell GITHUB_TOKEN=from-shell
          export MARCH_TESSERA_CLIENT_KEY=wrong-key MARCH_TESSERA_GH_TOKEN_FALLBACK=1
          export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader
          export GIT_CONFIG_VALUE_0="Authorization: Bearer inherited-header"
          ${command}`], "", { PATH: launchEnv.PATH });
    } finally {
      for (const name of Object.keys(launchEnv)) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  }

  it.each([true, false])("uses fresh gh credentials after launch (createBranch=%s)", async createBranch => {
    await listen();
    await setupRealExecutable();
    await setOrigin("git@github.com:acme/widgets.git");
    const launch = await launchCommand(createBranch);
    for (let i = 1; i <= 2; i++) {
      const result = await launch("gh pr create");
      expect(result.code).toBe(7);
      expect(JSON.parse(result.stdout)).toMatchObject({
        args: ["pr", "create"], isolated: true, botIssuance: String(i), noOtherToken: true,
      });
    }
    expect(requests.map(request => (request as unknown[])[2])).toEqual([`Bearer ${key}`, `Bearer ${key}`]);
    expect(await readdir(env.TMPDIR!)).toEqual([]);
    expect(await readFile(join(config, "hosts.yml"), "utf8")).toBe(hostLogin);
  });

  it("pushes through HTTPS with Tessera despite a host helper, netrc and local auth header", async () => {
    let deny = false;
    await listen(() => deny);
    const ca = join(root, "github.crt");
    const privateKey = join(root, "github.key");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=github.com", "-addext", "subjectAltName=DNS:github.com",
      "-keyout", privateKey, "-out", ca], { stdio: "ignore", timeout: 5_000 });
    env.GIT_SSL_CAINFO = ca;
    await mkdir(join(root, "acme"));
    expect((await run("git", ["init", "--bare", join(root, "acme", "widgets.git")])).code).toBe(0);

    const auth: Array<string | undefined> = [];
    const github = createHttpsServer({
      key: await readFile(privateKey), cert: await readFile(ca),
    }, (req, res) => {
      const authorization = req.headers.authorization;
      auth.push(authorization);
      if (!authorization?.startsWith("Basic ") ||
          !/^x-access-token:fake-issued-token\d+$/.test(Buffer.from(authorization.slice(6), "base64").toString())) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' }).end();
        return;
      }
      const url = new URL(req.url!, "https://github.com");
      const cgi = spawn("git", ["http-backend"], {
        env: {
          PATH: env.PATH, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers["content-type"], CONTENT_LENGTH: req.headers["content-length"],
          REMOTE_USER: "test-bot[bot]",
        },
        timeout: 5_000, stdio: ["pipe", "pipe", "ignore"],
      });
      req.pipe(cgi.stdin);
      cgi.stdin.on("error", () => {});
      const chunks: Buffer[] = [];
      cgi.stdout.on("data", chunk => chunks.push(chunk));
      cgi.on("close", code => {
        const response = Buffer.concat(chunks);
        const boundary = response.indexOf("\r\n\r\n");
        if (code !== 0 || boundary < 0) {
          res.writeHead(500).end();
          return;
        }
        for (const line of response.subarray(0, boundary).toString().split("\r\n")) {
          const colon = line.indexOf(":");
          if (line.startsWith("Status:")) res.statusCode = Number(line.slice(colon + 1).trim().split(" ")[0]);
          else res.setHeader(line.slice(0, colon), line.slice(colon + 1).trim());
        }
        res.end(response.subarray(boundary + 4));
      });
    });
    const sockets = new Set<Duplex>();
    const tunnels: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (req, client) => {
      tunnels.push(req.url!);
      if (req.url !== "github.com:443") {
        client.end();
        return;
      }
      const upstream = connect((github.address() as AddressInfo).port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
      sockets.add(client);
    });
    try {
      for (const service of [github, proxy]) {
        await new Promise<void>(done => service.listen(0, "127.0.0.1", done));
      }
      const port = (proxy.address() as AddressInfo).port;
      env.GIT_ALLOW_PROTOCOL = "https";
      env.https_proxy = `http://127.0.0.1:${port}`;
      const globalConfig = `[user]\nname = Operator\nemail = operator@example.test\n[credential]\nhelper = "!echo host-helper-ran >&2; echo username=host; echo password=${ambient}; #"\n`;
      await writeFile(join(root, ".gitconfig"), globalConfig);
      await writeFile(join(root, ".netrc"), `machine github.com login host password ${ambient}\n`, { mode: 0o600 });
      await setOrigin("git@github.com:acme/widgets.git");
      expect((await run("git", ["config", "http.https://github.com/.proxy", `http://127.0.0.1:${port}`])).code).toBe(0);
      expect((await run("git", ["config", "http.https://github.com/acme/widgets.git.extraHeader",
        "Authorization: Bearer repository-header"])).code).toBe(0);
      expect((await run("git", ["config", "credential.https://github.com/acme/widgets.git.helper",
        "!echo repository-helper-ran >&2; echo username=host; echo password=wrong; #"])).code).toBe(0);
      expect((await run("git", ["config", "credential.https://github.com/acme/widgets.git.useHttpPath",
        "false"])).code).toBe(0);
      const launch = await launchCommand(true);
      expect((await launch('git commit --allow-empty -m "steward work"')).code).toBe(0);
      expect((await launch("git log -1 --format=%an")).stdout.trim()).toBe("Operator");
      for (const [i, url] of ["git@github.com:acme/widgets.git",
        "https://host:embedded@github.com/acme/widgets.git"].entries()) {
        expect((await run("git", ["remote", "set-url", "origin", url])).code).toBe(0);
        const push = await launch(`git push origin HEAD:refs/heads/delivery-${i}`);
        expect(push.stderr).not.toContain("host-helper-ran");
        expect(push.stderr).not.toContain("repository-helper-ran");
        expect(push.code, push.stderr).toBe(0);
      }
      expect(tunnels.length).toBeGreaterThan(0);
      expect(tunnels.every(host => host === "github.com:443")).toBe(true);
      expect(auth[0]).toBeUndefined();
      expect(auth.filter(Boolean).length).toBeGreaterThan(0);
      for (const header of auth.filter(Boolean)) {
        expect(Buffer.from(header!.slice(6), "base64").toString()).toMatch(/^x-access-token:fake-issued-token\d+$/);
      }
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(requests.every(request => (request as unknown[])[2] === `Bearer ${key}`)).toBe(true);
      expect(await readFile(join(root, ".gitconfig"), "utf8")).toBe(globalConfig);
      deny = true;
      auth.length = 0;
      const denied = await launch("git push origin HEAD:refs/heads/denied");
      expect(denied.code).not.toBe(0);
      expect(denied.stderr).toContain("Tessera Git credential request failed (policy_denied).");
      expect(denied.stderr).not.toMatch(/helper-ran|embedded|from-shell/);
      expect(auth).toEqual([undefined]);
    } finally {
      sockets.forEach(socket => socket.destroy());
      github.closeAllConnections();
      await Promise.all([github, proxy].map(service => new Promise<void>(done => service.close(() => done()))));
    }
  });

  it.each(["denial", "outage"])("fails closed through the launch path on %s", async failure => {
    await listen(true);
    if (failure === "outage") await new Promise<void>(done => server!.close(() => done()));
    await setupRealExecutable();
    await setOrigin("https://github.com/acme/widgets.git");
    const launch = await launchCommand(false);
    expect(await launch("gh pr create")).toEqual({
      code: 1, stdout: "", stderr: "Tessera gh: Tessera token request failed.\n",
    });
    const result = await launch("printf 'url=https://github.com/acme/widgets.git\\n\\n' | git credential fill");
    expect(result.code).toBe(128);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(failure === "denial" ? "policy_denied" : "unreachable");
    expect(result.stderr).not.toContain(key);
  });
});
