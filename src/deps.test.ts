import { describe, it, expect } from "vitest";
import { isOnPath, INIT_DEPENDENCIES } from "./deps.js";

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
  it('returns true for "node" which is always available in test env', () => {
    expect(isOnPath("node")).toBe(true);
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
