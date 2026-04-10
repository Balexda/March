import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dirname, "../dist/cli.js");

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout: string; stderr: string; status: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
  }
}

describe("march CLI", () => {
  it("march init prints stub message and exits 1", () => {
    const result = run(["init"]);
    expect(result.stdout).toContain("not yet implemented");
    expect(result.exitCode).toBe(1);
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
});
