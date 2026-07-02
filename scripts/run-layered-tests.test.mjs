/**
 * @l0 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  findUntaggedCandidateTestFiles,
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

const untaggedTest = `import { describe, it } from "vitest";

describe("fixture", () => {
  it("passes", () => {});
});
`;

// A leading block whose only annotation is a non-taxonomy JSDoc tag. The
// literal `@vitest-environment` token is avoided here because vitest's own
// environment scanner would try to honor it against this test file.
const nonTaxonomyTaggedTest = `/**
 * @fileoverview shared fixture
 */
import { describe, it } from "vitest";

describe("fixture", () => {
  it("passes", () => {});
});
`;

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
      "tsup src/cli.ts --format esm --clean && npm run skills:generate",
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

  it("selects L0 files from @l0 @deterministic @ci leading tags", () => {
    const root = makeRepo({
      "src/l0.test.ts": taggedTest("@l0 @deterministic @ci"),
      "src/l1.test.ts": taggedTest("@l1 @deterministic @ci"),
    });

    expect(selectLayerTestFiles(root, "l0")).toEqual(["src/l0.test.ts"]);
  });

  it("moves selection between L0 and L1 when the leading layer tag changes", () => {
    const root = makeRepo({
      "src/retagged.test.ts": taggedTest("@l0 @deterministic @ci"),
    });
    const fixturePath = path.join(root, "src/retagged.test.ts");

    expect(selectLayerTestFiles(root, "l0")).toEqual(["src/retagged.test.ts"]);
    expect(selectLayerTestFiles(root, "l1")).toEqual([]);

    fs.writeFileSync(fixturePath, taggedTest("@l1 @deterministic @ci"));

    expect(selectLayerTestFiles(root, "l0")).toEqual([]);
    expect(selectLayerTestFiles(root, "l1")).toEqual(["src/retagged.test.ts"]);
  });

  it("excludes stochastic and scheduled files from deterministic PR gate layers", () => {
    const root = makeRepo({
      "src/stochastic.test.ts": taggedTest("@l0 @stochastic @ci"),
      "src/scheduled.test.ts": taggedTest("@l1 @deterministic @scheduled"),
    });

    expect(selectLayerTestFiles(root, "l0")).toEqual([]);
    expect(selectLayerTestFiles(root, "l1")).toEqual([]);
    expect(selectLayerTestFiles(root, "l2-cassette")).toEqual([]);
    expect(selectLayerTestFiles(root, "l3-cassette")).toEqual([]);
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
      "tests/quarantine/untagged.test.ts": untaggedTest,
    });

    expect(findUntaggedCandidateTestFiles(root)).toEqual([]);
    expect(selectLayerTestFiles(root, "l0")).toEqual([]);
    expect(selectLayerTestFiles(root, "l1")).toEqual([]);
    expect(selectLayerTestFiles(root, "l2-cassette")).toEqual([]);
    expect(selectLayerTestFiles(root, "l3-cassette")).toEqual([]);
  });

  it("detects untagged non-quarantined candidate test files before selection", () => {
    const root = makeRepo({
      "src/untagged.test.ts": untaggedTest,
      "src/missing-axis.test.ts": taggedTest("@l0 @ci"),
      "tests/quarantine/untagged.test.ts": untaggedTest,
    });

    expect(findUntaggedCandidateTestFiles(root)).toEqual([
      "src/untagged.test.ts",
    ]);
    expect(selectLayerTestFiles(root, "l0")).toEqual([]);
  });

  it("flags a leading block with no recognized taxonomy tag as untagged", () => {
    const root = makeRepo({
      "src/env-only.test.mjs": nonTaxonomyTaggedTest,
      "src/missing-axis.test.ts": taggedTest("@l0 @ci"),
      "src/l0.test.ts": taggedTest("@l0 @deterministic @ci"),
    });

    // A block carrying only a non-taxonomy JSDoc tag has no taxonomy tag, so
    // it would be silently omitted from every layer — the guard must catch it.
    // A partial-but-recognized tuple (`@l0 @ci`) still routes through the
    // tag-selection contract and is left to the whole-repo taxonomy lint.
    expect(findUntaggedCandidateTestFiles(root)).toEqual([
      "src/env-only.test.mjs",
    ]);
  });

  it("exits non-zero with bounded diagnostics for an untagged matched file", () => {
    const root = makeRepo({
      "src/untagged.test.ts": untaggedTest,
      "src/tagged.test.ts": taggedTest("@l0 @deterministic @ci"),
    });
    const result = spawnSync("node", [runnerPath, "l0"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "test:l0: refused to run 1 untagged test file(s)",
    );
    expect(result.stderr).toContain(
      "test:l0: src/untagged.test.ts has no recognized taxonomy tag block.",
    );
    expect(result.stderr).not.toContain("src/tagged.test.ts");
  });

  it("caps per-file diagnostics and summarizes the remainder", () => {
    const files = {};
    const untaggedCount = 55;
    for (let i = 0; i < untaggedCount; i += 1) {
      files[`src/untagged-${String(i).padStart(2, "0")}.test.ts`] = untaggedTest;
    }
    const root = makeRepo(files);
    const result = spawnSync("node", [runnerPath, "l0"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `test:l0: refused to run ${untaggedCount} untagged test file(s)`,
    );
    const listedLines = result.stderr
      .split("\n")
      .filter((line) => line.includes("has no recognized taxonomy tag block."));
    expect(listedLines).toHaveLength(50);
    expect(result.stderr).toContain(
      "test:l0: … and 5 more untagged file(s) not listed.",
    );
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
