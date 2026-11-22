/**
 * @l1 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const scriptPath = path.join(scriptDir, "build-args.sh");
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function run(cwd, env = {}) {
  const base = { ...process.env };
  for (const k of ["MARCH_GIT_SHA", "MARCH_GIT_DESCRIBE", "MARCH_BUILD_TIME"]) {
    delete base[k];
  }
  return spawnSync("sh", [scriptPath], {
    cwd,
    env: { ...base, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

function parse(stdout) {
  const out = {};
  for (const m of stdout.matchAll(/--build-arg (MARCH_[A-Z_]+)=(\S*)/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

describe("scripts/build-args.sh", () => {
  it("prints the three flags with values inside a git checkout", () => {
    const res = run(repoRoot);
    expect(res.status).toBe(0);
    const args = parse(res.stdout);
    expect(Object.keys(args)).toEqual([
      "MARCH_GIT_SHA",
      "MARCH_GIT_DESCRIBE",
      "MARCH_BUILD_TIME",
    ]);
    expect(args.MARCH_GIT_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(args.MARCH_GIT_DESCRIBE).not.toBe("");
    expect(args.MARCH_BUILD_TIME).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("emits empty SHA/DESCRIBE and exits 0 outside git", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-build-args-"));
    tmpDirs.push(dir);
    const res = run(dir, { GIT_CEILING_DIRECTORIES: path.dirname(dir) });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    const args = parse(res.stdout);
    expect(args.MARCH_GIT_SHA).toBe("");
    expect(args.MARCH_GIT_DESCRIBE).toBe("");
    expect(res.stdout).toContain("--build-arg MARCH_GIT_SHA= ");
  });

  it("lets pre-set env vars override", () => {
    const res = run(repoRoot, {
      MARCH_GIT_SHA: "abc123",
      MARCH_GIT_DESCRIBE: "v9.9.9-0-gabc123",
      MARCH_BUILD_TIME: "2026-01-02T03:04:05Z",
    });
    expect(res.status).toBe(0);
    expect(parse(res.stdout)).toEqual({
      MARCH_GIT_SHA: "abc123",
      MARCH_GIT_DESCRIBE: "v9.9.9-0-gabc123",
      MARCH_BUILD_TIME: "2026-01-02T03:04:05Z",
    });
  });
});
