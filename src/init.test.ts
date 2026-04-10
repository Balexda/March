import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI_PATH = resolve(import.meta.dirname, "../dist/cli.js");

function runWithHome(
  args: string[],
  homeDir: string,
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: homeDir },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout: string; stderr: string; status: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

describe("march init", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        // Ensure all subdirectories are writable before cleanup
        restorePermissions(dir);
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
    tmpDirs.length = 0;
  });

  function restorePermissions(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          try {
            fs.chmodSync(fullPath, 0o755);
          } catch {
            // ignore
          }
          restorePermissions(fullPath);
        }
      }
    } catch {
      // ignore
    }
  }

  it("clean install creates manifest with correct schema and field values", () => {
    const tmpDir = makeTmpDir();
    const result = runWithHome(["init"], tmpDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("initialized successfully");

    const manifestPath = path.join(tmpDir, ".march", "march-manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest.version).toBe(1);
    expect(manifest.marchVersion).toBe("0.1.0");
    expect(manifest.deployLocation).toBe("user");
    expect(manifest.agents).toEqual(["claude"]);
    expect(manifest.files.claude).toHaveLength(3);
    expect(manifest.files.claude).toEqual([
      ".claude/commands/march.spawn-dispatch.md",
      ".claude/commands/march.spawn-status.md",
      ".claude/prompts/march.output-handling.md",
    ]);
  });

  it("already-installed guard triggers on existing valid manifest", () => {
    const tmpDir = makeTmpDir();
    const marchDir = path.join(tmpDir, ".march");
    fs.mkdirSync(marchDir, { recursive: true });
    fs.writeFileSync(
      path.join(marchDir, "march-manifest.json"),
      JSON.stringify({
        version: 1,
        marchVersion: "0.1.0",
        deployLocation: "user",
        agents: ["claude"],
        files: { claude: [] },
      }),
    );

    const result = runWithHome(["init"], tmpDir);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("already installed");
    expect(output).toContain("march update");
  });

  it("corrupted manifest detected exits 1 with warning", () => {
    const tmpDir = makeTmpDir();
    const marchDir = path.join(tmpDir, ".march");
    fs.mkdirSync(marchDir, { recursive: true });
    fs.writeFileSync(
      path.join(marchDir, "march-manifest.json"),
      "not json {{{}}",
    );

    const result = runWithHome(["init"], tmpDir);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/[Cc]orrupted/);
    expect(output).toMatch(/invalid JSON/i);
  });

  it("valid JSON but invalid manifest shape is treated as corrupted", () => {
    const tmpDir = makeTmpDir();
    const marchDir = path.join(tmpDir, ".march");
    fs.mkdirSync(marchDir, { recursive: true });
    fs.writeFileSync(
      path.join(marchDir, "march-manifest.json"),
      JSON.stringify({ hello: "world" }),
    );

    const result = runWithHome(["init"], tmpDir);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/[Cc]orrupted/);
    expect(output).toMatch(/not a valid March manifest/i);
  });

  it("unwritable directory fails with clear error", () => {
    const tmpDir = makeTmpDir();
    // Place a regular file where the .march directory should be created.
    // This causes mkdir to fail even when running as root (uid 0),
    // where chmod-based permission tests are bypassed.
    fs.writeFileSync(path.join(tmpDir, ".march"), "blocker");

    const result = runWithHome(["init"], tmpDir);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/[Cc]annot create directory/);
  });
});
