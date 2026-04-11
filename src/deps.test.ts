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
   */
  function makeFakeBin(stubs: string[] = []): string {
    const fakeBin = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "march-deps-test-")),
      "bin",
    );
    fs.mkdirSync(fakeBin);
    // Symlink the finder binary so isFinderAvailable() returns true.
    fs.symlinkSync(FINDER_PATH, path.join(fakeBin, path.basename(FINDER_PATH)));
    for (const name of stubs) {
      const stub = path.join(fakeBin, name);
      fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(stub, 0o755);
    }
    return fakeBin;
  }

  it("returns ok:true when finder is available and git is on PATH", () => {
    const originalPath = process.env.PATH;
    const fakeBin = makeFakeBin(["git"]);
    const nodeBinDir = path.dirname(process.execPath);
    try {
      process.env.PATH = [nodeBinDir, fakeBin].join(path.delimiter);
      const result = checkSpawnDependencies();
      expect(result.ok).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(path.dirname(fakeBin), { recursive: true, force: true });
    }
  });

  it("returns ok:false with error mentioning 'git' when git is not on PATH", () => {
    const originalPath = process.env.PATH;
    const fakeBin = makeFakeBin(); // no git stub
    const nodeBinDir = path.dirname(process.execPath);
    try {
      process.env.PATH = [nodeBinDir, fakeBin].join(path.delimiter);
      const result = checkSpawnDependencies();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("git");
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
      const result = checkSpawnDependencies();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("path-search utility");
      }
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
