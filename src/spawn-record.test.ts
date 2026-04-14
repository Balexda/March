import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_BACKEND,
  removeSpawnRecord,
  SPAWN_RECORD_VERSION,
  spawnRecordDir,
  spawnRecordPath,
  SpawnRecordError,
  writeInitialSpawnRecord,
} from "./spawn-record.js";

describe("spawn-record", () => {
  const tmpDirs: string[] = [];

  function makeHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-home-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        // Restore any clobbered permissions before cleanup.
        try {
          fs.chmodSync(dir, 0o700);
        } catch {
          // ignore
        }
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs.length = 0;
  });

  describe("spawnRecordDir / spawnRecordPath", () => {
    it("resolves to <home>/.march/spawns/", () => {
      expect(spawnRecordDir("/fake/home")).toBe("/fake/home/.march/spawns");
    });

    it("spawnRecordPath appends <id>.json", () => {
      expect(spawnRecordPath("20260411-a1b2c3", "/fake/home")).toBe(
        "/fake/home/.march/spawns/20260411-a1b2c3.json",
      );
    });
  });

  describe("writeInitialSpawnRecord", () => {
    const baseInput = {
      id: "20260411-a1b2c3",
      repoPath: "/abs/repo",
      branch: "march/spawn/20260411-a1b2c3",
      worktreePath: "/abs/worktrees/march/20260411-a1b2c3",
    };

    it("creates <home>/.march/spawns/ on demand and writes the record JSON", () => {
      const home = makeHome();
      // Directory must not exist yet — covers the spec edge case.
      expect(fs.existsSync(path.join(home, ".march", "spawns"))).toBe(false);

      const record = writeInitialSpawnRecord(baseInput, home);

      const filePath = spawnRecordPath(baseInput.id, home);
      expect(fs.existsSync(filePath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(parsed).toEqual(record);
    });

    it("populates all required fields for the `created` state", () => {
      const home = makeHome();
      const before = Date.now();
      const record = writeInitialSpawnRecord(baseInput, home);
      const after = Date.now();

      expect(record.version).toBe(SPAWN_RECORD_VERSION);
      expect(record.id).toBe(baseInput.id);
      expect(record.repoPath).toBe(baseInput.repoPath);
      expect(record.branch).toBe(baseInput.branch);
      expect(record.worktreePath).toBe(baseInput.worktreePath);
      expect(record.backend).toBe(DEFAULT_BACKEND);
      expect(record.status).toBe("created");

      // createdAt is a valid ISO 8601 timestamp within the test window.
      const createdAt = Date.parse(record.createdAt);
      expect(Number.isFinite(createdAt)).toBe(true);
      expect(createdAt).toBeGreaterThanOrEqual(before - 1);
      expect(createdAt).toBeLessThanOrEqual(after + 1);
      expect(record.createdAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    it("omits conditional fields that are not yet populated", () => {
      const home = makeHome();
      writeInitialSpawnRecord(baseInput, home);
      const parsed = JSON.parse(
        fs.readFileSync(spawnRecordPath(baseInput.id, home), "utf-8"),
      );
      // These fields belong to later lifecycle states (Stories 4–7).
      expect(parsed.containerId).toBeUndefined();
      expect(parsed.imageId).toBeUndefined();
      expect(parsed.startedAt).toBeUndefined();
      expect(parsed.exitCode).toBeUndefined();
      expect(parsed.stoppedAt).toBeUndefined();
    });

    it("accepts an explicit backend override", () => {
      const home = makeHome();
      const record = writeInitialSpawnRecord(
        { ...baseInput, backend: "gemini" },
        home,
      );
      expect(record.backend).toBe("gemini");
    });

    it("throws SpawnRecordError when the record file cannot be written", () => {
      const home = makeHome();
      // Pre-create `<home>/.march` as a FILE so `mkdirSync(.../.march/spawns)`
      // fails with ENOTDIR while trying to traverse the intermediate path.
      fs.writeFileSync(path.join(home, ".march"), "not a dir");
      expect(() => writeInitialSpawnRecord(baseInput, home)).toThrow(
        SpawnRecordError,
      );
    });
  });

  describe("removeSpawnRecord", () => {
    it("removes an existing record file", () => {
      const home = makeHome();
      const id = "20260411-deadbe";
      writeInitialSpawnRecord({ ...{
        id,
        repoPath: "/abs/repo",
        branch: `march/spawn/${id}`,
        worktreePath: `/abs/worktrees/march/${id}`,
      } }, home);

      expect(fs.existsSync(spawnRecordPath(id, home))).toBe(true);
      removeSpawnRecord(id, home);
      expect(fs.existsSync(spawnRecordPath(id, home))).toBe(false);
    });

    it("is idempotent when the record file is already absent", () => {
      const home = makeHome();
      expect(() => removeSpawnRecord("20260411-nofile", home)).not.toThrow();
    });
  });
});
