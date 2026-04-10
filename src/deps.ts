import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Represents a dependency that should be checked during init.
 */
export interface InitDependency {
  /** The executable name to look for on PATH (e.g., "git"). */
  readonly name: string;

  /** The warning message to print to stderr if the executable is not found. */
  readonly warning: string;
}

/**
 * Dependencies checked during `march init`. Missing dependencies produce
 * warnings on stderr but do not block initialization.
 */
export const INIT_DEPENDENCIES: readonly InitDependency[] = [
  {
    name: "git",
    warning: "git not found \u2014 required for spawn operations.",
  },
  {
    name: "docker",
    warning: "Docker not found \u2014 required for spawn operations.",
  },
];

/** The finder binary used to locate executables on PATH. */
export const FINDER_BIN = process.platform === "win32" ? "where" : "which";

/**
 * Returns `true` if the finder binary (`which` on Unix, `where` on Windows)
 * is itself present on PATH.
 *
 * Scans PATH entries directly using `fs.existsSync` to avoid the circularity
 * of using `which` to find `which`. When this returns `false`, `isOnPath`
 * cannot produce reliable results and callers should emit a single
 * "cannot detect" warning rather than per-dependency false-negatives.
 */
export function isFinderAvailable(): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      return fs.existsSync(path.join(dir, FINDER_BIN));
    } catch {
      return false;
    }
  });
}

/**
 * Checks whether a given executable is available on the system PATH.
 *
 * Uses `which` on Unix-like systems and `where` on Windows via
 * `execFileSync` (no shell, no injection risk). stdout and stderr are
 * silenced. Any error (including command not found) returns false.
 *
 * Only call this after confirming `isFinderAvailable()` returns true;
 * otherwise a missing finder binary will produce false-negative results.
 *
 * @param executable - The name of the executable to search for.
 * @returns `true` if the executable is found on PATH, `false` otherwise.
 */
export function isOnPath(executable: string): boolean {
  try {
    execFileSync(FINDER_BIN, [executable], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
