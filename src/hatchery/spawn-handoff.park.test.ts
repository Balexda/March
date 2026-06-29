/**
 * @l1 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parkFailedSpawnsEnabled,
  parkedManifestDir,
  writeParkedSpawnManifest,
} from "./spawn-handoff.js";

describe("parkFailedSpawnsEnabled (#460 gate)", () => {
  it("is off by default and on for any non-empty MARCH_HATCHERY_PARK_FAILED", () => {
    expect(parkFailedSpawnsEnabled({})).toBe(false);
    expect(parkFailedSpawnsEnabled({ MARCH_HATCHERY_PARK_FAILED: "" })).toBe(false);
    expect(parkFailedSpawnsEnabled({ MARCH_HATCHERY_PARK_FAILED: "  " })).toBe(false);
    expect(parkFailedSpawnsEnabled({ MARCH_HATCHERY_PARK_FAILED: "1" })).toBe(true);
    expect(parkFailedSpawnsEnabled({ MARCH_HATCHERY_PARK_FAILED: "true" })).toBe(true);
  });
});

describe("writeParkedSpawnManifest (#460)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    tmpDirs.length = 0;
  });

  it("writes a readable JSON manifest under .march/hatchery/parked/<spawnId>.json", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "march-park-manifest-"));
    tmpDirs.push(home);
    const file = writeParkedSpawnManifest(home, {
      spawnId: "20260628-abc123",
      sliceId: "slice-x",
      parkedWorktreePath: "/wt-parked",
      worktreeMoved: true,
    });
    expect(file).toBe(path.join(parkedManifestDir(home), "20260628-abc123.json"));
    const parsed = JSON.parse(fs.readFileSync(file as string, "utf-8"));
    expect(parsed).toMatchObject({ spawnId: "20260628-abc123", sliceId: "slice-x", worktreeMoved: true });
  });

  it("returns null instead of throwing when the path is unwritable", () => {
    // A file where the parked dir's parent should be → mkdirSync fails → null.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "march-park-bad-"));
    tmpDirs.push(home);
    fs.writeFileSync(path.join(home, ".march"), "not a dir\n");
    expect(writeParkedSpawnManifest(home, { spawnId: "x" })).toBeNull();
  });
});
