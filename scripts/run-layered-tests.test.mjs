/**
 * @l0 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  layerCommandContract,
  selectLayerTestFiles,
} from "./run-layered-tests.mjs";

const tmpDirs = [];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const runnerPath = path.join(scriptDir, "run-layered-tests.mjs");

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "march-layered-tests-"));
  tmpDirs.push(root);

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }

  return root;
}

function taggedTest(tags) {
  return `/**
 * ${tags}
 */
import { describe, it } from "vitest";

describe("fixture", () => {
  it("passes", () => {});
});
`;
}

describe("layered test command contract", () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("maps each staged npm script to one layer scope plus deterministic CI axes", () => {
    expect(layerCommandContract()).toEqual({
      "test:l0": {
        layer: "l0",
        scope: "@l0",
        requiredTags: ["@deterministic", "@ci"],
        excludedPath: "tests/quarantine/",
      },
      "test:l1": {
        layer: "l1",
        scope: "@l1",
        requiredTags: ["@deterministic", "@ci"],
        excludedPath: "tests/quarantine/",
      },
      "test:l2-cassette": {
        layer: "l2-cassette",
        scope: "@l2",
        requiredTags: ["@deterministic", "@ci"],
        excludedPath: "tests/quarantine/",
      },
      "test:l3-cassette": {
        layer: "l3-cassette",
        scope: "@l3",
        requiredTags: ["@deterministic", "@ci"],
        excludedPath: "tests/quarantine/",
      },
    });
  });

  it("exposes every staged script through npm with local deterministic commands", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    const stagedScripts = [
      "test:l0",
      "test:l1",
      "test:l2-cassette",
      "test:l3-cassette",
    ];

    for (const scriptName of stagedScripts) {
      expect(packageJson.scripts[scriptName]).toMatch(
        /^node scripts\/run-layered-tests\.mjs /,
      );
      expect(packageJson.scripts[scriptName]).not.toMatch(
        /\b(docker|curl|ssh|gh|refresh)\b/,
      );
    }
  });

  it("runs npm test as the sequential fail-fast aggregate over staged scripts", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );

    expect(packageJson.scripts.test).toBe(
      "npm run test:l0 && npm run test:l1 && npm run test:l2-cassette && npm run test:l3-cassette",
    );
    expect(packageJson.scripts.test).not.toMatch(/\b(vitest|node|npx)\b/);
  });

  it("keeps the aggregate build to npm pretest without per-layer build hooks", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );

    expect(packageJson.scripts.pretest).toBe(packageJson.scripts.build);
    expect(packageJson.scripts.build).toBe(
      "tsup src/cli.ts --format esm --clean",
    );
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");
    expect(packageJson.scripts["pretest:l0"]).toBeUndefined();
    expect(packageJson.scripts["pretest:l1"]).toBeUndefined();
    expect(packageJson.scripts["pretest:l2-cassette"]).toBeUndefined();
    expect(packageJson.scripts["pretest:l3-cassette"]).toBeUndefined();
  });

  it("selects exactly the intended deterministic CI scope for every layer", () => {
    const root = makeRepo({
      "src/l0.test.ts": taggedTest("@l0 @deterministic @ci"),
      "src/l1.test.ts": taggedTest("@l1 @deterministic @ci"),
      "src/l2.test.ts": taggedTest("@l2 @deterministic @ci"),
      "src/l3.test.ts": taggedTest("@l3 @deterministic @ci"),
      "src/l0-scheduled.test.ts": taggedTest("@l0 @deterministic @scheduled"),
      "src/l1-stochastic.test.ts": taggedTest("@l1 @stochastic @ci"),
    });

    expect(selectLayerTestFiles(root, "l0")).toEqual(["src/l0.test.ts"]);
    expect(selectLayerTestFiles(root, "l1")).toEqual(["src/l1.test.ts"]);
    expect(selectLayerTestFiles(root, "l2-cassette")).toEqual([
      "src/l2.test.ts",
    ]);
    expect(selectLayerTestFiles(root, "l3-cassette")).toEqual([
      "src/l3.test.ts",
    ]);
  });

  it("includes tagged script tests in the deterministic aggregate surface", () => {
    const root = makeRepo({
      "scripts/contract.test.mjs": taggedTest("@l0 @deterministic @ci"),
    });

    expect(selectLayerTestFiles(root, "l0")).toEqual([
      "scripts/contract.test.mjs",
    ]);
  });

  it("excludes tests/quarantine before tag-based selection for every layer", () => {
    const root = makeRepo({
      "tests/quarantine/l0.test.ts": taggedTest("@l0 @deterministic @ci"),
      "tests/quarantine/l1.test.ts": taggedTest("@l1 @deterministic @ci"),
      "tests/quarantine/l2.test.ts": taggedTest("@l2 @deterministic @ci"),
      "tests/quarantine/l3.test.ts": taggedTest("@l3 @deterministic @ci"),
    });

    expect(selectLayerTestFiles(root, "l0")).toEqual([]);
    expect(selectLayerTestFiles(root, "l1")).toEqual([]);
    expect(selectLayerTestFiles(root, "l2-cassette")).toEqual([]);
    expect(selectLayerTestFiles(root, "l3-cassette")).toEqual([]);
  });

  it("exits cleanly with explicit diagnostics when a layer is empty", () => {
    const root = makeRepo({
      "src/only-l1.test.ts": taggedTest("@l1 @deterministic @ci"),
    });

    const output = execFileSync("node", [runnerPath, "l0"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(output).toContain("test:l0: no @l0 @deterministic @ci tests");
    expect(output).toContain("layer passes empty");
  });
});
