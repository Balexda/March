/**
 * @l1 @deterministic @ci
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FINDER_BIN } from "../shared/deps.js";

const _require = createRequire(import.meta.url);
const PKG_VERSION: string = (
  _require("../../package.json") as { version: string }
).version;

const CLI_PATH = resolve(import.meta.dirname, "../../dist/cli.js");

// Absolute path to the finder binary (which on Unix, where on Windows) —
// used to build isolated test PATHs.
const FINDER_PATH = execFileSync(FINDER_BIN, [FINDER_BIN], {
  encoding: "utf-8",
}).trim();

// Deterministic 64-hex-char fake container ID emitted by the docker stub
// when invoked as `docker create ...`. Shared between the stub builder and
// the success-path assertion so the test asserts on the exact literal the
// stub prints — see SD-003 in the US5 tasks file. The 64-char width matches
// the full container ID format Docker actually returns from `create`.
const FAKE_CONTAINER_ID = "0123456789abcdef".repeat(4);

function run(
  args: string[],
  options?: { env?: Record<string, string> },
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      env: options?.env,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout: string; stderr: string; status: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
  }
}

describe("march CLI", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-cli-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs.length = 0;
  });

  /**
   * Runs the CLI with a fully controlled environment. Uses `spawnSync` instead
   * of `execFileSync` so both stdout and stderr are captured regardless of
   * exit code.
   */
  function runWithEnv(
    args: string[],
    env: Record<string, string | undefined>,
    options?: { cwd?: string },
  ): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      ...(options?.cwd ? { cwd: options.cwd } : {}),
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
    };
  }

  /**
   * Creates a temporary bin directory containing a symlink to the finder
   * binary (which/where) plus optional stub executables for each name in
   * `stubs`. Returns the bin directory path — the parent tmpdir is tracked
   * for cleanup in afterEach.
   */
  function makeFakeBin(stubs: string[] = []): string {
    const fakeBin = path.join(makeTmpDir(), "bin");
    fs.mkdirSync(fakeBin);
    // Always include the finder binary so isFinderAvailable() returns true.
    fs.symlinkSync(FINDER_PATH, path.join(fakeBin, path.basename(FINDER_PATH)));
    for (const name of stubs) {
      const stub = path.join(fakeBin, name);
      fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(stub, 0o755);
    }
    return fakeBin;
  }

  it("march init runs successfully on clean home", () => {
    const tmpDir = makeTmpDir();
    const result = run(["init"], {
      env: { ...process.env, HOME: tmpDir },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("initialized successfully");
  });

  it("march with no args exits 2 with usage", () => {
    const result = run([]);
    expect(result.exitCode).toBe(2);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/usage|Usage/i);
    // AS 4.1: no-args output lists all five registered commands (two-tier listing).
    // Match command-list entries (leading whitespace + command name as first word)
    // to avoid false positives from --help/--version in the Options section.
    for (const cmd of ["init", "update", "help", "version", "hatchery", "spawn"]) {
      expect(combined).toMatch(new RegExp(`^\\s+${cmd}\\b`, "m"));
    }
  });

  it("march with unknown command exits 2 with error and valid commands", () => {
    const result = run(["nonexistent"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("nonexistent");
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("init");
  });

  it("--yes flag is accepted without error", () => {
    // With --yes but no command, should still exit 2 (no command given)
    const result = run(["--yes"]);
    expect(result.exitCode).toBe(2);
    // Should not contain any error about unknown option
    expect(result.stderr).not.toContain("unknown option");
  });

  it("march --version prints the package version", () => {
    const result = run(["--version"]);
    expect(result.stdout).toContain(PKG_VERSION);
  });

  describe("march legate", () => {
    it("bare `march legate` exits 2 and prints the legate group help", () => {
      const result = run(["legate"]);
      expect(result.exitCode).toBe(2);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("Usage: march legate");
      // The help should list `init`, `serve` (alias `loop`), and `recover`.
      expect(combined).toMatch(/^\s+init\b/m);
      expect(combined).toMatch(/^\s+serve\|loop\b/m);
      expect(combined).toMatch(/^\s+recover\b/m);
    });

    it("`march legate recover --help` exits 0 and prints the recover usage", () => {
      const result = run(["legate", "recover", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: march legate recover");
      expect(result.stdout).toContain("sliceId");
    });

    it("`march legate recover <sliceId>` exits 1 with a reach error when Herald is down", () => {
      // Point at a closed port so the append fails fast with a connection error,
      // exercising the recover action's Herald round-trip + error path.
      const result = runWithEnv(
        ["legate", "recover", "some-slice"],
        { ...process.env, MARCH_HERALD_URL: "http://127.0.0.1:1" },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Could not reach the herald service");
    });

    it("`march legate serve --help` exits 0 and prints the service flag surface", () => {
      const result = run(["legate", "serve", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: march legate serve");
      expect(result.stdout).toContain("--port");
    });

    it("`march legate loop` still routes to serve via the back-compat alias", () => {
      const result = run(["legate", "loop", "--port", "bogus"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("Invalid --port");
    });

    it("`march legate <bad>` reports the actual unknown subcommand, not 'legate'", () => {
      const result = run(["legate", "frobnicate"]);
      expect(result.exitCode).toBe(2);
      // Critical regression guard: previously the bottom-of-file argv scan
      // mis-blamed the parent group token, so users saw
      // "unknown command 'legate'". The fix surfaces commander's own
      // diagnostic which names the actual unknown subcommand.
      expect(result.stderr).toContain("unknown command 'frobnicate'");
      expect(result.stderr).not.toContain("unknown command 'legate'");
      // Help output should be the legate group's, not the program's, so
      // the user sees the valid subcommand list scoped to legate.
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("Usage: march legate");
    });

    it("`march legate init --help` exits 0 and prints init flag surface", () => {
      const result = run(["legate", "init", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: march legate init");
      expect(result.stdout).toContain("--profile");
      expect(result.stdout).toContain("--name");
      expect(result.stdout).toContain("--no-setup");
      expect(result.stdout).toContain("--no-loop");
      expect(result.stdout).toContain("--no-processor");
    });

    it("`march legate init` without docker exits 1 with a docker-specific message", () => {
      // The deterministic loop runs as a Hatchery-managed container — the only
      // loop runtime — so the default init launches it and requires Docker.
      const fakeBin = makeFakeBin(["git"]); // git only, no docker
      const nodeBinDir = path.dirname(process.execPath);
      const result = runWithEnv(
        ["legate", "init"],
        { PATH: `${nodeBinDir}${path.delimiter}${fakeBin}`, HOME: makeTmpDir() },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Docker not found on PATH");
      expect(result.stderr).toContain("Legate loop service container");
      expect(result.stderr).not.toContain("agent-deck not found");
    });

    it("`march legate init` outside a git repository exits 1 with a clear message", () => {
      // os.tmpdir() is not part of any git repo on the host — running
      // from there exercises the not-a-git-repo branch.
      const tmpDir = makeTmpDir();
      const result = runWithEnv(
        ["legate", "init", "--no-setup"],
        { ...process.env },
        { cwd: tmpDir },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Run `march legate init` from inside a git repository.",
      );
    });

    it("`march legate init` without git on PATH exits 1 with a git-specific message", () => {
      // Fake bin with no `git` stub — `isOnPath('git')` returns false.
      // Distinct from the not-a-git-repo branch: cluster 4 split these
      // because the previous catch sent users in the wrong direction.
      // Prepend the node bin dir so spawnSync can still locate `node`
      // itself; that lookup uses the child's PATH.
      const fakeBin = makeFakeBin([]);
      const nodeBinDir = path.dirname(process.execPath);
      const result = runWithEnv(
        ["legate", "init", "--no-setup"],
        { PATH: `${nodeBinDir}${path.delimiter}${fakeBin}`, HOME: makeTmpDir() },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("git not found on PATH");
      expect(result.stderr).not.toContain("from inside a git repository");
    });
  });

  describe("march herald", () => {
    it("bare `march herald` exits 2 and prints the herald group help", () => {
      const result = run(["herald"]);
      expect(result.exitCode).toBe(2);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("Usage: march herald");
      // The help should list serve / events / state as known subcommands.
      expect(combined).toMatch(/^\s+serve\b/m);
      expect(combined).toMatch(/^\s+events\b/m);
      expect(combined).toMatch(/^\s+state\b/m);
    });

    it("`march herald serve --help` exits 0 and prints the serve flag surface", () => {
      const result = run(["herald", "serve", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: march herald serve");
      expect(result.stdout).toContain("--port");
      expect(result.stdout).toContain("--meta");
    });

    it("`march herald <bad>` reports the actual unknown subcommand, not 'herald'", () => {
      const result = run(["herald", "frobnicate"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("unknown command 'frobnicate'");
      expect(result.stderr).not.toContain("unknown command 'herald'");
      expect(result.stdout + result.stderr).toContain("Usage: march herald");
    });

    it("`march herald admin event --help` exits 0 and prints the admin-event flag surface (#265)", () => {
      const result = run(["herald", "admin", "event", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: march herald admin event");
      expect(result.stdout).toContain("--profile");
      expect(result.stdout).toContain("--type");
      expect(result.stdout).toContain("--slice-id");
      expect(result.stdout).toContain("--session-id");
      expect(result.stdout).toContain("--note");
    });

    it("`march herald admin event` fails fast on missing required flags, before any network (#265)", () => {
      const result = run(["herald", "admin", "event", "--yes"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/--profile is required/);
    });
  });

  describe("march castra", () => {
    it("bare `march castra` exits 2 and prints the castra group help", () => {
      const result = run(["castra"]);
      expect(result.exitCode).toBe(2);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("Usage: march castra");
      // The help should list serve as a known subcommand.
      expect(combined).toMatch(/^\s+serve\b/m);
    });

    it("`march castra <bad>` reports the actual unknown subcommand, not 'castra'", () => {
      const result = run(["castra", "frobnicate"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("unknown command 'frobnicate'");
      expect(result.stderr).not.toContain("unknown command 'castra'");
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("Usage: march castra");
    });

    it("`march castra serve --help` exits 0 and prints the serve flag surface", () => {
      const result = run(["castra", "serve", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: march castra serve");
      expect(result.stdout).toContain("--port");
      expect(result.stdout).toContain("--host");
      expect(result.stdout).toContain("--token");
    });

    it("`march castra serve` without agent-deck on PATH exits 1 with a clear message", () => {
      const fakeBin = makeFakeBin([]); // no agent-deck stub
      const nodeBinDir = path.dirname(process.execPath);
      const result = runWithEnv(
        ["castra", "serve"],
        { PATH: `${nodeBinDir}${path.delimiter}${fakeBin}`, HOME: makeTmpDir() },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("agent-deck not found on PATH");
    });
  });

  describe("march statio", () => {
    it("bare `march statio` exits 2 and prints the statio group help", () => {
      const result = run(["statio"]);
      expect(result.exitCode).toBe(2);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("Usage: march statio");
      expect(combined).toMatch(/^\s+serve\b/m);
    });

    it("`march statio serve --help` exits 0 and prints the serve flag surface", () => {
      const result = run(["statio", "serve", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: march statio serve");
      expect(result.stdout).toContain("--port");
      expect(result.stdout).toContain("--host");
      expect(result.stdout).toContain("--token");
    });

    it("`march statio serve` validates the configured port before startup", () => {
      const result = run(["statio", "serve", "--port", "9689x"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Invalid Statio port");
    });
  });

  it("march version exits 0 and stdout contains the package version", () => {
    const result = run(["version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(PKG_VERSION);
  });

  it("march version stdout is byte-for-byte identical to march --version stdout", () => {
    const versionSubcommand = run(["version"]);
    const versionFlag = run(["--version"]);
    expect(versionFlag.exitCode).toBe(0);
    expect(versionSubcommand.stdout).toBe(versionFlag.stdout);
  });

  it("march help exits 0 and stdout lists init, version, and help", () => {
    const result = run(["help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("version");
    expect(result.stdout).toContain("help");
  });

  it("march help stdout is byte-for-byte identical to march --help stdout", () => {
    const helpSubcommand = run(["help"]);
    const helpFlag = run(["--help"]);
    expect(helpFlag.exitCode).toBe(0);
    expect(helpSubcommand.stdout).toBe(helpFlag.stdout);
  });

  it("march quarantine park moves a test and records its origin without prompting", () => {
    const repoRoot = makeRealRepo();
    const origin = "src/example/quarantine-me.test.ts";
    const body = [
      "/* @scope unit @determinism deterministic @channel ci */",
      "import { describe, expect, it } from \"vitest\";",
      "describe(\"quarantine\", () => {",
      "  it(\"keeps the assertion\", () => {",
      "    expect(true).toBe(true);",
      "  });",
      "});",
      "",
    ].join("\n");
    fs.mkdirSync(path.join(repoRoot, "src/example"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, origin), body);

    // Run from a nested subdirectory to prove repo-relative paths resolve
    // from the git repository root, not the caller's working directory.
    const result = runWithEnv(
      ["quarantine", "park", origin],
      {},
      { cwd: path.join(repoRoot, "src/example") },
    );

    const quarantinedPath = path.join(
      repoRoot,
      "tests/quarantine/src/example/quarantine-me.test.ts",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Parked src/example/quarantine-me.test.ts at tests/quarantine/src/example/quarantine-me.test.ts.",
    );
    expect(fs.existsSync(path.join(repoRoot, origin))).toBe(false);
    expect(fs.readFileSync(quarantinedPath, "utf-8")).toBe(body);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(repoRoot, "tests/quarantine/.origins.json"), "utf-8"),
      ),
    ).toEqual({
      "tests/quarantine/src/example/quarantine-me.test.ts": origin,
    });
  });

  it("march help init exits 0 and stdout contains init-specific help text", () => {
    const result = run(["help", "init"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("init");
  });

  it("march help version exits 0 and stdout contains version-specific help text", () => {
    const result = run(["help", "version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("version");
  });

  it("march help nonexistent exits 2", () => {
    const result = run(["help", "nonexistent"]);
    expect(result.exitCode).toBe(2);
  });

  it("march init --help exits 0 and stdout contains init and its description", () => {
    const result = run(["init", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("Initialize");
  });

  it("march update --help exits 0 and stdout contains update", () => {
    const result = run(["update", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("update");
  });

  it("march version --help exits 0 and stdout contains version", () => {
    const result = run(["version", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("version");
  });

  it("march help --help exits 0 and stdout contains help", () => {
    const result = run(["help", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("help");
  });

  it("march spawn --help exits 0 and stdout contains spawn", () => {
    const result = run(["spawn", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("spawn");
  });

  it("march spawn dispatch --help lists backend selection and registered names", () => {
    const result = run(["spawn", "dispatch", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--backend <name>");
    expect(result.stdout).toContain("claude-code");
    expect(result.stdout).toContain("codex");
  });

  it("march hatchery spawn --help exits 0 and prints handoff flags", () => {
    const result = run(["hatchery", "spawn", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: march hatchery spawn");
    expect(result.stdout).toContain("--prompt");
    expect(result.stdout).toContain("--agent-deck-profile");
    expect(result.stdout).toContain("--manager-group");
    expect(result.stdout).toContain("--name");
    expect(result.stdout).toContain("--branch");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("default: codex");
  });

  // NOTE: `march hatchery spawn` is now a thin HTTP client for the hatchery
  // service (the agent-deck/docker prechecks and the spawn orchestration moved
  // server-side — see GET /readyz and src/hatchery/service/). The former
  // in-process orchestration tests (agent-deck-missing precheck, manager
  // launch/patch/handoff, record-write-failure prune, malformed-output persist)
  // now live in src/hatchery/service/serve-spawn.integration.test.ts, which
  // drives the real worker against the same agent-deck/docker stubs.

  // --- spawn dispatch dependency validation (Story 2 acceptance scenarios) ---

  it("spawn dispatch: git missing — exit 1, stderr contains 'git not found', no Docker error", () => {
    const fakeBin = makeFakeBin(); // which only, no git or docker
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["spawn", "dispatch"], {
      PATH: [nodeBinDir, fakeBin].join(path.delimiter),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("git not found");
    expect(result.stderr).not.toContain("Docker");
  });

  it("spawn dispatch: docker missing — exit 1, stderr contains 'Docker not found'", () => {
    const fakeBin = makeFakeBin(["git"]); // git only, no docker
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["spawn", "dispatch"], {
      PATH: [nodeBinDir, fakeBin].join(path.delimiter),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Docker not found");
  });

  it("spawn dispatch: not in a git repo — exit 1, stderr contains 'Not inside a git repository'", () => {
    // Smart git stub: fails on `rev-parse` (simulates being outside a repo),
    // succeeds for other git commands so isOnPath("git") passes.
    const tmpDir = makeTmpDir();
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(FINDER_PATH, path.join(binDir, path.basename(FINDER_PATH)));
    const gitStub = path.join(binDir, "git");
    fs.writeFileSync(
      gitStub,
      '#!/bin/sh\nif [ "$1" = "rev-parse" ]; then\n  exit 128\nfi\nexit 0\n',
    );
    fs.chmodSync(gitStub, 0o755);
    const dockerStub = path.join(binDir, "docker");
    fs.writeFileSync(dockerStub, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(dockerStub, 0o755);

    const nodeBinDir = path.dirname(process.execPath);
    // Create a temp dir outside any git repo.
    const nonRepoDir = makeTmpDir();
    const result = runWithEnv(
      ["spawn", "dispatch", "--prompt", "what is the capital of Washington state"],
      { PATH: [nodeBinDir, binDir].join(path.delimiter) },
      { cwd: nonRepoDir },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Not inside a git repository");
  });

  it("spawn dispatch: base image unavailable — exit 1, stderr identifies the image name", () => {
    // Docker stub that fails on `image inspect` and `pull` subcommands.
    const fakeBin = makeTmpDir();
    const binDir = path.join(fakeBin, "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(FINDER_PATH, path.join(binDir, path.basename(FINDER_PATH)));
    // Simple git stub.
    const gitStub = path.join(binDir, "git");
    fs.writeFileSync(gitStub, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(gitStub, 0o755);
    // Smart docker stub: fails on `image` and `pull`, succeeds otherwise.
    const dockerStub = path.join(binDir, "docker");
    fs.writeFileSync(
      dockerStub,
      '#!/bin/sh\nif [ "$1" = "image" ] || [ "$1" = "pull" ]; then\n  exit 1\nfi\nexit 0\n',
    );
    fs.chmodSync(dockerStub, 0o755);

    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["spawn", "dispatch"], {
      PATH: [nodeBinDir, binDir].join(path.delimiter),
      MARCH_BACKEND: "",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("march-spawn-claude:latest");
  });

  it("spawn dispatch: dependency validation checks the selected backend image", () => {
    const nodeBinDir = path.dirname(process.execPath);

    const claudeRepoRoot = makeRealRepo();
    const claudeHome = makeTmpDir();
    const claudeDockerLog = path.join(claudeHome, "docker-invocations.log");
    const claudeDockerStubDir = makeDockerStubBinDir(claudeDockerLog);
    const claudeResult = runWithEnv(
      ["spawn", "dispatch", "--backend", "claude-code"],
      {
        PATH: [nodeBinDir, claudeDockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: claudeHome,
      },
      { cwd: claudeRepoRoot },
    );
    expect(claudeResult.exitCode).toBe(2);
    const claudeInvocations = fs.readFileSync(claudeDockerLog, "utf-8");
    expect(claudeInvocations).toContain(
      "image inspect march-spawn-claude:latest",
    );
    expect(claudeInvocations).not.toContain("march-spawn-codex:latest");

    const codexRepoRoot = makeRealRepo();
    const codexHome = makeTmpDir();
    const codexDockerLog = path.join(codexHome, "docker-invocations.log");
    const codexDockerStubDir = makeDockerStubBinDir(codexDockerLog);
    const codexResult = runWithEnv(
      ["spawn", "dispatch", "--backend", "codex"],
      {
        PATH: [nodeBinDir, codexDockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: codexHome,
        CODEX_HOME: path.join(codexHome, "missing-codex-home"),
      },
      { cwd: codexRepoRoot },
    );
    expect(codexResult.exitCode).toBe(2);
    const codexInvocations = fs.readFileSync(codexDockerLog, "utf-8");
    expect(codexInvocations).toContain(
      "image inspect march-spawn-codex:latest",
    );
    expect(codexInvocations).not.toContain("march-spawn-claude:latest");
  });

  it("spawn dispatch: missing selected-backend env vars exit 2 after dependency validation and before artifacts", () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    const dockerLog = path.join(home, "docker-invocations.log");
    const dockerStubDir = makeDockerStubBinDir(dockerLog);
    const nodeBinDir = path.dirname(process.execPath);
    const secretPrefix = "sk-ant-secret-prefix";
    const result = runWithEnv(
      ["spawn", "dispatch", "--backend", "claude-code"],
      {
        PATH: [nodeBinDir, dockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: home,
        ANTHROPIC_API_KEY: "",
        UNUSED_SECRET: secretPrefix,
      },
      { cwd: repoRoot },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      'Backend "claude-code" requires ANTHROPIC_API_KEY: missing ANTHROPIC_API_KEY',
    );
    expect(result.stderr).not.toContain(secretPrefix);
    const dockerInvocations = fs.readFileSync(dockerLog, "utf-8");
    expect(dockerInvocations).toContain("image inspect march-spawn-claude:latest");
    expect(dockerInvocations).not.toContain("create ");
    const branches = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/march/spawn/"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    expect(branches.trim()).toBe("");
    expect(fs.existsSync(path.join(home, ".march", "spawns"))).toBe(false);
  });

  it("spawn dispatch: present selected-backend env vars pass auth pre-flight silently", () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    const dockerLog = path.join(home, "docker-invocations.log");
    const dockerStubDir = makeDockerStubBinDir(dockerLog);
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(
      ["spawn", "dispatch", "--backend", "claude-code"],
      {
        PATH: [nodeBinDir, dockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: home,
        ANTHROPIC_API_KEY: "test-key",
      },
      { cwd: repoRoot },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "march spawn dispatch requires --prompt <prompt>",
    );
    expect(result.stderr).not.toContain("requires ANTHROPIC_API_KEY");
    const dockerInvocations = fs.readFileSync(dockerLog, "utf-8");
    expect(dockerInvocations).toContain("image inspect march-spawn-claude:latest");
    expect(dockerInvocations).not.toContain("create ");
  });

  // --- spawn dispatch worktree + initial SpawnRecord (Story 3) ---

  /**
   * Initializes a real git repo in a fresh tmp dir and returns its
   * absolute path. The repo has a single committed file so HEAD is
   * resolvable and `git worktree add` has something to check out.
   *
   * The repo is nested one level inside a tmp parent so the worktree
   * sibling (`<parent>/worktrees/march/`) stays isolated per test.
   */
  function makeRealRepo(): string {
    const parent = makeTmpDir();
    const repoRoot = path.join(parent, "repo");
    fs.mkdirSync(repoRoot);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot, env });
    fs.writeFileSync(path.join(repoRoot, "README.md"), "hello\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoRoot, env });
    // Disable GPG signing explicitly so the test commit does not depend
    // on a signing key in the host environment.
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "initial"],
      { cwd: repoRoot, env },
    );
    return repoRoot;
  }

  /**
   * Builds a bin dir containing a smart docker stub (succeeds on `image
   * inspect`) plus a finder symlink, keeping the real git on PATH. The
   * bin dir comes first in PATH so the docker stub wins over any system
   * docker, while git is resolved by fall-through to the inherited PATH.
   *
   * The stub additionally prints {@link FAKE_CONTAINER_ID} to stdout when
   * invoked as `docker create`, emits a zero exit code for `docker wait`,
   * and emits a proof answer for `docker logs` so the lifecycle/output path
   * is exercisable end-to-end.
   */
  function makeDockerStubBinDir(invocationLog?: string): string {
    const binDir = path.join(makeTmpDir(), "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(FINDER_PATH, path.join(binDir, path.basename(FINDER_PATH)));
    const dockerStub = path.join(binDir, "docker");
    // Succeeds for every subcommand, including `image inspect`, `pull`,
    // and `build`, so checkSpawnDependencies' base-image check passes
    // and the snapshot/build stage in dispatch returns success. When
    // invoked as `docker create`, prints a deterministic 64-hex-char
    // container ID so createSpawnContainer's stdout capture has something
    // to trim and return.
    fs.writeFileSync(
      dockerStub,
      `#!/bin/sh\n${invocationLog ? `printf '%s\\n' "$*" >> "${invocationLog}"\n` : ""}if [ "$1" = "create" ]; then\n  echo "${FAKE_CONTAINER_ID}"\n  exit 0\nfi\nif [ "$1" = "wait" ]; then\n  echo "0"\n  exit 0\nfi\nif [ "$1" = "logs" ]; then\n  echo "The capital of Washington state is Olympia."\n  exit 0\nfi\nexit 0\n`,
    );
    fs.chmodSync(dockerStub, 0o755);
    return binDir;
  }

  /**
   * Builds a bin dir containing a docker stub that succeeds on every
   * subcommand EXCEPT `build` (which exits 1). Used to simulate a docker
   * build failure during dispatch so tests can exercise the Story 4
   * rollback path: SpawnRecord transitions to "failed" and is preserved
   * on disk while the worktree, branch, and any partially tagged image
   * are cleaned up.
   */
  function makeDockerBuildFailBinDir(): string {
    const binDir = path.join(makeTmpDir(), "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(FINDER_PATH, path.join(binDir, path.basename(FINDER_PATH)));
    const dockerStub = path.join(binDir, "docker");
    fs.writeFileSync(
      dockerStub,
      '#!/bin/sh\nif [ "$1" = "build" ]; then\n  echo "simulated build failure" >&2\n  exit 1\nfi\nexit 0\n',
    );
    fs.chmodSync(dockerStub, 0o755);
    return binDir;
  }

  /**
   * Builds a bin dir containing a docker stub that succeeds on every
   * subcommand EXCEPT `create` (which exits 1 with "simulated launch failure"
   * on stderr). Patterned after {@link makeDockerBuildFailBinDir} but
   * targets the Stage 4 launch boundary instead of Stage 3. `build` must
   * succeed because Stage 4 only runs after Stage 3's build has succeeded;
   * `rm -f` must also succeed so the rollback chain's removeSpawnContainer
   * call does not error out. Used by the launch-failure integration test
   * to exercise the dispatch's Stage-4 rollback path: SpawnRecord
   * transitions to "failed" and is preserved on disk while the container
   * (none — never started), image, worktree, and branch are cleaned up.
   */
  function makeDockerRunFailBinDir(): string {
    const binDir = path.join(makeTmpDir(), "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(FINDER_PATH, path.join(binDir, path.basename(FINDER_PATH)));
    const dockerStub = path.join(binDir, "docker");
    fs.writeFileSync(
      dockerStub,
      '#!/bin/sh\nif [ "$1" = "create" ]; then\n  echo "simulated launch failure" >&2\n  exit 1\nfi\nexit 0\n',
    );
    fs.chmodSync(dockerStub, 0o755);
    return binDir;
  }

  it("spawn dispatch: success path creates branch, worktree, and SpawnRecord", () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    const dockerStubDir = makeDockerStubBinDir();
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(
      ["spawn", "dispatch", "--prompt", "what is the capital of Washington state"],
      {
        // Docker stub first, then real PATH for git.
        PATH: [nodeBinDir, dockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: home,
        ANTHROPIC_API_KEY: "test-key",
      },
      { cwd: repoRoot },
    );

    // No dependency-validation errors on stderr.
    expect(result.stderr).not.toContain("not found");
    expect(result.stderr).not.toContain("Not inside a git repository");
    expect(result.stderr).not.toContain("march-spawn-claude:latest");
    // After Stage 4 lands, dispatch exits cleanly (exit 0) once the
    // container has launched and the SpawnRecord has transitioned to
    // "running". Stories 6–7 will extend dispatch from here without the
    // misleading "not yet implemented" placeholder reappearing — see
    // SD-005 in the US5 tasks file.
    expect(result.exitCode).toBe(0);

    // Exactly one march/spawn/* branch was created in the source repo.
    // `git branch --list` prefixes the current branch with "* " and any
    // branch checked out in a linked worktree with "+ ", so we use
    // for-each-ref for a clean machine-readable listing.
    const branches = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/march/spawn/"],
      { cwd: repoRoot, encoding: "utf-8" },
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(branches).toHaveLength(1);
    const branch = branches[0];
    expect(branch).toMatch(/^march\/spawn\/\d{8}-[0-9a-f]{6}$/);

    // Sibling worktree directory exists at <repo>/../worktrees/march/<id>.
    const spawnId = branch.replace("march/spawn/", "");
    const worktreePath = path.join(
      path.dirname(repoRoot),
      "worktrees",
      "march",
      spawnId,
    );
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, "README.md"))).toBe(true);

    // SpawnRecord file exists and validates against the data model for
    // the `"running"` state after Stage 4's create → running transition.
    const recordPath = path.join(
      home,
      ".march",
      "spawns",
      `${spawnId}.json`,
    );
    expect(fs.existsSync(recordPath)).toBe(true);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
    expect(record.version).toBe(1);
    expect(record.id).toBe(spawnId);
    expect(record.repoPath).toBe(repoRoot);
    expect(record.branch).toBe(branch);
    expect(record.worktreePath).toBe(worktreePath);
    expect(record.backend).toBe("claude-code");
    expect(record.status).toBe("stopped");
    expect(record.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(record.imageId).toBe(`march-spawn-${spawnId}`);
    expect(record.containerId).toBe(FAKE_CONTAINER_ID);
    expect(record.startedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(record.prompt).toBe("what is the capital of Washington state");
    expect(record.exitCode).toBe(0);
    expect(record.stoppedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(result.stdout).toContain("Olympia");
    expect(
      fs.readFileSync(
        path.join(home, ".march", "spawns", `${spawnId}.output.log`),
        "utf-8",
      ),
    ).toContain("Olympia");
  });

  it("spawn dispatch: unknown backend exits 2 before dependency checks", () => {
    const fakeBin = makeFakeBin(); // no git or docker needed
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["spawn", "dispatch", "--backend", "missing"], {
      PATH: [nodeBinDir, fakeBin].join(path.delimiter),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Unknown backend "missing"');
    expect(result.stderr).toContain("claude-code");
    expect(result.stderr).toContain("codex");
    expect(result.stderr).not.toContain("git not found");
  });

  it("spawn dispatch: unknown MARCH_BACKEND exits 2 before dependency checks", () => {
    const fakeBin = makeFakeBin(); // no git or docker needed
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["spawn", "dispatch"], {
      PATH: [nodeBinDir, fakeBin].join(path.delimiter),
      MARCH_BACKEND: "missing",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Unknown backend "missing"');
    expect(result.stderr).toContain("MARCH_BACKEND env var");
    expect(result.stderr).toContain("claude-code");
    expect(result.stderr).toContain("codex");
    expect(result.stderr).not.toContain("git not found");
  });

  it("spawn dispatch: Codex missing credential directory exits 2 and leaves no SpawnRecord", () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    const missingCodexHome = path.join(home, "missing-codex-home");
    const dockerStubDir = makeDockerStubBinDir();
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(
      ["spawn", "dispatch", "--backend", "codex"],
      {
        PATH: [nodeBinDir, dockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: home,
        CODEX_HOME: missingCodexHome,
      },
      { cwd: repoRoot },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      'Backend "codex" requires Codex credential directory: missing Codex credential directory',
    );
    expect(result.stderr).not.toContain(missingCodexHome);
    expect(result.stderr).not.toContain("CODEX_HOME");
    const branches = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/march/spawn/"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    expect(branches.trim()).toBe("");
    expect(fs.existsSync(path.join(home, ".march", "spawns"))).toBe(false);
  });

  it("spawn dispatch: --backend codex wins over MARCH_BACKEND and records codex", () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    const codexHome = path.join(home, "codex-home");
    fs.mkdirSync(codexHome);
    const dockerLog = path.join(home, "docker-invocations.log");
    const dockerStubDir = makeDockerStubBinDir(dockerLog);
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(
      [
        "spawn",
        "dispatch",
        "--backend",
        "codex",
        "--prompt",
        "what is the capital of Washington state",
      ],
      {
        PATH: [nodeBinDir, dockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: home,
        CODEX_HOME: codexHome,
        MARCH_BACKEND: "claude-code",
      },
      { cwd: repoRoot },
    );

    expect(result.exitCode).toBe(0);
    const spawnsDir = path.join(home, ".march", "spawns");
    const recordFiles = fs
      .readdirSync(spawnsDir)
      .filter((f) => f.endsWith(".json"));
    expect(recordFiles).toHaveLength(1);
    const record = JSON.parse(
      fs.readFileSync(path.join(spawnsDir, recordFiles[0]), "utf-8"),
    );
    expect(record.backend).toBe("codex");
    expect(record.status).toBe("stopped");
    expect(record.prompt).toBe("what is the capital of Washington state");
    expect(record.exitCode).toBe(0);
    expect(record.containerId).toBe(FAKE_CONTAINER_ID);
    expect(result.stdout).toContain("Olympia");

    const invocations = fs.readFileSync(dockerLog, "utf-8").trim().split("\n");
    const createIndex = invocations.findIndex((line) => line.startsWith("create "));
    const cpIndex = invocations.findIndex((line) => line.startsWith("cp "));
    const startIndex = invocations.findIndex((line) => line.startsWith("start "));
    const waitIndex = invocations.findIndex((line) => line.startsWith("wait "));
    const logsIndex = invocations.findIndex((line) => line.startsWith("logs "));
    expect(createIndex).toBeGreaterThan(-1);
    expect(cpIndex).toBeGreaterThan(createIndex);
    expect(startIndex).toBeGreaterThan(cpIndex);
    expect(waitIndex).toBeGreaterThan(startIndex);
    expect(logsIndex).toBeGreaterThan(waitIndex);
  });

  it("spawn dispatch: MARCH_BACKEND selects codex when --backend is absent", () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    const codexHome = path.join(home, "codex-home");
    fs.mkdirSync(codexHome);
    const dockerStubDir = makeDockerStubBinDir();
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(
      [
        "spawn",
        "dispatch",
        "--prompt",
        "what is the capital of Washington state",
      ],
      {
        PATH: [nodeBinDir, dockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: home,
        CODEX_HOME: codexHome,
        MARCH_BACKEND: "codex",
      },
      { cwd: repoRoot },
    );

    expect(result.exitCode).toBe(0);
    const spawnsDir = path.join(home, ".march", "spawns");
    const recordFiles = fs
      .readdirSync(spawnsDir)
      .filter((f) => f.endsWith(".json"));
    expect(recordFiles).toHaveLength(1);
    const record = JSON.parse(
      fs.readFileSync(path.join(spawnsDir, recordFiles[0]), "utf-8"),
    );
    expect(record.backend).toBe("codex");
    expect(record.status).toBe("stopped");
    expect(result.stdout).toContain("Olympia");
  });

  it("spawn dispatch: docker build failure transitions SpawnRecord to failed and cleans up worktree+branch+image", () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    // Docker stub that succeeds on `image inspect` / `pull` (so the
    // dependency check passes) but fails on `build` so the Story 4
    // snapshot+build stage exercises its failure path.
    const dockerStubDir = makeDockerBuildFailBinDir();
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(
      ["spawn", "dispatch", "--prompt", "simulate build failure"],
      {
        PATH: [nodeBinDir, dockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: home,
        ANTHROPIC_API_KEY: "test-key",
      },
      { cwd: repoRoot },
    );

    // Build failure → exit 1 with a clear stderr message surfacing the
    // docker stderr tail.
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    // End-to-end check that the docker stderr tail surfaces through
    // BuildError.message to the operator-facing stream — locks Task 2's
    // "message includes the docker stderr tail so operators can diagnose"
    // acceptance criterion as integration-tested.
    expect(result.stderr).toContain("simulated build failure");

    // No residual march/spawn/* branch — the rollback must delete it via
    // removeSpawnWorktree.
    const branches = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/march/spawn/"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    expect(branches.trim()).toBe("");

    // No residual worktree directory under <parent>/worktrees/march/.
    const worktreeParent = path.join(
      path.dirname(repoRoot),
      "worktrees",
      "march",
    );
    const leftover =
      fs.existsSync(worktreeParent) && fs.readdirSync(worktreeParent);
    expect(!leftover || leftover.length === 0).toBe(true);

    // The SpawnRecord file IS preserved on disk per the data-model
    // `created → failed` transition and the contracts' "stage 7 Record
    // runs unconditionally" rule. Status is "failed" and stoppedAt is
    // populated.
    const spawnsDir = path.join(home, ".march", "spawns");
    expect(fs.existsSync(spawnsDir)).toBe(true);
    const recordFiles = fs
      .readdirSync(spawnsDir)
      .filter((f) => f.endsWith(".json"));
    expect(recordFiles).toHaveLength(1);
    const record = JSON.parse(
      fs.readFileSync(path.join(spawnsDir, recordFiles[0]), "utf-8"),
    );
    expect(record.status).toBe("failed");
    expect(record.stoppedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    // The Story 3 fields the initial write populated must still be
    // intact on the failed record.
    expect(record.version).toBe(1);
    expect(record.id).toBe(recordFiles[0].replace(/\.json$/, ""));
    expect(record.repoPath).toBe(repoRoot);
    expect(record.branch).toBe(`march/spawn/${record.id}`);
    expect(record.backend).toBe("claude-code");
    // imageId must NOT be populated — the build failed before
    // updateSpawnRecordImageId ran.
    expect(record.imageId).toBeUndefined();
  });

  it("spawn dispatch: container launch failure transitions SpawnRecord to failed and cleans up image+worktree+branch", () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    // Docker stub that succeeds on every subcommand except `run` (so the
    // dependency check, snapshot/build, and the rollback's `rm -f` all
    // pass) and exits 1 with "simulated launch failure" on stderr when
    // the dispatch reaches Stage 4. Exercises the Stage 4 rollback path:
    // SpawnRecord transitions "created" → "failed" with stoppedAt
    // populated, the image/worktree/branch are cleaned up, and the
    // record file is preserved on disk for auditing per the contracts'
    // "stage 7 Record runs unconditionally" rule.
    const dockerStubDir = makeDockerRunFailBinDir();
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(
      ["spawn", "dispatch", "--prompt", "simulate launch failure"],
      {
        PATH: [nodeBinDir, dockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: home,
        ANTHROPIC_API_KEY: "test-key",
      },
      { cwd: repoRoot },
    );

    // Launch failure → exit 1 with the docker stderr tail surfacing
    // through LaunchError.message to the operator-facing stream.
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr).toContain("simulated launch failure");

    // No residual march/spawn/* branch — Stage 4 rollback must delete
    // the branch via removeSpawnWorktree.
    const branches = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/march/spawn/"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    expect(branches.trim()).toBe("");

    // No residual worktree directory under <parent>/worktrees/march/.
    const worktreeParent = path.join(
      path.dirname(repoRoot),
      "worktrees",
      "march",
    );
    const leftover =
      fs.existsSync(worktreeParent) && fs.readdirSync(worktreeParent);
    expect(!leftover || leftover.length === 0).toBe(true);

    // SpawnRecord file is preserved on disk per the data-model
    // `created → failed` transition and the contracts' "stage 7 Record
    // runs unconditionally" rule. Status is "failed" and stoppedAt is
    // populated.
    const spawnsDir = path.join(home, ".march", "spawns");
    expect(fs.existsSync(spawnsDir)).toBe(true);
    const recordFiles = fs
      .readdirSync(spawnsDir)
      .filter((f) => f.endsWith(".json"));
    expect(recordFiles).toHaveLength(1);
    const record = JSON.parse(
      fs.readFileSync(path.join(spawnsDir, recordFiles[0]), "utf-8"),
    );
    expect(record.status).toBe("failed");
    expect(record.stoppedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    // Stages 1–3 fields the initial write + Stage 3 imageId update
    // populated must still be intact on the failed record.
    expect(record.version).toBe(1);
    expect(record.id).toBe(recordFiles[0].replace(/\.json$/, ""));
    expect(record.repoPath).toBe(repoRoot);
    expect(record.branch).toBe(`march/spawn/${record.id}`);
    expect(record.backend).toBe("claude-code");
    // imageId IS populated — Stage 3 succeeded; only Stage 4 (launch)
    // failed in this scenario.
    expect(record.imageId).toBe(`march-spawn-${record.id}`);
    // containerId / startedAt remain absent — the docker stub exited 1
    // before producing a container ID, so launchSpawnContainer threw
    // before markSpawnRecordRunning could populate either field.
    expect(record.containerId).toBeUndefined();
    expect(record.startedAt).toBeUndefined();
  });

  it("spawn dispatch: worktree creation failure rolls back branch and leaves no SpawnRecord", () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    const dockerStubDir = makeDockerStubBinDir();
    const nodeBinDir = path.dirname(process.execPath);

    // Force `git worktree add` to fail AFTER creating the branch by
    // installing a post-checkout hook that always exits 1. Per git's
    // documented behavior the hook's exit status becomes the operation's
    // exit status, so this is a permission-independent way to exercise
    // the rollback path (important when tests run as root).
    const hookPath = path.join(repoRoot, ".git", "hooks", "post-checkout");
    fs.writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(hookPath, 0o755);

    const result = runWithEnv(
      ["spawn", "dispatch", "--prompt", "simulate worktree failure"],
      {
        PATH: [nodeBinDir, dockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: home,
        ANTHROPIC_API_KEY: "test-key",
      },
      { cwd: repoRoot },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);

    // No residual march/spawn/* branch (ref should be rolled back).
    const branches = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/march/spawn/"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    expect(branches.trim()).toBe("");

    // No residual worktree directory under <parent>/worktrees/march/.
    const worktreeParent = path.join(
      path.dirname(repoRoot),
      "worktrees",
      "march",
    );
    const leftover =
      fs.existsSync(worktreeParent) && fs.readdirSync(worktreeParent);
    expect(!leftover || leftover.length === 0).toBe(true);

    // No SpawnRecord file in the isolated HOME.
    const spawnsDir = path.join(home, ".march", "spawns");
    const hasAnyRecord =
      fs.existsSync(spawnsDir) &&
      fs.readdirSync(spawnsDir).some((f) => f.endsWith(".json"));
    expect(hasAnyRecord).toBe(false);
  });

  it("spawn dispatch: SpawnRecord write failure rolls back worktree and branch", () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    // Pre-create `<home>/.march` as a regular file so writing the record
    // under `<home>/.march/spawns/` fails (ENOTDIR on mkdir), while the
    // worktree step — which runs first — succeeds.
    fs.writeFileSync(path.join(home, ".march"), "not a dir");

    const dockerStubDir = makeDockerStubBinDir();
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(
      ["spawn", "dispatch", "--prompt", "simulate record failure"],
      {
        PATH: [nodeBinDir, dockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: home,
        ANTHROPIC_API_KEY: "test-key",
      },
      { cwd: repoRoot },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);

    // No residual march/spawn/* branch — record-write failure rolls back
    // the worktree and branch.
    const branches = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/march/spawn/"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    expect(branches.trim()).toBe("");

    // No sibling worktree directory either.
    const worktreeParent = path.join(
      path.dirname(repoRoot),
      "worktrees",
      "march",
    );
    const leftover =
      fs.existsSync(worktreeParent) && fs.readdirSync(worktreeParent);
    expect(!leftover || leftover.length === 0).toBe(true);
  });
});
