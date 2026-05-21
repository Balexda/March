import fs from "node:fs";

/**
 * Shape of `legate-loop-meta.json`, written by `march legate init`
 * (loopMetaFor in src/legate/init.ts) and read by the loop service at startup.
 * Only the fields the runtime/service touch are typed; the lifted runtime body
 * (runtime.ts) reads `meta` loosely, so this is the public surface, not an
 * exhaustive schema.
 */
export interface LoopMeta {
  readonly schema_version: number;
  readonly profile: string;
  readonly paired_legate: string;
  readonly loop_name: string;
  readonly processor_name: string;
  readonly repo: { readonly name: string; readonly path: string };
  readonly march_cli_path: string | null;
  readonly worker_group: string;
  readonly legate_state_path: string;
  readonly loop_log_path: string;
  readonly loop_events_path: string;
  readonly loop_heartbeat_log_path: string;
  readonly loop_heartbeat_events_path: string;
  readonly processor_log_path: string;
  readonly processor_events_path: string;
  readonly legate_conductor_dir: string;
  readonly otel: { readonly enabled: boolean; readonly endpoint: string };
  readonly mode: string;
  // Forward-compatible: tolerate fields this build doesn't know about.
  readonly [key: string]: unknown;
}

/** Read and parse the loop meta file. Throws a friendly error if missing/invalid. */
export function loadMeta(metaPath: string): LoopMeta {
  let raw: string;
  try {
    raw = fs.readFileSync(metaPath, "utf-8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      throw new Error(
        `legate-loop meta not found at ${metaPath}. Pass --meta, set ` +
          `MARCH_LEGATE_LOOP_META, or run from the conductor directory.`,
      );
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`legate-loop meta at ${metaPath} is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`legate-loop meta at ${metaPath} is not an object`);
  }
  return parsed as LoopMeta;
}

/** Resolve the tick interval from env, mirroring the original .mjs default of 60s. */
export function resolveIntervalSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(
    env.MARCH_LEGATE_LOOP_INTERVAL_SECONDS ||
      env.MARCH_PROCESSOR_INTERVAL_SECONDS ||
      "60",
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
}
