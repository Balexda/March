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
   * per SD-004 in the Story 3 tasks file, Feature 2 defers prompt
   * reading to Story 6 — Story 3 writes the initial `"created"` record
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
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", "utf-8");
  } catch (err) {
    throw new SpawnRecordError(
      `Failed to write spawn record at "${filePath}": ${(err as Error).message}`,
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
