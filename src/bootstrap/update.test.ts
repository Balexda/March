import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const _require = createRequire(import.meta.url);
const PKG_VERSION: string = (
  _require("../../package.json") as { version: string }
).version;

const CLI_PATH = resolve(import.meta.dirname, "../../dist/cli.js");

function runWithHome(
  args: string[],
  homeDir: string,
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("march update", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-update-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
    tmpDirs.length = 0;
  });

  /**
   * Helper to write a manifest file at the standard location within the
   * given home directory.
   */
  function writeManifest(homeDir: string, content: string): void {
    const marchDir = path.join(homeDir, ".march");
    fs.mkdirSync(marchDir, { recursive: true });
    fs.writeFileSync(path.join(marchDir, "march-manifest.json"), content);
  }

  it("no manifest → exits 1 with 'march init' message", () => {
    const tmpDir = makeTmpDir();
    const result = runWithHome(["update"], tmpDir);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("march init");
  });

  it("corrupted JSON → exits 1 with corruption message", () => {
    const tmpDir = makeTmpDir();
    writeManifest(tmpDir, "not valid json {{{");

    const result = runWithHome(["update"], tmpDir);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/[Cc]orrupt/);
  });

  it("valid JSON, invalid manifest shape → exits 1 with corruption message", () => {
    const tmpDir = makeTmpDir();
    writeManifest(tmpDir, JSON.stringify({ hello: "world" }));

    const result = runWithHome(["update"], tmpDir);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/[Cc]orrupt/);
  });

  it("manifest with non-array files.claude → exits 1 with corruption message", () => {
    const tmpDir = makeTmpDir();
    writeManifest(
      tmpDir,
      JSON.stringify({
        version: 1,
        marchVersion: "0.0.1",
        deployLocation: "user",
        agents: ["claude"],
        files: { claude: "bad" },
      }),
    );

    const result = runWithHome(["update"], tmpDir);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/[Cc]orrupt/);
  });

  it("same version → exits 0 with 'already up to date'", () => {
    const tmpDir = makeTmpDir();
    writeManifest(
      tmpDir,
      JSON.stringify({
        version: 1,
        marchVersion: PKG_VERSION,
        deployLocation: "user",
        agents: ["claude"],
        files: { claude: [] },
      }),
    );

    const result = runWithHome(["update"], tmpDir);

    expect(result.exitCode).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/already up to date/i);
  });

  it("prerelease version in manifest → exits 1 with version format error", () => {
    const tmpDir = makeTmpDir();
    writeManifest(
      tmpDir,
      JSON.stringify({
        version: 1,
        marchVersion: "0.1.0-beta.1",
        deployLocation: "user",
        agents: ["claude"],
        files: { claude: [] },
      }),
    );

    const result = runWithHome(["update"], tmpDir);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/MAJOR\.MINOR\.PATCH/);
  });

  it("downgrade detected without --yes → returns downgrade warning without file changes", () => {
    const tmpDir = makeTmpDir();
    // Set up a manifest claiming a newer version than the CLI
    writeManifest(
      tmpDir,
      JSON.stringify({
        version: 1,
        marchVersion: "9.9.9",
        deployLocation: "user",
        agents: ["claude"],
        files: { claude: [] },
      }),
    );

    const result = runWithHome(["update"], tmpDir);

    expect(result.exitCode).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/[Dd]owngrade/);

    // Verify the manifest was NOT rewritten (still says 9.9.9)
    const manifestPath = path.join(tmpDir, ".march", "march-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest.marchVersion).toBe("9.9.9");
  });

  it("upgrade deploys new skill files and rewrites manifest", () => {
    const tmpDir = makeTmpDir();
    // Manifest at an older version (0.0.1 < 0.1.0)
    writeManifest(
      tmpDir,
      JSON.stringify({
        version: 1,
        marchVersion: "0.0.1",
        deployLocation: "user",
        agents: ["claude"],
        files: { claude: [] },
      }),
    );

    const result = runWithHome(["update"], tmpDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("updated successfully");

    // Manifest marchVersion should now be the current CLI version
    const manifestPath = path.join(tmpDir, ".march", "march-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest.marchVersion).toBe(PKG_VERSION);
    expect(manifest.files.claude).toHaveLength(3);
  });

  it("all 3 skill files exist at expected paths after upgrade", () => {
    const tmpDir = makeTmpDir();
    writeManifest(
      tmpDir,
      JSON.stringify({
        version: 1,
        marchVersion: "0.0.1",
        deployLocation: "user",
        agents: ["claude"],
        files: { claude: [] },
      }),
    );

    runWithHome(["update"], tmpDir);

    const expectedFiles = [
      path.join(tmpDir, ".claude", "commands", "march.spawn-dispatch.md"),
      path.join(tmpDir, ".claude", "commands", "march.spawn-status.md"),
      path.join(tmpDir, ".claude", "prompts", "march.output-handling.md"),
    ];
    for (const filePath of expectedFiles) {
      expect(fs.existsSync(filePath), `Expected ${filePath} to exist`).toBe(true);
    }
  });

  it("stale manifest-tracked file is removed during upgrade", () => {
    const tmpDir = makeTmpDir();
    // Write a stale skill file that was tracked in a previous manifest
    const staleDir = path.join(tmpDir, ".claude", "commands");
    fs.mkdirSync(staleDir, { recursive: true });
    const staleFile = path.join(staleDir, "march.old-skill.md");
    fs.writeFileSync(staleFile, "# Old Skill\n");

    writeManifest(
      tmpDir,
      JSON.stringify({
        version: 1,
        marchVersion: "0.0.1",
        deployLocation: "user",
        agents: ["claude"],
        files: { claude: [".claude/commands/march.old-skill.md"] },
      }),
    );

    const result = runWithHome(["update"], tmpDir);

    expect(result.exitCode).toBe(0);
    // Stale file should be removed
    expect(fs.existsSync(staleFile)).toBe(false);
  });

  it("untracked user file is preserved during upgrade", () => {
    const tmpDir = makeTmpDir();
    // Write a user file that was never tracked in the manifest
    const userDir = path.join(tmpDir, ".claude", "commands");
    fs.mkdirSync(userDir, { recursive: true });
    const userFile = path.join(userDir, "my-custom-command.md");
    fs.writeFileSync(userFile, "# My Custom Command\n");

    writeManifest(
      tmpDir,
      JSON.stringify({
        version: 1,
        marchVersion: "0.0.1",
        deployLocation: "user",
        agents: ["claude"],
        // Note: my-custom-command.md is NOT in the manifest
        files: { claude: [] },
      }),
    );

    runWithHome(["update"], tmpDir);

    // User's custom file must still be there
    expect(fs.existsSync(userFile)).toBe(true);
  });

  it("stale file already absent (ENOENT) is tolerated during upgrade", () => {
    const tmpDir = makeTmpDir();
    // Manifest claims a stale file, but the file doesn't actually exist on disk
    writeManifest(
      tmpDir,
      JSON.stringify({
        version: 1,
        marchVersion: "0.0.1",
        deployLocation: "user",
        agents: ["claude"],
        files: { claude: [".claude/commands/march.already-gone.md"] },
      }),
    );

    const result = runWithHome(["update"], tmpDir);

    // Should succeed despite the ENOENT on the stale file
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("updated successfully");
  });

  it("downgrade with --yes bypasses prompt and performs the downgrade", () => {
    const tmpDir = makeTmpDir();
    writeManifest(
      tmpDir,
      JSON.stringify({
        version: 1,
        marchVersion: "9.9.9",
        deployLocation: "user",
        agents: ["claude"],
        files: { claude: [] },
      }),
    );

    // --yes is a top-level flag, must appear before the subcommand
    const result = runWithHome(["--yes", "update"], tmpDir);

    expect(result.exitCode).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/[Dd]owngrade/);

    // Manifest should now be rewritten to the CLI version
    const manifestPath = path.join(tmpDir, ".march", "march-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest.marchVersion).toBe(PKG_VERSION);
  });

  it("downgrade without --yes in non-TTY environment prints --yes instruction and exits 0", () => {
    const tmpDir = makeTmpDir();
    writeManifest(
      tmpDir,
      JSON.stringify({
        version: 1,
        marchVersion: "9.9.9",
        deployLocation: "user",
        agents: ["claude"],
        files: { claude: [] },
      }),
    );

    // spawnSync (used by runWithHome) pipes stdin, making it non-TTY
    const result = runWithHome(["update"], tmpDir);

    expect(result.exitCode).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/[Dd]owngrade/);
    expect(output).toContain("--yes");

    // Manifest must NOT have been rewritten
    const manifestPath = path.join(tmpDir, ".march", "march-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest.marchVersion).toBe("9.9.9");
  });

  it("tampered manifest with path-traversal entry → exits 1 without touching victim file", () => {
    const tmpDir = makeTmpDir();
    // Place a file outside the .claude/ tree that the traversal would target
    const victimFile = path.join(tmpDir, "victim.txt");
    fs.writeFileSync(victimFile, "important data\n");

    writeManifest(
      tmpDir,
      JSON.stringify({
        version: 1,
        marchVersion: "0.0.1",
        deployLocation: "user",
        agents: ["claude"],
        // ".claude/../victim.txt" resolves to ~/victim.txt — outside .claude/
        files: { claude: [".claude/../victim.txt"] },
      }),
    );

    const result = runWithHome(["update"], tmpDir);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/tampered|corrupted/i);
    // Victim file must still exist — the update must not have touched it
    expect(fs.existsSync(victimFile)).toBe(true);
  });

  it("update command appears in march help output", () => {
    const tmpDir = makeTmpDir();
    const result = runWithHome(["help"], tmpDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("update");
  });
});
