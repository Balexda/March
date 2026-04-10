import { describe, it, expect } from "vitest";
import path from "node:path";
import { isOnPath, isFinderAvailable, INIT_DEPENDENCIES } from "./deps.js";

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
