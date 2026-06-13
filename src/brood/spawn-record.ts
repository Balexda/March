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
 * Feature 2 writes `"created"` here; Story 5 drives the `created → running`
 * transition; Stories 6–7 drive the remaining transitions.
 */
export type SpawnStatus = "created" | "running" | "stopped" | "failed";

export interface SpawnPatchResult {
  readonly spawnId: string;
  readonly backend: string;
  readonly patchText: string;
  readonly touchedPaths: readonly string[];
  readonly sha256: string;
}

export type ExtractionResult =
  | {
      readonly spawnId: string;
      readonly backend: string;
      readonly status: "succeeded";
      readonly patch: SpawnPatchResult;
      readonly extractedAt: string;
    }
  | {
      readonly spawnId: string;
      readonly backend: string;
      readonly status: "failed";
      readonly failureReason: string;
      readonly diagnostic?: string;
      readonly extractedAt: string;
    };

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
  /**
   * agent-deck session id of the steward launched for this spawn. Populated by
   * the Hatchery handoff so Brood can address the steward during teardown.
   * Forward-compatible (no `version` bump).
   */
  stewardSessionId?: string;
  /**
   * Human-readable failure context. Populated by {@link markSpawnRecordFailed}
   * from its `error` argument. Forward-compatible (no `version` bump).
   */
  failureReason?: string;
  /**
   * Current backend-neutral extraction result for this spawn. Downstream
   * Hatchery handoff reads this field instead of scraping raw backend output.
   * Forward-compatible (no `version` bump).
   */
  extractionResult?: ExtractionResult;
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

/** Output log path for a completed spawn, adjacent to its SpawnRecord. */
export function spawnOutputPath(id: string, homeDir?: string): string {
  return path.join(spawnRecordDir(homeDir), `${id}.output.log`);
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
 * Public reader: load a SpawnRecord by id, returning `undefined` if the file is
 * absent or unreadable (rather than throwing). Used by cross-component callers
 * (e.g. Brood registration) that want best-effort access to the persisted
 * record.
 */
export function loadSpawnRecord(
  id: string,
  homeDir?: string,
): SpawnRecord | undefined {
  try {
    return readSpawnRecord(id, homeDir);
  } catch {
    return undefined;
  }
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
 * The launch and wait stages own the later `"created" → "running"` and
 * `"running" → "stopped" / "failed"` transitions.
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

export function updateSpawnRecordPrompt(
  id: string,
  prompt: string,
  homeDir?: string,
): SpawnRecord {
  const existing = readSpawnRecord(id, homeDir);
  const updated: SpawnRecord = {
    ...existing,
    prompt,
  };
  atomicWriteSpawnRecord(spawnRecordPath(id, homeDir), updated);
  return updated;
}

/**
 * Records the agent-deck steward session id launched for this spawn, so Brood
 * can address the steward during teardown. Atomic write (temp file + rename).
 *
 * @throws {SpawnRecordError} If the source record is missing, unreadable, or
 *   the atomic write fails.
 */
export function updateSpawnRecordStewardSession(
  id: string,
  stewardSessionId: string,
  homeDir?: string,
): SpawnRecord {
  const existing = readSpawnRecord(id, homeDir);
  const updated: SpawnRecord = {
    ...existing,
    stewardSessionId,
  };
  atomicWriteSpawnRecord(spawnRecordPath(id, homeDir), updated);
  return updated;
}

export function updateSpawnRecordExtractionResult(
  id: string,
  extractionResult: ExtractionResult,
  homeDir?: string,
): SpawnRecord {
  const existing = readSpawnRecord(id, homeDir);
  const updated: SpawnRecord = {
    ...existing,
    extractionResult,
  };
  atomicWriteSpawnRecord(spawnRecordPath(id, homeDir), updated);
  return updated;
}

export function readSpawnRecordExtractionResult(
  id: string,
  homeDir?: string,
): ExtractionResult | undefined {
  return readSpawnRecord(id, homeDir).extractionResult;
}

/**
 * Options accepted by {@link markSpawnRecordFailed}.
 *
 * `error` is persisted to the record's {@link SpawnRecord.failureReason} field
 * so downstream consumers (Brood `inspect`, the teardown archive) can surface
 * *why* a spawn failed instead of a bare `failed` status.
 */
export interface MarkSpawnRecordFailedOptions {
  error?: string;
}

/**
 * Transitions an existing SpawnRecord from `"created"` (or any other
 * pre-`"failed"` state) to `"failed"`, populating `stoppedAt` with the
 * current ISO 8601 timestamp. Implements the data-model `created →
 * failed` transition for Story 4's failure paths (snapshot, Docker
 * build, or `imageId` record-update failure) and Story 5's failure
 * paths (container launch or `containerId` record-update failure).
 *
 * The optional `error` argument is persisted to `failureReason` — see
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
  const existing = readSpawnRecord(id, homeDir);
  const updated: SpawnRecord = {
    ...existing,
    status: "failed",
    stoppedAt: new Date().toISOString(),
    ...(options?.error ? { failureReason: options.error } : {}),
  };
  atomicWriteSpawnRecord(spawnRecordPath(id, homeDir), updated);
  return updated;
}

/**
 * Transitions an existing SpawnRecord from `"created"` to `"running"`,
 * populating `containerId` (from the captured `docker create` stdout) and
 * `startedAt` (current ISO 8601 timestamp). Implements the data-model
 * `created → running` transition for Stage 4 (FR-019).
 *
 * Refuses to operate on a record whose `status` is not `"created"` — the
 * data model defines `created → running` as a strict transition, so
 * applying it to a record that is already `"running"`, `"stopped"`, or
 * `"failed"` would silently double-write `startedAt` or resurrect a
 * terminated spawn. A `SpawnRecordError` is thrown in that case.
 *
 * The wait stage owns transitions out of `"running"` (`running → stopped`
 * and `running → failed`); this helper does not touch those.
 *
 * Atomic write (temp file + rename) — semantics match
 * {@link updateSpawnRecordImageId} and {@link markSpawnRecordFailed} so a
 * crash mid-write cannot corrupt the existing record.
 *
 * @throws {SpawnRecordError} If the source record is missing, unreadable,
 *   not in the `"created"` state, or the atomic write fails.
 */
export function markSpawnRecordRunning(
  id: string,
  containerId: string,
  homeDir?: string,
): SpawnRecord {
  const existing = readSpawnRecord(id, homeDir);
  if (existing.status !== "created") {
    throw new SpawnRecordError(
      `Cannot transition spawn record "${id}" to "running": current status is "${existing.status}"; the data-model only permits "created" → "running".`,
    );
  }
  const updated: SpawnRecord = {
    ...existing,
    status: "running",
    containerId,
    startedAt: new Date().toISOString(),
  };
  atomicWriteSpawnRecord(spawnRecordPath(id, homeDir), updated);
  return updated;
}

export function markSpawnRecordStopped(
  id: string,
  exitCode: number,
  homeDir?: string,
): SpawnRecord {
  const existing = readSpawnRecord(id, homeDir);
  if (existing.status !== "running") {
    throw new SpawnRecordError(
      `Cannot transition spawn record "${id}" to "stopped": current status is "${existing.status}"; the data-model only permits "running" → "stopped".`,
    );
  }
  const updated: SpawnRecord = {
    ...existing,
    status: exitCode === 0 ? "stopped" : "failed",
    exitCode,
    stoppedAt: new Date().toISOString(),
  };
  atomicWriteSpawnRecord(spawnRecordPath(id, homeDir), updated);
  return updated;
}
