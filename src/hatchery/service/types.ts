import type { HatcherySpawnResult } from "../spawn-handoff.js";

/**
 * Wire shape for a spawn request. Mirrors {@link HatcherySpawnOptions} but with
 * `backend` as a NAME string (resolved server-side) so the payload is JSON-safe.
 * `repoPath` is resolved host-side by the client (only the caller knows its repo)
 * and must be valid INSIDE the container — the repo + worktree-parent dir is
 * bind-mounted at the identical absolute path.
 */
export interface SpawnRequest {
  readonly prompt: string;
  readonly backend: string;
  readonly repoPath: string;
  readonly agentDeckProfile?: string;
  readonly managerGroup?: string;
  readonly title?: string;
  readonly branch?: string;
  readonly profile?: string;
  readonly taskType?: string;
  readonly taskName?: string;
  readonly sliceId?: string;
  /** Per-profile worker toolchain override (issue #287); `auto`/undefined → detect. */
  readonly toolchain?: string;
}

export type JobStatus = "pending" | "running" | "succeeded" | "failed";

export interface JobError {
  readonly message: string;
}

/** A spawn job tracked by the service. `id` is a server UUID, distinct from the inner spawnId. */
export interface JobRecord {
  readonly id: string;
  status: JobStatus;
  readonly createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: HatcherySpawnResult;
  error?: JobError;
}

/** Message posted from the spawn worker thread back to the service. */
export type SpawnWorkerMessage =
  | { readonly ok: true; readonly result: HatcherySpawnResult }
  | { readonly ok: false; readonly error: string };

/** workerData passed into the spawn worker thread. */
export interface SpawnWorkerData {
  readonly request: SpawnRequest;
}
