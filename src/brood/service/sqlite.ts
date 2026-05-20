import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";

/**
 * `node:sqlite` loader.
 *
 * `node:sqlite` is a builtin only on Node >= 22.5 (it throws
 * `ERR_UNKNOWN_BUILTIN_MODULE` on older runtimes). March's services ship on
 * node:22 images and `march brood serve` is a container entrypoint, but the
 * published CLI and CI still run on Node 20 for non-brood commands — so this
 * module must load WITHOUT throwing at import time. The module is loaded via a
 * runtime `require` (after the warning suppressor) and any failure is captured;
 * {@link getDatabaseSync} throws a clear error only when the registry is
 * actually constructed.
 *
 * The runtime `require` (not a static `import ... from "node:sqlite"`) also
 * keeps the warning suppressor ordered correctly even after tsup/esbuild
 * bundling, which would otherwise hoist a static import above this code.
 */
let databaseSyncImpl: typeof DatabaseSyncCtor | undefined;
let loadError: Error | undefined;

// Suppress only the one-time ExperimentalWarning node:sqlite prints on load,
// then restore the original emitter immediately so the global patch does not
// outlive the require.
const originalEmitWarning = process.emitWarning.bind(process);
try {
  process.emitWarning = function patchedEmitWarning(
    warning: string | Error,
    ...rest: unknown[]
  ): void {
    const message =
      typeof warning === "string" ? warning : (warning?.message ?? "");
    if (message.includes("SQLite is an experimental feature")) return;
    (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
  } as typeof process.emitWarning;

  const nodeRequire = createRequire(import.meta.url);
  databaseSyncImpl = (
    nodeRequire("node:sqlite") as typeof import("node:sqlite")
  ).DatabaseSync;
} catch (err) {
  loadError = err as Error;
} finally {
  process.emitWarning = originalEmitWarning;
}

/** True when `node:sqlite` is available (Node >= 22.5). */
export const sqliteAvailable = databaseSyncImpl !== undefined;

/**
 * The `node:sqlite` `DatabaseSync` constructor. Throws a clear, actionable
 * error on a runtime where `node:sqlite` is unavailable.
 */
export function getDatabaseSync(): typeof DatabaseSyncCtor {
  if (!databaseSyncImpl) {
    throw new Error(
      "Brood's registry requires node:sqlite (Node >= 22.5). " +
        "Run `march brood serve` on Node 22 — the container image is node:22. " +
        `(${loadError?.message ?? "node:sqlite unavailable"})`,
    );
  }
  return databaseSyncImpl;
}

/** An open `DatabaseSync` instance. */
export type BroodDatabase = InstanceType<typeof DatabaseSyncCtor>;
