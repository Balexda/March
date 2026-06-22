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
  discoverTestFiles,
  lintTaxonomy,
  validateTestFile,
} from "./test-taxonomy.mjs";

const tmpDirs = [];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const runnerPath = path.join(scriptDir, "test-taxonomy.mjs");

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "march-taxonomy-"));
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

describe("taxonomy coverage lint", () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("exposes the shared local and CI entrypoint through npm", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );

    expect(packageJson.scripts["test:taxonomy"]).toBe(
      "node scripts/test-taxonomy.mjs",
    );
  });

  it("discovers every repo test file outside generated dependency directories", () => {
    const root = makeRepo({
      "src/a.test.ts": taggedTest("@l0 @deterministic @ci"),
      "src/nested/b.test.ts": taggedTest("@l1 @deterministic @ci"),
      "src/not-a-test.ts": taggedTest("@l0 @deterministic @ci"),
      "node_modules/pkg/ignored.test.ts": "",
      "dist/ignored.test.ts": "",
      ".git/ignored.test.ts": "",
    });

    expect(discoverTestFiles(root)).toEqual([
      "src/a.test.ts",
      "src/nested/b.test.ts",
    ]);
  });

  it("passes valid files without rewriting them", () => {
    const source = taggedTest("@l3 @stochastic @scheduled");
    const root = makeRepo({ "src/valid.test.ts": source });

    expect(lintTaxonomy(root)).toEqual({
      status: "pass",
      checkedFiles: ["src/valid.test.ts"],
      failures: [],
    });
    expect(fs.readFileSync(path.join(root, "src/valid.test.ts"), "utf8")).toBe(
      source,
    );
  });

  it("reports missing tag blocks and missing axes with the path and axis", () => {
    const root = makeRepo({
      "src/untagged.test.ts": `import { describe, it } from "vitest";

describe("fixture", () => {
  it("passes", () => {});
});
`,
      "src/missing-axis.test.ts": taggedTest("@l0 @ci"),
    });

    expect(lintTaxonomy(root).failures).toEqual([
      { path: "src/missing-axis.test.ts", axis: "determinism", reason: "missing" },
      { path: "src/untagged.test.ts", axis: "scope", reason: "missing" },
      {
        path: "src/untagged.test.ts",
        axis: "determinism",
        reason: "missing",
      },
      {
        path: "src/untagged.test.ts",
        axis: "executionChannel",
        reason: "missing",
      },
    ]);
  });

  it("reports duplicate and conflicting axis tags with the path, axis, and reason", () => {
    expect(
      validateTestFile(
        "src/invalid.test.ts",
        taggedTest("@l0 @l0 @deterministic @ci @scheduled"),
      ),
    ).toEqual([
      {
        path: "src/invalid.test.ts",
        axis: "scope",
        reason: "duplicate",
        detail: "@l0",
      },
      {
        path: "src/invalid.test.ts",
        axis: "executionChannel",
        reason: "conflicting",
        detail: "@ci, @scheduled",
      },
    ]);
  });

  it("validates only the leading tag block", () => {
    expect(
      validateTestFile(
        "src/prose.test.ts",
        `// @l0 @deterministic @ci
import { describe, it } from "vitest";

describe("fixture", () => {
  it("mentions @l0 @deterministic @ci elsewhere", () => {});
});
`,
      ),
    ).toEqual([
      { path: "src/prose.test.ts", axis: "scope", reason: "missing" },
      { path: "src/prose.test.ts", axis: "determinism", reason: "missing" },
      {
        path: "src/prose.test.ts",
        axis: "executionChannel",
        reason: "missing",
      },
    ]);
  });

  it("ignores tags in a non-JSDoc block comment to match the layered selector", () => {
    expect(
      validateTestFile(
        "src/plain-block.test.ts",
        `/* @l0 @deterministic @ci */
import { describe, it } from "vitest";

describe("fixture", () => {
  it("passes", () => {});
});
`,
      ),
    ).toEqual([
      { path: "src/plain-block.test.ts", axis: "scope", reason: "missing" },
      { path: "src/plain-block.test.ts", axis: "determinism", reason: "missing" },
      {
        path: "src/plain-block.test.ts",
        axis: "executionChannel",
        reason: "missing",
      },
    ]);
  });

  it("exits non-zero with actionable diagnostics for invalid files", () => {
    const root = makeRepo({
      "src/invalid.test.ts": taggedTest("@l0 @l1 @ci"),
    });
    const result = spawnSync("node", [runnerPath], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/invalid.test.ts");
    expect(result.stderr).toContain("scope conflicting");
    expect(result.stderr).toContain("determinism missing");
  });

  it("exits zero with a clean diagnostic for a fully tagged suite", () => {
    const root = makeRepo({
      "src/valid.test.ts": taggedTest("@l0 @deterministic @ci"),
    });

    const output = execFileSync("node", [runnerPath], {
      cwd: root,
      encoding: "utf8",
    });

    expect(output).toContain("checked 1 test file(s)");
    expect(output).toContain("taxonomy tags complete");
  });
});
