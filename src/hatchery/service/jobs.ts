import { randomUUID } from "node:crypto";
import {
  decActiveSpawns,
  incActiveSpawns,
  recordHatcheryDispatch,
  type DispatchOutcome,
} from "../../observability/hatchery-metrics.js";
import { runSpawnInWorker } from "./spawn-runner.js";
import type { HatcherySpawnResult } from "../spawn-handoff.js";
import type { JobRecord, SpawnRequest } from "./types.js";

/** Executes one spawn request. Default runs in a worker; tests inject a fake. */
export type SpawnExecutor = (
  request: SpawnRequest,
) => Promise<HatcherySpawnResult>;

/** Minimal structural logger so JobStore is decoupled from pino/Fastify. */
export interface JobLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const DEFAULT_TERMINAL_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_REAPER_INTERVAL_MS = 5 * 60 * 1000; // 5m

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

/**
 * Drop keys whose value is undefined so the structured log shape stays
 * consistent regardless of the JobLogger implementation (pino already omits
 * undefined keys, but the interface is logger-agnostic).
 */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export interface JobStoreOptions {
  readonly executor?: SpawnExecutor;
  readonly logger?: JobLogger;
  readonly terminalTtlMs?: number;
  /**
   * Best-effort hook invoked after a job succeeds — used to register the spawn
   * + steward with Brood. Failures are logged, never propagated (a missing
   * registry must not fail the spawn).
   */
  readonly onSucceeded?: (
    result: HatcherySpawnResult,
    request: SpawnRequest,
  ) => void | Promise<void>;
}

/**
 * In-memory store of spawn jobs. In-memory is acceptable: spawn records and
 * artifacts already persist to `~/.march`, and a hatchery restart mid-spawn is a
 * recoverable loop re-dispatch. A reaper evicts terminal jobs after a TTL so the
 * map stays bounded.
 */
export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly executor: SpawnExecutor;
  private readonly logger?: JobLogger;
  private readonly terminalTtlMs: number;
  private readonly onSucceeded?: JobStoreOptions["onSucceeded"];
  private reaper?: ReturnType<typeof setInterval>;

  constructor(options: JobStoreOptions = {}) {
    this.executor = options.executor ?? runSpawnInWorker;
    this.logger = options.logger;
    this.terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS;
    this.onSucceeded = options.onSucceeded;
  }

  startReaper(intervalMs: number = DEFAULT_REAPER_INTERVAL_MS): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => this.reapNow(), intervalMs);
    this.reaper.unref();
  }

  stopReaper(): void {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  size(): number {
    return this.jobs.size;
  }

  /** Create a pending job and start executing it (no await). */
  create(request: SpawnRequest): JobRecord {
    const record: JobRecord = {
      id: randomUUID(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(record.id, record);
    // Defer so create() returns a "pending" record (the 202 response value is
    // captured before execution flips it to "running").
    queueMicrotask(() => void this.execute(record, request));
    return record;
  }

  private async execute(
    record: JobRecord,
    request: SpawnRequest,
  ): Promise<void> {
    record.status = "running";
    record.startedAt = new Date().toISOString();
    incActiveSpawns();
    // Common structured fields so every record for this dispatch can be
    // filtered/correlated in Loki by profile, task type, and slice. Undefined
    // request fields are dropped so the log shape is consistent across logger
    // implementations.
    const fields = omitUndefined({
      job_id: record.id,
      backend: request.backend,
      task_name: request.taskName,
      task_type: request.taskType,
      profile: request.profile,
      slice_id: request.sliceId,
    });
    this.logger?.info(fields, "spawn job started");
    try {
      record.result = await this.executor(request);
      record.status = "succeeded";
      this.logger?.info(
        { ...fields, spawn_id: record.result.spawnId },
        "spawn job succeeded",
      );
      this.recordDispatch(request, "success");
      if (this.onSucceeded) {
        try {
          await this.onSucceeded(record.result, request);
        } catch (err) {
          this.logger?.error(
            { ...fields, err: errorMessage(err) },
            "brood registration hook failed",
          );
        }
      }
    } catch (err) {
      record.error = { message: errorMessage(err) };
      record.status = "failed";
      this.logger?.error({ ...fields, err: errorMessage(err) }, "spawn job failed");
      this.recordDispatch(request, "failure");
    } finally {
      record.finishedAt = new Date().toISOString();
      decActiveSpawns();
    }
  }

  /**
   * Emit the dispatch-outcome metric for a terminal job. Labels stay
   * low-cardinality (no spawn/slice ids); task type/profile are trimmed and
   * default to `"unknown"` — mirroring `runHatcherySpawn` — so blank or
   * whitespace values don't fragment the metric series.
   */
  private recordDispatch(request: SpawnRequest, outcome: DispatchOutcome): void {
    recordHatcheryDispatch({
      backend: request.backend,
      taskType: request.taskType?.trim() || "unknown",
      profile: request.profile?.trim() || "unknown",
      outcome,
    });
  }

  /** Evict terminal jobs whose finishedAt is older than the TTL. Returns count removed. */
  reapNow(now: number = Date.now()): number {
    const cutoff = now - this.terminalTtlMs;
    let removed = 0;
    for (const [id, rec] of this.jobs) {
      const terminal = rec.status === "succeeded" || rec.status === "failed";
      if (terminal && rec.finishedAt && Date.parse(rec.finishedAt) < cutoff) {
        this.jobs.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
