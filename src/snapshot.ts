import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Error thrown by snapshot operations. Carries a human-readable message
 * suitable for writing to stderr.
 */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/**
 * The hardcoded Snapshot Exclusion List from the contracts. Patterns are
 * applied as **recursive path-segment matches** per SD-001:
 *
 * - File-name globs (`.env`, `.env.*`, `*.pem`, `*.key`, `credentials.json`)
 *   exclude any path whose **final** segment matches the pattern at any
 *   depth (so `src/config/.env` is excluded, not just top-level `.env`).
 * - The directory entry `.secrets/` excludes any path that contains a
 *   `.secrets` directory segment at any depth.
 *
 * Order is preserved to mirror the contracts table for diff-readability.
 * Feature 4 may expand it based on threat model evaluation; Hatchery
 * (M2) makes it configurable per profile.
 */
export const SNAPSHOT_EXCLUSION_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  ".secrets/",
  "credentials.json",
];

/**
 * Result of {@link createBuildContext}: an absolute path to a temp dir
 * populated with copies of the worktree's tracked files (minus the
 * exclusion list), plus a cleanup handle the caller MUST invoke when done.
 */
export interface BuildContextHandle {
  /** Absolute path to the temp build-context directory. */
  readonly contextPath: string;
  /**
   * Removes the temp directory and all its contents. Idempotent — safe to
   * call multiple times and will not throw if the directory is already
   * gone.
   */
  cleanup(): void;
}

/**
 * Compiles a basename glob (only `*` and `?` wildcards, no directory
 * separators) into an anchored RegExp that matches a single path segment.
 * Used for the Snapshot Exclusion List's file-name patterns.
 */
function compileBasenameGlob(pattern: string): RegExp {
  let body = "";
  for (const ch of pattern) {
    if (ch === "*") {
      body += "[^/]*";
    } else if (ch === "?") {
      body += "[^/]";
    } else {
      // Escape every regex meta-character so dots in `.env` are literal.
      body += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${body}$`);
}

/**
 * Pre-compiled exclusion matchers. Each entry is either a basename matcher
 * (applied to the path's final segment) or a directory-segment matcher
 * (applied to every interior segment).
 */
interface CompiledExclusions {
  basename: RegExp[];
  directorySegments: string[];
}

function compileExclusions(patterns: readonly string[]): CompiledExclusions {
  const basename: RegExp[] = [];
  const directorySegments: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/")) {
      // Directory pattern — strip trailing slash and match as a literal
      // path segment. The contracts only use a single literal directory
      // entry (`.secrets/`); supporting glob characters here would be
      // ambiguous given SD-001's "directory segment" framing, so we keep
      // the matcher strictly literal.
      directorySegments.push(pattern.slice(0, -1));
    } else {
      basename.push(compileBasenameGlob(pattern));
    }
  }
  return { basename, directorySegments };
}

const COMPILED_EXCLUSIONS = compileExclusions(SNAPSHOT_EXCLUSION_PATTERNS);

/**
 * Returns true if the given POSIX-style relative path (as emitted by
 * `git ls-files`) should be excluded from the build context per the
 * Snapshot Exclusion List.
 *
 * Exposed for unit-test scrutiny and for Story 4 follow-up modules that
 * need to mirror exclusion semantics outside the snapshot path.
 */
export function isExcludedPath(
  relPath: string,
  exclusions: CompiledExclusions = COMPILED_EXCLUSIONS,
): boolean {
  // `git ls-files` always emits POSIX `/` separators regardless of host.
  const segments = relPath.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return false;

  // Directory-segment exclusions: any interior or final segment matches.
  for (const dir of exclusions.directorySegments) {
    if (segments.includes(dir)) return true;
  }

  // Basename exclusions: only the final segment is examined. This is the
  // SD-001 "recursive path-segment match" rule — a basename glob excludes
  // a file at any depth so long as its filename matches.
  const basename = segments[segments.length - 1];
  for (const re of exclusions.basename) {
    if (re.test(basename)) return true;
  }
  return false;
}

/**
 * Lists tracked files in a worktree via `git ls-files`. Output uses POSIX
 * `/` separators per `git`'s contract. Throws {@link SnapshotError} if
 * the worktree path is not a git working tree (e.g., directory exists
 * but has no `.git` link).
 */
function listTrackedFiles(worktreePath: string): string[] {
  let stdout: string;
  try {
    stdout = execFileSync("git", ["ls-files", "-z"], {
      cwd: worktreePath,
      encoding: "utf-8",
      // Suppress git's noisy stderr when the cwd is not a repo; we
      // surface our own SnapshotError instead.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new SnapshotError(
      `Failed to list tracked files in "${worktreePath}": ${(err as Error).message}`,
    );
  }
  // `-z` separates entries with NUL so file names containing newlines or
  // unusual characters are unambiguous. Trailing NUL produces an empty
  // string we drop.
  return stdout.split("\0").filter((s) => s.length > 0);
}

/**
 * Copies a single tracked file from the worktree into the build context,
 * creating intermediate directories as needed. Uses `fs.copyFileSync` so
 * the destination is a real regular file (not a symlink), satisfying the
 * "self-contained context" requirement: `docker build` inspects the
 * context as a flat file tree and would not follow symlinks pointing
 * outside the temp directory.
 */
function copyTrackedFile(
  worktreePath: string,
  contextPath: string,
  relPosixPath: string,
): void {
  // `git ls-files` always emits POSIX paths; convert to host separators
  // for the destination side so e.g. Windows callers see correct paths.
  const relHost = relPosixPath.split("/").join(path.sep);
  const src = path.join(worktreePath, relHost);
  const dest = path.join(contextPath, relHost);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // COPYFILE_FICLONE allows reflink/CoW on supporting filesystems for a
  // free speedup but falls back to a normal copy elsewhere — the result
  // is still a real file, not a symlink.
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_FICLONE);
}

/**
 * Assembles a temporary Docker build context from a worktree's tracked
 * files, minus the hardcoded {@link SNAPSHOT_EXCLUSION_PATTERNS}.
 *
 * Steps (in order):
 *   1. Run `git ls-files -z` inside the worktree to get the authoritative
 *      list of tracked files. Untracked and `.gitignore`-ignored files
 *      are excluded by construction (FR-008).
 *   2. Filter the list against the Snapshot Exclusion List using
 *      recursive path-segment match semantics (SD-001).
 *   3. Materialize each surviving file into a fresh temp dir under the
 *      OS temp directory, preserving relative paths and copying as a
 *      real regular file (not a symlink).
 *
 * The returned cleanup handle removes the entire temp directory; it is
 * idempotent and never throws. Callers should invoke it from a `finally`
 * block so the temp directory does not leak on success or failure.
 *
 * @param worktreePath - Absolute path to the spawn's worktree directory.
 * @returns A handle with the context path and a cleanup function.
 * @throws {SnapshotError} If `git ls-files` fails or a copy fails. On
 *   failure the temp directory is cleaned up before the error is thrown
 *   so callers do not need to invoke the handle.
 */
export function createBuildContext(worktreePath: string): BuildContextHandle {
  const tracked = listTrackedFiles(worktreePath);
  const filtered = tracked.filter((rel) => !isExcludedPath(rel));

  // Unique-per-call temp directory under the OS temp dir. `mkdtempSync`
  // appends 6 random chars to the prefix, so two concurrent calls cannot
  // collide. The full path is safe to `rm -rf` on cleanup since we
  // exclusively created it.
  const contextPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "march-spawn-context-"),
  );

  try {
    for (const rel of filtered) {
      copyTrackedFile(worktreePath, contextPath, rel);
    }
  } catch (err) {
    // Best-effort cleanup so we don't leak the partially populated dir
    // when bubbling the error up to the caller.
    try {
      fs.rmSync(contextPath, { recursive: true, force: true });
    } catch {
      // ignore — surfacing the original copy error matters more
    }
    throw new SnapshotError(
      `Failed to populate build context at "${contextPath}": ${(err as Error).message}`,
    );
  }

  return {
    contextPath,
    cleanup: () => {
      // `force: true` makes the call a no-op when the directory is
      // already gone, so a double cleanup (or an external rm) does not
      // throw — satisfies the "idempotent cleanup" acceptance criterion.
      try {
        fs.rmSync(contextPath, { recursive: true, force: true });
      } catch {
        // best-effort — never throw from cleanup
      }
    },
  };
}
