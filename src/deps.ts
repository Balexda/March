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
 * Returns the PATHEXT extensions to try when probing for an executable.
 * On Windows, `fs.existsSync("where")` misses `where.exe` because it does
 * not perform PATHEXT resolution the way the shell does. This helper parses
 * `process.env.PATHEXT` (falling back to a sensible default) and returns
 * the extensions to append. On non-Windows platforms, returns an empty array
 * so only the bare name is checked.
 */
function getPathExtensions(): string[] {
  if (process.platform !== "win32") return [];
  const raw = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").filter(Boolean);
}

/**
 * Returns `true` if the finder binary (`which` on Unix, `where` on Windows)
 * is itself present on PATH.
 *
 * Scans PATH entries directly using `fs.existsSync` to avoid the circularity
 * of using `which` to find `which`. On Windows, also checks with each PATHEXT
 * extension (e.g., `where.exe`) because `existsSync` does not perform the
 * shell's automatic extension resolution.
 *
 * When this returns `false`, `isOnPath` cannot produce reliable results and
 * callers should emit a single "cannot detect" warning rather than
 * per-dependency false-negatives.
 */
export function isFinderAvailable(): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = getPathExtensions();
  return dirs.some((dir) => {
    try {
      // Check bare name (works on Unix; may also match on Windows if the
      // file has no extension).
      if (fs.existsSync(path.join(dir, FINDER_BIN))) return true;
      // On Windows, try each PATHEXT extension (e.g., where.exe).
      return extensions.some((ext) =>
        fs.existsSync(path.join(dir, FINDER_BIN + ext.toLowerCase())),
      );
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

/**
 * Result of a spawn dependency check. Either all required dependencies are
 * present (`ok: true`) or one or more are missing (`ok: false` with a
 * human-readable `error` message suitable for writing to stderr).
 */
export type DependencyCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/**
 * Checks whether all hard dependencies for spawn operations are available.
 * Validates in order: finder availability, git on PATH, docker on PATH,
 * git repository context, and base container image accessibility.
 *
 * Returns a structured result so the caller can decide how to present the
 * outcome (stderr message, exit code, etc.).
 *
 * **Fail-safe behavior**: if `isFinderAvailable()` returns false we cannot
 * reliably determine whether git/docker are present. Rather than silently
 * assuming they are (which would lead to a cryptic `execFileSync` failure
 * later), we report a blocking error. This differs from the init-time path,
 * which emits a soft warning, because spawn actually requires these tools
 * to function.
 *
 * @param baseImage - The tagged base container image to verify is accessible.
 */
export function checkSpawnDependencies(
  baseImage: string,
): DependencyCheckResult {
  if (!isFinderAvailable()) {
    return {
      ok: false,
      error:
        "Cannot verify spawn dependencies: unable to locate the path-search utility. Ensure your PATH is configured correctly.",
    };
  }

  if (!isOnPath("git")) {
    return {
      ok: false,
      error: "git not found \u2014 required for spawn operations",
    };
  }

  if (!isOnPath("docker")) {
    return {
      ok: false,
      error: "Docker not found \u2014 required for spawn operations",
    };
  }

  // Check that we are inside a git repository.
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], { stdio: "ignore" });
  } catch {
    return {
      ok: false,
      error:
        "Not inside a git repository \u2014 march spawn must be run from within a git repo.",
    };
  }

  // Check that the base container image is accessible (locally or pullable).
  try {
    execFileSync("docker", ["image", "inspect", baseImage], {
      stdio: "ignore",
    });
  } catch {
    // Image not available locally — try pulling it.
    try {
      execFileSync("docker", ["pull", baseImage], { stdio: "ignore" });
    } catch {
      return {
        ok: false,
        error: `Base container image "${baseImage}" is not available locally and could not be pulled.`,
      };
    }
  }

  return { ok: true };
}
