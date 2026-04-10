import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
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

function runWithEnv(
  args: string[],
  env: Record<string, string | undefined>,
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
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

  it("all 3 skill files exist at expected paths after init", () => {
    const tmpDir = makeTmpDir();
    const result = runWithHome(["init"], tmpDir);

    expect(result.exitCode).toBe(0);

    const expectedFiles = [
      path.join(tmpDir, ".claude", "commands", "march.spawn-dispatch.md"),
      path.join(tmpDir, ".claude", "commands", "march.spawn-status.md"),
      path.join(tmpDir, ".claude", "prompts", "march.output-handling.md"),
    ];
    for (const filePath of expectedFiles) {
      expect(fs.existsSync(filePath), `Expected ${filePath} to exist`).toBe(true);
    }
  });

  it("all deployed skill files are valid markdown", () => {
    const tmpDir = makeTmpDir();
    runWithHome(["init"], tmpDir);

    const skillFiles = [
      path.join(tmpDir, ".claude", "commands", "march.spawn-dispatch.md"),
      path.join(tmpDir, ".claude", "commands", "march.spawn-status.md"),
      path.join(tmpDir, ".claude", "prompts", "march.output-handling.md"),
    ];
    for (const filePath of skillFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toMatch(/^#\s+/m);
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it("~/.claude/commands and ~/.claude/prompts are created if absent", () => {
    const tmpDir = makeTmpDir();
    runWithHome(["init"], tmpDir);

    expect(fs.existsSync(path.join(tmpDir, ".claude", "commands"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".claude", "prompts"))).toBe(true);
  });

  it("all deployed filenames start with march.", () => {
    const tmpDir = makeTmpDir();
    runWithHome(["init"], tmpDir);

    const manifestPath = path.join(tmpDir, ".march", "march-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    for (const filePath of manifest.files.claude as string[]) {
      const filename = path.basename(filePath);
      expect(filename).toMatch(/^march\./);
    }
  });

  it("manifest files.claude paths use no leading ~/ prefix", () => {
    const tmpDir = makeTmpDir();
    runWithHome(["init"], tmpDir);

    const manifestPath = path.join(tmpDir, ".march", "march-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    for (const filePath of manifest.files.claude as string[]) {
      expect(filePath).not.toMatch(/^~\//);
      expect(filePath).not.toMatch(/^\//);
    }
  });

  it("success message lists deployed skill files", () => {
    const tmpDir = makeTmpDir();
    const result = runWithHome(["init"], tmpDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("march.spawn-dispatch.md");
    expect(result.stdout).toContain("march.spawn-status.md");
    expect(result.stdout).toContain("march.output-handling.md");
  });

  it("prints git warning to stderr when git is not on PATH", () => {
    const tmpDir = makeTmpDir();
    // Use a minimal PATH that has node but not git or docker
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["init"], {
      HOME: tmpDir,
      PATH: nodeBinDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("git not found");
  });

  it("prints docker warning to stderr when docker is not on PATH", () => {
    const tmpDir = makeTmpDir();
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["init"], {
      HOME: tmpDir,
      PATH: nodeBinDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Docker not found");
  });

  it("exits 0 even when dependency warnings are present", () => {
    const tmpDir = makeTmpDir();
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["init"], {
      HOME: tmpDir,
      PATH: nodeBinDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("initialized successfully");
  });

  it("no warnings on stderr when both git and docker are on PATH", () => {
    const tmpDir = makeTmpDir();
    const result = runWithEnv(["init"], {
      ...process.env,
      HOME: tmpDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("git not found");
    expect(result.stderr).not.toContain("Docker not found");
  });
});
