/**
 * @l0 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  derivedStatus,
  listSpawnRecords,
  loadSpawnRecord,
  type SpawnIndexWarning,
} from "./spawn-index.js";
import {
  DEFAULT_BACKEND,
  SPAWN_RECORD_VERSION,
  spawnRecordDir,
  spawnRecordPath,
  type SpawnRecord,
} from "./spawn-record.js";

describe("spawn-index", () => {
  const tmpDirs: string[] = [];

  function makeHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-home-"));
    tmpDirs.push(dir);
    return dir;
  }

  function record(id: string, overrides: Partial<SpawnRecord> = {}): SpawnRecord {
    return {
      version: SPAWN_RECORD_VERSION,
      id,
      repoPath: "/abs/repo",
      branch: `march/spawn/${id}`,
      worktreePath: `/abs/worktrees/march/${id}`,
      backend: DEFAULT_BACKEND,
      status: "created",
      createdAt: "2026-06-13T00:00:00.000Z",
      ...overrides,
    };
  }

  function writeRecord(home: string, value: SpawnRecord): void {
    fs.mkdirSync(spawnRecordDir(home), { recursive: true });
    fs.writeFileSync(
      spawnRecordPath(value.id, home),
      JSON.stringify(value, null, 2) + "\n",
      "utf-8",
    );
  }

  function makeWorktree(home: string, id: string): string {
    const worktreePath = path.join(home, "worktrees", id);
    fs.mkdirSync(worktreePath, { recursive: true });
    return worktreePath;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("returns valid records from the configured spawn-record directory", () => {
    const home = makeHome();
    const first = record("20260613-a11111");
    const second = record("20260613-b22222", { status: "running" });
    writeRecord(home, second);
    writeRecord(home, first);
    fs.writeFileSync(
      path.join(spawnRecordDir(home), "20260613-b22222.output.log"),
      "ignored",
    );

    expect(listSpawnRecords({ homeDir: home })).toEqual([first, second]);
  });

  it("retries a list parse failure once before accepting the record", () => {
    const home = makeHome();
    const value = record("20260613-retry1");
    writeRecord(home, value);
    const filePath = spawnRecordPath(value.id, home);
    const realRead = fs.readFileSync.bind(fs);
    const read = vi.spyOn(fs, "readFileSync");
    let targetReads = 0;
    read.mockImplementation((target, options) => {
      if (target === filePath) {
        targetReads += 1;
        if (targetReads === 1) {
          return "{";
        }
      }
      return realRead(target, options);
    });
    const warn = vi.fn();

    expect(listSpawnRecords({ homeDir: home, warn })).toEqual([value]);
    expect(
      read.mock.calls.filter((call) => call[0] === filePath),
    ).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips still-corrupt records with a warning while returning other records", () => {
    const home = makeHome();
    const value = record("20260613-good01");
    writeRecord(home, value);
    fs.writeFileSync(spawnRecordPath("20260613-bad001", home), "{", "utf-8");
    const warnings: SpawnIndexWarning[] = [];

    expect(
      listSpawnRecords({
        homeDir: home,
        warn: (warning) => warnings.push(warning),
      }),
    ).toEqual([value]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.filePath).toBe(spawnRecordPath("20260613-bad001", home));
    expect(warnings[0]?.error.message).toMatch(/JSON/);
  });

  it("accepts profile-less records through the public reader API", () => {
    const home = makeHome();
    const value = record("20260613-noprof");
    writeRecord(home, value);

    const [listed] = listSpawnRecords(home);
    expect(listed).toEqual(value);
    expect("profile" in listed!).toBe(false);
  });

  it("loads a known id and returns undefined for an unknown id", () => {
    const home = makeHome();
    const value = record("20260613-known1", { failureReason: "build failed" });
    writeRecord(home, value);

    expect(loadSpawnRecord(value.id, home)).toEqual(value);
    expect(loadSpawnRecord("20260613-absent", home)).toBeUndefined();
  });

  it("treats a traversal id as not-found without escaping the spawn dir", () => {
    const home = makeHome();

    expect(loadSpawnRecord("../escape", home)).toBeUndefined();
    expect(loadSpawnRecord("sub/nested", home)).toBeUndefined();
  });

  it("returns an empty list when the spawn-record directory is absent", () => {
    const home = makeHome();

    expect(listSpawnRecords({ homeDir: home })).toEqual([]);
    expect(fs.existsSync(spawnRecordDir(home))).toBe(false);
  });

  it("derives attention and container liveness from persisted statuses", () => {
    const home = makeHome();
    const statuses: Array<[SpawnRecord["status"], boolean, boolean]> = [
      ["created", false, false],
      ["running", false, true],
      ["stopped", false, false],
      ["failed", true, false],
    ];

    for (const [status, needsAttention, containerLive] of statuses) {
      const value = record(`20260613-${status}`, {
        status,
        worktreePath: makeWorktree(home, status),
      });

      expect(derivedStatus(value)).toEqual({
        record: value,
        needsAttention,
        disposed: false,
        containerLive,
      });
    }
  });

  it("derives disposed when the record's worktree path is absent", () => {
    const value = record("20260613-gone01", {
      status: "stopped",
      worktreePath: path.join(makeHome(), "missing-worktree"),
    });

    expect(derivedStatus(value)).toMatchObject({
      record: value,
      needsAttention: false,
      disposed: true,
      containerLive: false,
    });
  });

  it("does not persist derived view fields or status values during derivation", () => {
    const home = makeHome();
    const value = record("20260613-pure01", {
      status: "failed",
      worktreePath: path.join(home, "missing-worktree"),
    });
    writeRecord(home, value);
    const before = fs.readFileSync(spawnRecordPath(value.id, home), "utf-8");

    expect(derivedStatus(value)).toMatchObject({
      needsAttention: true,
      disposed: true,
      containerLive: false,
    });

    const after = fs.readFileSync(spawnRecordPath(value.id, home), "utf-8");
    expect(after).toBe(before);
    expect(JSON.parse(after)).toEqual(value);
    expect(after).not.toContain("needsAttention");
    expect(after).not.toContain("needs-attention");
    expect(after).not.toContain("disposed");
  });
});
