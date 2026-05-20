import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";

/**
 * `node:sqlite` loader that suppresses *only* the one-time ExperimentalWarning
 * Node prints when the module is first loaded.
 *
 * The module is loaded via a runtime `require` rather than a static
 * `import ... from "node:sqlite"` on purpose: a static import is hoisted (and,
 * after tsup/esbuild bundling, hoisted above any sibling code), so the warning
 * would fire before a suppressor could install. Loading it through `require`
 * here — after the `process.emitWarning` patch below — guarantees the
 * suppressor runs first regardless of bundling.
 */
const originalEmitWarning = process.emitWarning.bind(process);
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
const sqlite = nodeRequire("node:sqlite") as typeof import("node:sqlite");

/** The `node:sqlite` `DatabaseSync` constructor (warning suppressed at load). */
export const DatabaseSync = sqlite.DatabaseSync;

/** An open `DatabaseSync` instance. */
export type BroodDatabase = InstanceType<typeof DatabaseSyncCtor>;
