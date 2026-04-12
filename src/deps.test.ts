import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { FINDER_BIN } from "./deps.js";
import {
  isOnPath,
  isFinderAvailable,
  checkSpawnDependencies,
  INIT_DEPENDENCIES,
} from "./deps.js";

describe("INIT_DEPENDENCIES", () => {
  it("has exactly 2 entries: git and docker", () => {
    expect(INIT_DEPENDENCIES).toHaveLength(2);
    expect(INIT_DEPENDENCIES[0].name).toBe("git");
    expect(INIT_DEPENDENCIES[1].name).toBe("docker");
  });

  it("each entry has a name and warning string", () => {
    for (const dep of INIT_DEPENDENCIES) {
      expect(typeof dep.name).toBe("string");
      expect(dep.name.length).toBeGreaterThan(0);
      expect(typeof dep.warning).toBe("string");
      expect(dep.warning.length).toBeGreaterThan(0);
    }
  });
});

describe("isOnPath", () => {
  it('returns true for "node" when its directory is on PATH', () => {
    // Node can be invoked via an absolute path even when its directory is not
    // on PATH, so we explicitly prepend process.execPath's directory to ensure
    // this assertion is deterministic rather than environment-dependent.
    const originalPath = process.env.PATH;
    process.env.PATH = [path.dirname(process.execPath), originalPath ?? ""].join(
      path.delimiter,
    );
    try {
      expect(isOnPath("node")).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("returns false for a binary that definitely does not exist", () => {
    expect(isOnPath("definitely-not-a-real-binary-abc123")).toBe(false);
  });

  it("returns false for common tools when PATH is empty", () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      expect(isOnPath("node")).toBe(false);
      expect(isOnPath("git")).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("returns false for common tools when PATH is only /tmp", () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "/tmp";
      expect(isOnPath("node")).toBe(false);
      expect(isOnPath("git")).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("isFinderAvailable", () => {
  it("returns true in the normal test environment (which is on PATH)", () => {
    expect(isFinderAvailable()).toBe(true);
  });

  it("returns false when PATH is empty", () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      expect(isFinderAvailable()).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("returns false when PATH contains only /tmp (no which there)", () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "/tmp";
      expect(isFinderAvailable()).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("finds the finder binary when it has a PATHEXT extension (win32 simulation)", () => {
    // Simulate the Windows scenario: the binary on disk has an extension
    // (e.g., where.exe) and PATHEXT tells the shell to try that suffix.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "march-pathext-"));
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir);
    // Create a file named <FINDER_BIN>.exe (e.g., which.exe or where.exe).
    const withExt = path.join(binDir, FINDER_BIN + ".exe");
    fs.writeFileSync(withExt, "");

    const originalPath = process.env.PATH;
    const originalPathExt = process.env.PATHEXT;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      // Point PATH only at our bin dir and pretend we are on win32.
      process.env.PATH = binDir;
      process.env.PATHEXT = ".EXE";
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(isFinderAvailable()).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      process.env.PATHEXT = originalPathExt;
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// Absolute path to the finder binary (which on Unix, where on Windows) —
// used to build isolated PATH environments for unit tests.
const FINDER_PATH = execFileSync(FINDER_BIN, [FINDER_BIN], {
  encoding: "utf-8",
}).trim();

describe("checkSpawnDependencies", () => {
  /**
   * Creates a temporary directory containing a symlink to `which` and optional
   * stub executables. Callers must clean up via the returned path.
   *
   * When `stubScripts` is provided, it maps executable names to custom shell
   * script bodies (overriding the default `exit 0` stub).
   */
  function makeFakeBin(
    stubs: string[] = [],
    stubScripts: Record<string, string> = {},
  ): string {
    const fakeBin = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "march-deps-test-")),
      "bin",
    );
    fs.mkdirSync(fakeBin);
    // Symlink the finder binary so isFinderAvailable() returns true.
    fs.symlinkSync(FINDER_PATH, path.join(fakeBin, path.basename(FINDER_PATH)));
    for (const name of stubs) {
      const stub = path.join(fakeBin, name);
      const script = stubScripts[name] ?? "#!/bin/sh\nexit 0\n";
      fs.writeFileSync(stub, script);
      fs.chmodSync(stub, 0o755);
    }
    return fakeBin;
  }

  const TEST_BASE_IMAGE = "march-base:latest";

  it("returns ok:true when all dependencies are present and inside a git repo", () => {
    const originalPath = process.env.PATH;
    const fakeBin = makeFakeBin(["git", "docker"]);
    const nodeBinDir = path.dirname(process.execPath);
    try {
      process.env.PATH = [nodeBinDir, fakeBin].join(path.delimiter);
      // The test runs inside the March repo, so repo-context check passes.
      // The docker stub exits 0 for all subcommands (including image inspect).
      const result = checkSpawnDependencies(TEST_BASE_IMAGE);
      expect(result.ok).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(path.dirname(fakeBin), { recursive: true, force: true });
    }
  });

  it("returns ok:false with spec-exact git error when git is not on PATH", () => {
    const originalPath = process.env.PATH;
    const fakeBin = makeFakeBin(); // no git stub
    const nodeBinDir = path.dirname(process.execPath);
    try {
      process.env.PATH = [nodeBinDir, fakeBin].join(path.delimiter);
      const result = checkSpawnDependencies(TEST_BASE_IMAGE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          "git not found \u2014 required for spawn operations",
        );
      }
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(path.dirname(fakeBin), { recursive: true, force: true });
    }
  });

  it("returns ok:false with path-search utility error when finder is unavailable", () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      const result = checkSpawnDependencies(TEST_BASE_IMAGE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("path-search utility");
      }
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("returns ok:false with error containing 'Docker' when docker is not on PATH", () => {
    const originalPath = process.env.PATH;
    const fakeBin = makeFakeBin(["git"]); // git only, no docker
    const nodeBinDir = path.dirname(process.execPath);
    try {
      process.env.PATH = [nodeBinDir, fakeBin].join(path.delimiter);
      const result = checkSpawnDependencies(TEST_BASE_IMAGE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Docker");
        expect(result.error).toBe(
          "Docker not found \u2014 required for spawn operations",
        );
      }
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(path.dirname(fakeBin), { recursive: true, force: true });
    }
  });

  it("returns ok:false with error containing 'git repository' when not in a repo", () => {
    const originalPath = process.env.PATH;
    const originalCwd = process.cwd();
    // Use real git so that `git rev-parse --show-toplevel` actually fails in a
    // non-repo directory. Stub only docker.
    const fakeBin = makeFakeBin(["docker"]);
    const nodeBinDir = path.dirname(process.execPath);
    // Create a temp dir that is definitely not inside a git repo.
    const nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "march-no-repo-"));
    try {
      // Include the real PATH so that the real git binary is available.
      process.env.PATH = [
        nodeBinDir,
        fakeBin,
        originalPath ?? "",
      ].join(path.delimiter);
      process.chdir(nonRepoDir);
      const result = checkSpawnDependencies(TEST_BASE_IMAGE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("git repository");
      }
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
      fs.rmSync(path.dirname(fakeBin), { recursive: true, force: true });
      fs.rmSync(nonRepoDir, { recursive: true, force: true });
    }
  });

  it("returns ok:false with error containing the image name when base image is unavailable", () => {
    const originalPath = process.env.PATH;
    const fakeBin = makeFakeBin(["git", "docker"], {
      docker:
        '#!/bin/sh\nif [ "$1" = "image" ] || [ "$1" = "pull" ]; then\n  exit 1\nfi\nexit 0\n',
    });
    const nodeBinDir = path.dirname(process.execPath);
    try {
      process.env.PATH = [nodeBinDir, fakeBin].join(path.delimiter);
      // Run from inside the March repo so repo-context check passes.
      const result = checkSpawnDependencies(TEST_BASE_IMAGE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(TEST_BASE_IMAGE);
      }
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(path.dirname(fakeBin), { recursive: true, force: true });
    }
  });
});
