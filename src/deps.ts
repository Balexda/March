import { execFileSync } from "node:child_process";

/**
 * Represents a dependency that should be checked during init.
 */
export interface InitDependency {
  /** The executable name to look for on PATH (e.g., "git"). */
  name: string;

  /** The warning message to print to stderr if the executable is not found. */
  warning: string;
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

/**
 * Checks whether a given executable is available on the system PATH.
 *
 * Uses `which` on Unix-like systems and `where` on Windows via
 * `execFileSync` (no shell, no injection risk). stdout and stderr are
 * silenced. Any error (including command not found) returns false.
 *
 * @param executable - The name of the executable to search for.
 * @returns `true` if the executable is found on PATH, `false` otherwise.
 */
export function isOnPath(executable: string): boolean {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(finder, [executable], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
