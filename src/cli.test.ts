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
  ): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
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
    // AS 4.1: no-args output lists all five registered commands (two-tier listing)
    for (const cmd of ["init", "update", "help", "version", "spawn"]) {
      expect(combined).toContain(cmd);
    }
  });

  it("march with unrecognized command exits 2", () => {
    const result = run(["nonexistent"]);
    expect(result.exitCode).toBe(2);
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

  it("march init --help exits 0", () => {
    const result = run(["init", "--help"]);
    expect(result.exitCode).toBe(0);
  });

  // --- spawn command integration tests ---

  it("march spawn with git missing exits 1, stderr mentions git, no stub message on stdout", () => {
    const fakeBin = makeFakeBin(); // which only, no git
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["spawn"], {
      PATH: [nodeBinDir, fakeBin].join(path.delimiter),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("git");
    expect(result.stdout).not.toContain("not yet implemented");
  });

  it("march spawn with git present exits 1 with stub message on stdout", () => {
    const fakeBin = makeFakeBin(["git"]);
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["spawn"], {
      PATH: [nodeBinDir, fakeBin].join(path.delimiter),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "march spawn is not yet implemented",
    );
    expect(result.stderr).not.toContain("git");
  });

  it("march spawn dispatch with git present behaves same as bare spawn", () => {
    const fakeBin = makeFakeBin(["git"]);
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["spawn", "dispatch"], {
      PATH: [nodeBinDir, fakeBin].join(path.delimiter),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "march spawn is not yet implemented",
    );
  });

  it("march spawn dispatch with git missing behaves same as bare spawn", () => {
    const fakeBin = makeFakeBin(); // which only, no git
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["spawn", "dispatch"], {
      PATH: [nodeBinDir, fakeBin].join(path.delimiter),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("git");
    expect(result.stdout).not.toContain("not yet implemented");
  });
});
