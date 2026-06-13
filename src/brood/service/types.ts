/**
 * Brood session-registry wire + storage types.
 *
 * Brood is the session-state + lifecycle/teardown authority for March. Every
 * containerized or interactive session the system manages — a headless spawn,
 * its PR-steward agent-deck session, or a long-lived legate — is tracked here as
 * a {@link SessionRecord}. The registry is the single source of truth teardown
 * reads to remove artifacts by *exact tracked path* (never a blanket prune).
 */

/**
 * The kind of managed session. A `spawn` is the headless container executor; a
 * `steward` is the agent-deck session that turns spawn output into a PR (one per
 * spawn, sharing the spawn's worktree); a `legate` is a long-lived orchestrator
 * container. The discriminator lets a steward row point back at its spawn via
 * {@link SessionRecord.parentId}.
 */
export type SessionKind = "spawn" | "steward" | "legate";

/**
 * Lifecycle status. `created | running | stopped | failed` mirror the persisted
 * `SpawnStatus` so imported spawn records map 1:1. `tearing-down` and `torndown`
 * are brood-owned teardown states — a record is never deleted, so "disposed" is
 * derived from `torndown`.
 */
export type SessionStatus =
  | "created"
  | "running"
  | "stopped"
  | "failed"
  | "tearing-down"
  | "torndown";

export type ExtractionBackend = "claude-code" | "codex";

export interface SpawnPatch {
  spawnId: string;
  backend: ExtractionBackend;
  patchText: string;
  touchedPaths: string[];
  sha256: string;
}

export type ExtractionResult =
  | {
      spawnId: string;
      backend: ExtractionBackend;
      status: "succeeded";
      patch: SpawnPatch;
      diagnostic?: string;
      extractedAt: string;
    }
  | {
      spawnId: string;
      backend: ExtractionBackend;
      status: "failed";
      failureReason: string;
      diagnostic?: string;
      extractedAt: string;
    };

/** A managed session as stored in the registry and surfaced over the API. */
export interface SessionRecord {
  /** Spawn id, steward agent-deck session id, or legate conductor name. */
  id: string;
  kind: SessionKind;
  status: SessionStatus;
  /** For a steward row, the spawn id it belongs to. */
  parentId?: string;
  /** Absolute source repository root. */
  repoPath?: string;
  /** Git branch created for the session (`march/spawn/<id>` for spawns). */
  branch?: string;
  /** Absolute worktree path — the load-bearing field for safe teardown. */
  worktreePath?: string;
  /** Docker container id (spawn / legate). */
  containerId?: string;
  /** agent-deck session id of the steward (also the steward row's `id`). */
  agentDeckSessionId?: string;
  /** agent-deck profile, needed to address `agent-deck -p <profile> ...`. */
  profile?: string;
  /** agent-deck group. */
  group?: string;
  backend?: string;
  /** Current persisted Feature 5 extraction result, when extraction has completed. */
  extractionResult?: ExtractionResult;
  imageId?: string;
  exitCode?: number;
  /** Human-readable failure context (closes the dropped-error gap in spawn-record). */
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
  torndownAt?: string;
}

/** Fields accepted when registering a session (idempotent upsert on `id`). */
export interface RegisterSessionInput {
  id: string;
  kind: SessionKind;
  status?: SessionStatus;
  parentId?: string;
  repoPath?: string;
  branch?: string;
  worktreePath?: string;
  containerId?: string;
  agentDeckSessionId?: string;
  profile?: string;
  group?: string;
  backend?: string;
  extractionResult?: ExtractionResult;
  imageId?: string;
  exitCode?: number;
  failureReason?: string;
}

/** Mutable fields accepted on a lifecycle update. Only defined keys are applied. */
export interface UpdateSessionInput {
  status?: SessionStatus;
  containerId?: string;
  imageId?: string;
  exitCode?: number;
  failureReason?: string;
  agentDeckSessionId?: string;
  worktreePath?: string;
  branch?: string;
  profile?: string;
  group?: string;
  extractionResult?: ExtractionResult;
  startedAt?: string;
  stoppedAt?: string;
  torndownAt?: string;
}

/** Filter for {@link SessionStore.list}. Omitted fields match everything. */
export interface ListSessionsFilter {
  kind?: SessionKind;
  status?: SessionStatus;
  parentId?: string;
}

/** Body of `POST /sessions/:id/teardown`. */
export interface TeardownRequest {
  /** Tear down even a `running` session. */
  force?: boolean;
  /** SIGKILL the container immediately instead of `docker stop` then `rm`. */
  kill?: boolean;
  /** Operator-supplied reason, recorded as `failureReason`. */
  reason?: string;
}

/** Outcome of a single teardown step. */
export interface TeardownStep {
  step: "archive" | "container" | "steward" | "worktree" | "branch";
  outcome: "ok" | "skipped" | "failed";
  detail?: string;
}

/** Result of a teardown request. */
export interface TeardownResult {
  id: string;
  status: SessionStatus;
  steps: TeardownStep[];
  warnings: string[];
}
