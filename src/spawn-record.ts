import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Current SpawnRecord schema version. Fixed at 1 for Feature 2.
 * Downstream features evolve the schema forward-compatibly via this field.
 */
export const SPAWN_RECORD_VERSION = 1;

/** Default backend identifier — hardcoded to Claude Code for Feature 2. */
export const DEFAULT_BACKEND = "claude-code";

/**
 * Lifecycle states for a SpawnRecord, as defined by the data model.
 * Feature 2 writes `"created"` here; Stories 4–7 drive the remaining
 * transitions.
 */
export type SpawnStatus = "created" | "running" | "stopped" | "failed";

/**
 * Structure of a SpawnRecord JSON file at `~/.march/spawns/<spawn-id>.json`.
 *
 * This slice writes only the fields required for the `"created"` state;
 * later stories (4–7) populate the conditional fields as the spawn
 * progresses through its lifecycle.
 */
export interface SpawnRecord {
  /** Schema version. */
  version: number;
  /** SpawnId — format `YYYYMMDD-<6-char-hex>`. */
  id: string;
  /** Absolute path to the source git repository root. */
  repoPath: string;
  /** Git branch name created for this spawn. */
  branch: string;
  /** Absolute path to the spawn's worktree directory. */
  worktreePath: string;
  /** Backend identifier (e.g. `"claude-code"`). */
  backend: string;
  /** Current lifecycle status. */
  status: SpawnStatus;
  /** ISO 8601 timestamp of when the spawn was created. */
  createdAt: string;

  // --- Conditional fields populated by later stories ---
  containerId?: string;
  imageId?: string;
  exitCode?: number;
  /**
   * Raw operator prompt. The data model marks this Yes/required, but
   * per SD-004 in the Story 4 tasks file, Feature 2 defers prompt
   * reading to Story 6 — the initial `"created"` record is written
   * without a `prompt` field, and Story 6 populates it before any
   * downstream consumer reads the record.
   */
  prompt?: string;
  startedAt?: string;
  stoppedAt?: string;
  timedOut?: boolean;
}

/** Inputs required to write the initial `"created"` spawn record. */
export interface CreateSpawnRecordInput {
  id: string;
  repoPath: string;
  branch: string;
  worktreePath: string;
  backend?: string;
}

/** Error thrown by SpawnRecord I/O operations. */
export class SpawnRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnRecordError";
  }
}

/**
 * Absolute path to `<home>/.march/spawns/`. Accepts an optional homeDir
 * override so tests can point at an isolated directory.
 */
export function spawnRecordDir(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), ".march", "spawns");
}

/**
 * Absolute path to the SpawnRecord file for a given spawn ID, under
 * `<home>/.march/spawns/<id>.json`.
 */
export function spawnRecordPath(id: string, homeDir?: string): string {
  return path.join(spawnRecordDir(homeDir), `${id}.json`);
}

/**
 * Writes the initial SpawnRecord file with status `"created"` per the
 * data model's `absent → created` transition (FR-019).
 *
 * Creates `<home>/.march/spawns/` on demand if it does not yet exist,
 * covering the spec edge case about first-time spawn dispatch.
 *
 * @param input - Spawn ID, repo root, branch, worktree path, and optional
 *   backend override captured by the worktree step.
 * @param homeDir - Override home directory (defaults to `os.homedir()`).
 * @returns The written record.
 * @throws {SpawnRecordError} If directory creation or file write fails.
 */
export function writeInitialSpawnRecord(
  input: CreateSpawnRecordInput,
  homeDir?: string,
): SpawnRecord {
  const record: SpawnRecord = {
    version: SPAWN_RECORD_VERSION,
    id: input.id,
    repoPath: input.repoPath,
    branch: input.branch,
    worktreePath: input.worktreePath,
    backend: input.backend ?? DEFAULT_BACKEND,
    status: "created",
    createdAt: new Date().toISOString(),
  };

  const dir = spawnRecordDir(homeDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new SpawnRecordError(
      `Failed to create spawn record directory "${dir}": ${(err as Error).message}`,
    );
  }

  const filePath = spawnRecordPath(input.id, homeDir);
  try {
    // `flag: "wx"` creates the file exclusively — if a SpawnRecord
    // already exists at this path (e.g., an ID collision survived the
    // worktree collision check, or a stale record was left behind),
    // refuse to overwrite it and surface an explicit error.
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "EEXIST") {
      throw new SpawnRecordError(
        `Spawn record already exists at "${filePath}" and will not be overwritten.`,
      );
    }
    throw new SpawnRecordError(
      `Failed to write spawn record at "${filePath}": ${error.message}`,
    );
  }
  return record;
}

/**
 * Deletes the SpawnRecord file for a given spawn ID. Idempotent: if the
 * file is already absent, returns silently. Used by the dispatch action
 * to roll back a partially written record when a later stage fails.
 */
export function removeSpawnRecord(id: string, homeDir?: string): void {
  const filePath = spawnRecordPath(id, homeDir);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // best-effort — treat as idempotent
  }
}

/**
 * Reads and parses an existing SpawnRecord from disk. Throws
 * `SpawnRecordError` if the file is missing or unreadable, or if the
 * contents are not valid JSON.
 */
function readSpawnRecord(id: string, homeDir?: string): SpawnRecord {
  const filePath = spawnRecordPath(id, homeDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      throw new SpawnRecordError(
        `Spawn record not found at "${filePath}".`,
      );
    }
    throw new SpawnRecordError(
      `Failed to read spawn record at "${filePath}": ${error.message}`,
    );
  }
  try {
    return JSON.parse(raw) as SpawnRecord;
  } catch (err) {
    throw new SpawnRecordError(
      `Failed to parse spawn record at "${filePath}": ${(err as Error).message}`,
    );
  }
}

/**
 * Writes a SpawnRecord to disk atomically. Writes a sibling temp file
 * first (so it lives on the same filesystem as the target, guaranteeing
 * `rename` is atomic), then renames it over the target path. If any step
 * fails, the temp file is best-effort removed before re-raising.
 *
 * The temp filename uses a random suffix from `crypto.randomBytes` so
 * concurrent dispatches cannot collide on the temp name.
 */
function atomicWriteSpawnRecord(
  filePath: string,
  record: SpawnRecord,
): void {
  const suffix = crypto.randomBytes(6).toString("hex");
  const tmpPath = `${filePath}.tmp-${suffix}`;
  const payload = JSON.stringify(record, null, 2) + "\n";
  try {
    fs.writeFileSync(tmpPath, payload, { encoding: "utf-8" });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup: if the rename failed (or the write failed
    // partway through), make sure we don't leave a half-written temp
    // file behind.
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
    throw new SpawnRecordError(
      `Failed to atomically write spawn record at "${filePath}": ${(err as Error).message}`,
    );
  }
}

/**
 * Updates an existing SpawnRecord with the `imageId` produced by a
 * successful Docker image build (Story 4 / FR-019). Reads the record at
 * `spawnRecordPath(id)`, sets `imageId`, and writes the result back
 * atomically (temp file + rename) so a crash mid-write cannot corrupt
 * the existing record.
 *
 * This helper does NOT modify `status` — the record remains `"created"`.
 * Story 5 owns the `"created" → "running"` transition (container start);
 * Story 7 owns `"running" → "stopped" / "failed"`.
 *
 * @throws {SpawnRecordError} If the source record is missing, unreadable,
 *   or the atomic write fails.
 */
export function updateSpawnRecordImageId(
  id: string,
  imageId: string,
  homeDir?: string,
): SpawnRecord {
  const existing = readSpawnRecord(id, homeDir);
  const updated: SpawnRecord = {
    ...existing,
    imageId,
  };
  atomicWriteSpawnRecord(spawnRecordPath(id, homeDir), updated);
  return updated;
}

/**
 * Options accepted by {@link markSpawnRecordFailed}.
 *
 * Note: `error` is currently dropped because the SpawnRecord data model
 * has no slot for an error message. The argument is accepted today so
 * callers (e.g., the dispatch rollback path in Story 4 task 4) can pass
 * a contextual message without the call site changing when the data
 * model gains a `failureReason` (or similar) field. When that slot is
 * added, this helper should persist the message into the new field.
 */
export interface MarkSpawnRecordFailedOptions {
  error?: string;
}

/**
 * Transitions an existing SpawnRecord from `"created"` (or any other
 * pre-`"failed"` state) to `"failed"`, populating `stoppedAt` with the
 * current ISO 8601 timestamp. Implements the data-model `created →
 * failed` transition for Story 4's failure paths (snapshot, Docker
 * build, or `imageId` record-update failure).
 *
 * The optional `error` argument is currently dropped — see
 * {@link MarkSpawnRecordFailedOptions}.
 *
 * Atomic write (temp file + rename); a crash mid-write cannot corrupt
 * the existing record.
 *
 * @throws {SpawnRecordError} If the source record is missing, unreadable,
 *   or the atomic write fails.
 */
export function markSpawnRecordFailed(
  id: string,
  options?: MarkSpawnRecordFailedOptions,
  homeDir?: string,
): SpawnRecord {
  // The `error` field on `options` is accepted for forward compatibility
  // but currently dropped — see the JSDoc on
  // `MarkSpawnRecordFailedOptions`.
  void options;

  const existing = readSpawnRecord(id, homeDir);
  const updated: SpawnRecord = {
    ...existing,
    status: "failed",
    stoppedAt: new Date().toISOString(),
  };
  atomicWriteSpawnRecord(spawnRecordPath(id, homeDir), updated);
  return updated;
}

/**
 * Transitions an existing SpawnRecord from `"created"` to `"running"`,
 * populating `containerId` (from the captured `docker run -d` stdout) and
 * `startedAt` (current ISO 8601 timestamp). Implements the data-model
 * `created → running` transition for Stage 4 (FR-019).
 *
 * Story 7 owns transitions out of `"running"` (`running → stopped` and
 * `running → failed`); this helper does not touch those.
 *
 * Atomic write (temp file + rename) — semantics match
 * {@link updateSpawnRecordImageId} and {@link markSpawnRecordFailed} so a
 * crash mid-write cannot corrupt the existing record.
 *
 * @throws {SpawnRecordError} If the source record is missing, unreadable,
 *   or the atomic write fails.
 */
export function markSpawnRecordRunning(
  id: string,
  containerId: string,
  homeDir?: string,
): SpawnRecord {
  const existing = readSpawnRecord(id, homeDir);
  const updated: SpawnRecord = {
    ...existing,
    status: "running",
    containerId,
    startedAt: new Date().toISOString(),
  };
  atomicWriteSpawnRecord(spawnRecordPath(id, homeDir), updated);
  return updated;
}
