/**
 * @l0 @deterministic @ci
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parkQuarantinedTest,
  QUARANTINE_DIR,
  QUARANTINE_ORIGINS_FILE,
  QuarantineError,
} from "./quarantine.js";

describe("quarantine routing", () => {
  const tmpDirs: string[] = [];

  function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-quarantine-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs.length = 0;
  });

  it("parks a test under tests/quarantine while preserving the file body", () => {
    const repoRoot = makeRepo();
    const origin = "src/example/foo.test.ts";
    const originAbs = path.join(repoRoot, origin);
    const body = [
      "/* @scope unit @determinism deterministic @channel ci */",
      "import { describe, expect, it } from \"vitest\";",
      "",
      "describe(\"foo\", () => {",
      "  it(\"keeps assertions\", () => {",
      "    expect(1 + 1).toBe(2);",
      "  });",
      "});",
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(originAbs), { recursive: true });
    fs.writeFileSync(originAbs, body);

    const result = parkQuarantinedTest(origin, { repoRoot });

    expect(result).toEqual({
      originPath: origin,
      quarantinedPath: `${QUARANTINE_DIR}/${origin}`,
    });
    expect(fs.existsSync(originAbs)).toBe(false);
    expect(fs.readFileSync(path.join(repoRoot, result.quarantinedPath), "utf-8"))
      .toBe(body);
  });

  it("records the origin path when parking", () => {
    const repoRoot = makeRepo();
    const origin = "src/example/bar.test.ts";
    fs.mkdirSync(path.join(repoRoot, "src/example"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, origin), "import \"vitest\";\n");

    const result = parkQuarantinedTest(origin, { repoRoot });

    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, QUARANTINE_ORIGINS_FILE), "utf-8"),
    ) as Record<string, string>;
    expect(manifest).toEqual({ [result.quarantinedPath]: origin });
  });

  it("fails deterministically for invalid and already-quarantined inputs", () => {
    const repoRoot = makeRepo();
    const quarantined = `${QUARANTINE_DIR}/src/example/baz.test.ts`;
    fs.mkdirSync(path.join(repoRoot, path.dirname(quarantined)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, quarantined), "import \"vitest\";\n");

    expect(() => parkQuarantinedTest("src/example/not-a-test.ts", { repoRoot }))
      .toThrow(QuarantineError);
    expect(() => parkQuarantinedTest(quarantined, { repoRoot }))
      .toThrow(QuarantineError);
  });

  it("rolls the move back when the origin manifest cannot be written", () => {
    const repoRoot = makeRepo();
    const origin = "src/example/qux.test.ts";
    const body = "import \"vitest\";\n";
    fs.mkdirSync(path.join(repoRoot, "src/example"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, origin), body);
    // Force the manifest write to fail: occupy its path with a directory so
    // writeFileSync throws EISDIR after the file has already been moved.
    fs.mkdirSync(path.join(repoRoot, QUARANTINE_ORIGINS_FILE), { recursive: true });

    expect(() => parkQuarantinedTest(origin, { repoRoot })).toThrow(QuarantineError);
    // The move is rolled back: the test is back at its origin, not stranded
    // under quarantine with no recorded origin.
    expect(fs.readFileSync(path.join(repoRoot, origin), "utf-8")).toBe(body);
    expect(fs.existsSync(path.join(repoRoot, QUARANTINE_DIR, origin))).toBe(false);
  });
});
