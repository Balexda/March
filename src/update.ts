import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isValidManifest, type MarchManifest } from "./manifest.js";
import { CLI_VERSION } from "./version.js";

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

export interface UpdateResult {
  summary: string;
  warnings: string[];
  added: string[];
  removed: string[];
  skipped: boolean;
  downgrade: boolean;
}

/**
 * Validates that a version string matches the strict MAJOR.MINOR.PATCH
 * pattern (three dot-separated non-negative integers, no prerelease or
 * build metadata).
 */
function isValidSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

/**
 * Parses a validated MAJOR.MINOR.PATCH string into a three-element
 * integer tuple [major, minor, patch].
 */
function parseSemver(version: string): [number, number, number] {
  const parts = version.split(".").map(Number) as [number, number, number];
  return parts;
}

/**
 * Compares two semver tuples.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
function compareSemver(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Update an existing March installation to match the current CLI version.
 *
 * Reads the existing manifest at `~/.march/march-manifest.json`, validates
 * it, compares versions, and handles early-return cases (already up-to-date,
 * downgrade detected). File operations (deploy, remove, manifest rewrite)
 * are only performed when versions differ and it is not a downgrade (unless
 * `force` is true).
 *
 * @param homeDir - Override the home directory (defaults to `os.homedir()`).
 * @param force - When true, proceed with file operations even on downgrade.
 * @returns An {@link UpdateResult} describing what was done.
 * @throws {UpdateError} On missing installation, corrupted manifest, or invalid version format.
 */
export async function updateMarch(
  homeDir?: string,
  force?: boolean,
): Promise<UpdateResult> {
  const home = homeDir ?? os.homedir();
  const marchDir = path.join(home, ".march");
  const manifestPath = path.join(marchDir, "march-manifest.json");

  // Step A — Read and validate manifest
  let rawContents: string;
  try {
    rawContents = await fs.readFile(manifestPath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new UpdateError(
        "No March installation found. Run `march init` to set up March.",
      );
    }
    throw new UpdateError(
      `Cannot read manifest at ${manifestPath}: ${code ?? String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContents);
  } catch {
    throw new UpdateError(
      `Corrupted manifest at ${manifestPath}. ` +
        "The file contains invalid JSON. " +
        "Please remove it manually and re-run `march init`.",
    );
  }

  if (!isValidManifest(parsed)) {
    throw new UpdateError(
      `Corrupted manifest at ${manifestPath}. ` +
        "The file contains JSON but is not a valid March manifest. " +
        "Please remove it manually and re-run `march init`.",
    );
  }

  const manifest: MarchManifest = parsed;

  // Step B — Version comparison using inline semver
  const installedVersion = manifest.marchVersion;
  const cliVersion = CLI_VERSION;

  if (!isValidSemver(installedVersion)) {
    throw new UpdateError(
      `Invalid version "${installedVersion}" in manifest. ` +
        "Only MAJOR.MINOR.PATCH versions (e.g., 1.2.3) are supported for comparison. " +
        "Prerelease suffixes and build metadata are not allowed.",
    );
  }

  if (!isValidSemver(cliVersion)) {
    throw new UpdateError(
      `Invalid CLI version "${cliVersion}". ` +
        "Only MAJOR.MINOR.PATCH versions (e.g., 1.2.3) are supported for comparison. " +
        "Prerelease suffixes and build metadata are not allowed.",
    );
  }

  const installed = parseSemver(installedVersion);
  const cli = parseSemver(cliVersion);
  const cmp = compareSemver(installed, cli);

  // Same version — already up to date
  if (cmp === 0) {
    return {
      summary: `March is already up to date (v${cliVersion}).`,
      warnings: [],
      added: [],
      removed: [],
      skipped: true,
      downgrade: false,
    };
  }

  // Downgrade detected (installed is newer than CLI)
  if (cmp > 0) {
    const warnings = [
      `Downgrade detected: installed v${installedVersion} → CLI v${cliVersion}. ` +
        "Pass --yes to force the downgrade.",
    ];

    if (!force) {
      return {
        summary: `Downgrade detected: installed v${installedVersion} is newer than CLI v${cliVersion}.`,
        warnings,
        added: [],
        removed: [],
        skipped: false,
        downgrade: true,
      };
    }

    // If force is true, fall through to file operations (Task 2)
  }

  // Step C — File operations (Task 2 will implement this)
  // For now, return a placeholder result for the upgrade path
  return {
    summary: `March updated from v${installedVersion} to v${cliVersion}.`,
    warnings: [],
    added: [],
    removed: [],
    skipped: false,
    downgrade: cmp > 0,
  };
}
