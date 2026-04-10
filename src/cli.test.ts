import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI_PATH = resolve(import.meta.dirname, "../dist/cli.js");

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
    expect(result.stdout + result.stderr).toMatch(/usage|Usage/i);
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
});
