import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_BACKEND,
  markSpawnRecordFailed,
  removeSpawnRecord,
  SPAWN_RECORD_VERSION,
  spawnRecordDir,
  spawnRecordPath,
  SpawnRecordError,
  updateSpawnRecordImageId,
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

    it("refuses to overwrite an existing SpawnRecord (exclusive create)", () => {
      const home = makeHome();
      // First write succeeds.
      writeInitialSpawnRecord(baseInput, home);
      // Second write with the same ID must surface an explicit error
      // rather than silently clobbering the first record.
      expect(() => writeInitialSpawnRecord(baseInput, home)).toThrow(
        /already exists/,
      );
    });
  });

  describe("removeSpawnRecord", () => {
    it("removes an existing record file", () => {
      const home = makeHome();
      const id = "20260411-deadbe";
      writeInitialSpawnRecord(
        {
          id,
          repoPath: "/abs/repo",
          branch: `march/spawn/${id}`,
          worktreePath: `/abs/worktrees/march/${id}`,
        },
        home,
      );

      expect(fs.existsSync(spawnRecordPath(id, home))).toBe(true);
      removeSpawnRecord(id, home);
      expect(fs.existsSync(spawnRecordPath(id, home))).toBe(false);
    });

    it("is idempotent when the record file is already absent", () => {
      const home = makeHome();
      expect(() => removeSpawnRecord("20260411-nofile", home)).not.toThrow();
    });
  });

  describe("updateSpawnRecordImageId", () => {
    const baseInput = {
      id: "20260411-image1",
      repoPath: "/abs/repo",
      branch: "march/spawn/20260411-image1",
      worktreePath: "/abs/worktrees/march/20260411-image1",
    };

    it("populates imageId on the existing record without touching status", () => {
      const home = makeHome();
      const initial = writeInitialSpawnRecord(baseInput, home);
      expect(initial.status).toBe("created");
      expect(initial.imageId).toBeUndefined();

      const updated = updateSpawnRecordImageId(
        baseInput.id,
        "march-spawn-20260411-image1",
        home,
      );

      expect(updated.imageId).toBe("march-spawn-20260411-image1");
      // Story 5 owns the "created" → "running" transition; this helper
      // must not touch status.
      expect(updated.status).toBe("created");

      const onDisk = JSON.parse(
        fs.readFileSync(spawnRecordPath(baseInput.id, home), "utf-8"),
      );
      expect(onDisk).toEqual(updated);
      // Round-tripped record still satisfies the data-model rules for the
      // `"created"` state with a built image: required fields all present,
      // imageId populated, no premature lifecycle fields.
      expect(onDisk.version).toBe(SPAWN_RECORD_VERSION);
      expect(onDisk.id).toBe(baseInput.id);
      expect(onDisk.repoPath).toBe(baseInput.repoPath);
      expect(onDisk.branch).toBe(baseInput.branch);
      expect(onDisk.worktreePath).toBe(baseInput.worktreePath);
      expect(onDisk.backend).toBe(DEFAULT_BACKEND);
      expect(onDisk.createdAt).toBe(initial.createdAt);
      expect(onDisk.containerId).toBeUndefined();
      expect(onDisk.startedAt).toBeUndefined();
      expect(onDisk.stoppedAt).toBeUndefined();
      expect(onDisk.exitCode).toBeUndefined();
    });

    it("preserves the original createdAt and other initial fields", () => {
      const home = makeHome();
      const initial = writeInitialSpawnRecord(baseInput, home);
      const updated = updateSpawnRecordImageId(
        baseInput.id,
        "sha256:deadbeef",
        home,
      );
      expect(updated.createdAt).toBe(initial.createdAt);
      expect(updated.repoPath).toBe(initial.repoPath);
      expect(updated.branch).toBe(initial.branch);
      expect(updated.worktreePath).toBe(initial.worktreePath);
      expect(updated.backend).toBe(initial.backend);
    });

    it("writes the updated record atomically (no leftover temp files)", () => {
      const home = makeHome();
      writeInitialSpawnRecord(baseInput, home);
      updateSpawnRecordImageId(baseInput.id, "march-spawn-x", home);

      const dir = spawnRecordDir(home);
      const entries = fs.readdirSync(dir);
      // Only the final record file should remain — temp files used for the
      // atomic write must be renamed away or cleaned up.
      expect(entries).toEqual([`${baseInput.id}.json`]);
    });

    it("throws SpawnRecordError when the record file is missing", () => {
      const home = makeHome();
      // No initial write — file does not exist.
      expect(() =>
        updateSpawnRecordImageId(baseInput.id, "march-spawn-x", home),
      ).toThrow(SpawnRecordError);
    });
  });

  describe("markSpawnRecordFailed", () => {
    const baseInput = {
      id: "20260411-fail01",
      repoPath: "/abs/repo",
      branch: "march/spawn/20260411-fail01",
      worktreePath: "/abs/worktrees/march/20260411-fail01",
    };

    it("transitions an existing `created` record to `failed` with stoppedAt", () => {
      const home = makeHome();
      const initial = writeInitialSpawnRecord(baseInput, home);
      expect(initial.status).toBe("created");
      expect(initial.stoppedAt).toBeUndefined();

      const before = Date.now();
      const failed = markSpawnRecordFailed(baseInput.id, undefined, home);
      const after = Date.now();

      expect(failed.status).toBe("failed");
      expect(failed.stoppedAt).toBeDefined();
      expect(failed.stoppedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      const stoppedAt = Date.parse(failed.stoppedAt as string);
      expect(stoppedAt).toBeGreaterThanOrEqual(before - 1);
      expect(stoppedAt).toBeLessThanOrEqual(after + 1);

      // Initial fields preserved.
      expect(failed.id).toBe(initial.id);
      expect(failed.repoPath).toBe(initial.repoPath);
      expect(failed.branch).toBe(initial.branch);
      expect(failed.worktreePath).toBe(initial.worktreePath);
      expect(failed.backend).toBe(initial.backend);
      expect(failed.createdAt).toBe(initial.createdAt);

      // Round-tripped on disk.
      const onDisk = JSON.parse(
        fs.readFileSync(spawnRecordPath(baseInput.id, home), "utf-8"),
      );
      expect(onDisk).toEqual(failed);

      // Data-model rules for `"failed"` from a pre-container failure:
      // `containerId`, `startedAt`, and `exitCode` remain absent because
      // the failure occurred before container start.
      expect(onDisk.containerId).toBeUndefined();
      expect(onDisk.startedAt).toBeUndefined();
      expect(onDisk.exitCode).toBeUndefined();
    });

    it("accepts an optional error message argument without changing schema", () => {
      // The data model has no slot for an error message today (see SD note in
      // the spawn-record source). Passing one must not throw and must not
      // pollute the persisted record with an unknown field.
      const home = makeHome();
      writeInitialSpawnRecord(baseInput, home);
      const failed = markSpawnRecordFailed(
        baseInput.id,
        { error: "docker build exited non-zero" },
        home,
      );
      expect(failed.status).toBe("failed");
      const onDisk = JSON.parse(
        fs.readFileSync(spawnRecordPath(baseInput.id, home), "utf-8"),
      );
      // Implementation drops the error message — no extraneous field on disk.
      expect(Object.keys(onDisk)).not.toContain("error");
      expect(Object.keys(onDisk)).not.toContain("failureReason");
    });

    it("writes the failed record atomically (no leftover temp files)", () => {
      const home = makeHome();
      writeInitialSpawnRecord(baseInput, home);
      markSpawnRecordFailed(baseInput.id, undefined, home);

      const dir = spawnRecordDir(home);
      const entries = fs.readdirSync(dir);
      expect(entries).toEqual([`${baseInput.id}.json`]);
    });

    it("throws SpawnRecordError when the record file is missing", () => {
      const home = makeHome();
      expect(() =>
        markSpawnRecordFailed(baseInput.id, undefined, home),
      ).toThrow(SpawnRecordError);
    });
  });
});
