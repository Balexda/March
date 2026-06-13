/**
 * @l0 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TOOLCHAIN_SELECTION,
  detectToolchain,
  isToolchainSelection,
  resolveToolchain,
  resolveToolchainImage,
  TOOLCHAIN_SELECTIONS,
} from "./toolchain.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "march-toolchain-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function touch(name: string): void {
  fs.writeFileSync(path.join(tmpDir, name), "");
}

describe("isToolchainSelection", () => {
  it("accepts every advertised selection", () => {
    for (const value of TOOLCHAIN_SELECTIONS) {
      expect(isToolchainSelection(value)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isToolchainSelection("rust")).toBe(false);
    expect(isToolchainSelection("")).toBe(false);
    expect(isToolchainSelection("JVM")).toBe(false);
  });

  it("defaults to auto", () => {
    expect(DEFAULT_TOOLCHAIN_SELECTION).toBe("auto");
  });
});

describe("detectToolchain", () => {
  it("returns node for a repo with no JVM markers", () => {
    touch("package.json");
    expect(detectToolchain(tmpDir)).toBe("node");
  });

  it("returns node for an empty repo", () => {
    expect(detectToolchain(tmpDir)).toBe("node");
  });

  it.each([
    "gradlew",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle.kts",
    "pom.xml",
  ])("returns jvm when %s is present", (marker: string) => {
    touch(marker);
    expect(detectToolchain(tmpDir)).toBe("jvm");
  });

  it("returns jvm for a Gradle repo even when package.json also exists", () => {
    touch("package.json");
    touch("build.gradle.kts");
    expect(detectToolchain(tmpDir)).toBe("jvm");
  });
});

describe("resolveToolchain", () => {
  it("honors an explicit override over repo markers", () => {
    touch("package.json"); // would detect node
    expect(resolveToolchain("jvm", tmpDir)).toEqual({
      toolchain: "jvm",
      source: "override",
    });
  });

  it("auto-detects when override is undefined", () => {
    touch("gradlew");
    expect(resolveToolchain(undefined, tmpDir)).toEqual({
      toolchain: "jvm",
      source: "detected",
    });
  });

  it("auto-detects when override is the literal 'auto'", () => {
    touch("gradlew");
    expect(resolveToolchain("auto", tmpDir)).toEqual({
      toolchain: "jvm",
      source: "detected",
    });
  });

  it("reports source=default for a node fallback", () => {
    expect(resolveToolchain("auto", tmpDir)).toEqual({
      toolchain: "node",
      source: "default",
    });
  });

  it("treats an unrecognized override as auto-detect (defense-in-depth)", () => {
    touch("gradlew");
    expect(resolveToolchain("rust", tmpDir)).toEqual({
      toolchain: "jvm",
      source: "detected",
    });
  });
});

describe("resolveToolchainImage", () => {
  it("returns the base image unchanged for node", () => {
    expect(resolveToolchainImage("march-spawn-claude:latest", "node")).toBe(
      "march-spawn-claude:latest",
    );
  });

  it("inserts the toolchain segment before the tag for jvm", () => {
    expect(resolveToolchainImage("march-spawn-claude:latest", "jvm")).toBe(
      "march-spawn-claude-jvm:latest",
    );
    expect(resolveToolchainImage("march-spawn-codex:latest", "jvm")).toBe(
      "march-spawn-codex-jvm:latest",
    );
  });

  it("appends the toolchain when the image has no tag", () => {
    expect(resolveToolchainImage("march-spawn-codex", "jvm")).toBe(
      "march-spawn-codex-jvm",
    );
  });

  it("does not mistake a registry port for a tag", () => {
    expect(resolveToolchainImage("registry:5000/march-spawn-codex", "jvm")).toBe(
      "registry:5000/march-spawn-codex-jvm",
    );
    expect(
      resolveToolchainImage("registry:5000/march-spawn-codex:latest", "jvm"),
    ).toBe("registry:5000/march-spawn-codex-jvm:latest");
  });
});
