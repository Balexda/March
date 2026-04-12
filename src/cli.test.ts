import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FINDER_BIN } from "./deps.js";

const CLI_PATH = resolve(import.meta.dirname, "../dist/cli.js");

// Absolute path to the finder binary (which on Unix, where on Windows) —
// used to build isolated test PATHs.
const FINDER_PATH = execFileSync(FINDER_BIN, [FINDER_BIN], {
  encoding: "utf-8",
}).trim();

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
    for (const cmd of ["init", "update", "help", "version", "spawn"]) {
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

  it("march --version prints 0.1.0", () => {
    const result = run(["--version"]);
    expect(result.stdout).toContain("0.1.0");
  });

  it("march version exits 0 and stdout contains the package version", () => {
    const result = run(["version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("0.1.0");
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
      ["spawn", "dispatch"],
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
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("march-base:latest");
  });

  it("spawn dispatch: all dependencies present — no dependency error on stderr", () => {
    // Docker stub that succeeds for everything (including image inspect).
    const fakeBin = makeFakeBin(["git", "docker"]);
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["spawn", "dispatch"], {
      PATH: [nodeBinDir, fakeBin].join(path.delimiter),
    });
    // Dispatch proceeds past validation — no dependency error on stderr.
    expect(result.stderr).not.toContain("not found");
    expect(result.stderr).not.toContain("Not inside a git repository");
    expect(result.stderr).not.toContain("march-base:latest");
    // Validation passed and control reached the placeholder stub: exit 1
    // with the "not yet implemented" message on stdout. Asserting the exit
    // code and stub message ensures regressions in the happy path (e.g., the
    // CLI bailing out before reaching the spawn handler) are caught.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("march spawn is not yet implemented");
  });
});
