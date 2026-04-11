import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isValidManifest, type MarchManifest } from "./manifest.js";
import { getM1Skills } from "./skills.js";
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

    // If force is true, fall through to file operations below.
  }

  // Step C — File operations
  const skills = getM1Skills();
  const newPaths = skills.map((s) => `${s.deployTarget}/${s.filename}`);
  const oldPaths: string[] = (manifest.files.claude ?? []) as string[];

  const newSet = new Set(newPaths);
  const oldSet = new Set(oldPaths);

  const added = newPaths.filter((p) => !oldSet.has(p));
  const removed = oldPaths.filter((p) => !newSet.has(p));

  // Deploy all current skill files (overwrite unchanged, add new)
  for (const skill of skills) {
    const targetDir = path.join(home, skill.deployTarget);
    try {
      await fs.mkdir(targetDir, { recursive: true });
    } catch {
      throw new UpdateError(`Cannot create directory: ${targetDir}`);
    }
    try {
      await fs.writeFile(path.join(targetDir, skill.filename), skill.content);
    } catch {
      throw new UpdateError(
        `Cannot write skill file: ${path.join(targetDir, skill.filename)}`,
      );
    }
  }

  // Remove stale files tracked in the old manifest but absent from the new set.
  // Silently tolerate ENOENT (already gone = desired state).
  // Untracked user files are never touched.
  for (const relPath of removed) {
    const fullPath = path.join(home, relPath);
    try {
      await fs.rm(fullPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw new UpdateError(
          `Cannot remove stale file ${fullPath}: ${code ?? String(err)}`,
        );
      }
    }
  }

  // Rewrite manifest last, after all filesystem operations succeed,
  // to prevent partial state where the manifest claims files that do not exist.
  const updatedManifest: MarchManifest = {
    ...manifest,
    marchVersion: cliVersion,
    files: { ...manifest.files, claude: newPaths },
  };
  try {
    await fs.writeFile(manifestPath, JSON.stringify(updatedManifest, null, 2));
  } catch {
    throw new UpdateError(`Cannot write manifest: ${manifestPath}`);
  }

  // Build human-readable summary
  const unchanged = newPaths.filter((p) => oldSet.has(p));
  const summaryLines: string[] = [
    `March updated successfully from v${installedVersion} to v${cliVersion}.`,
  ];
  if (added.length > 0) {
    summaryLines.push("  Added:");
    for (const p of added) summaryLines.push(`    ${p}`);
  }
  if (removed.length > 0) {
    summaryLines.push("  Removed:");
    for (const p of removed) summaryLines.push(`    ${p}`);
  }
  if (unchanged.length > 0) {
    summaryLines.push("  Unchanged:");
    for (const p of unchanged) summaryLines.push(`    ${p}`);
  }

  const warnings: string[] = [];
  if (cmp > 0) {
    warnings.push(`Downgrade applied: v${installedVersion} → v${cliVersion}.`);
  }

  return {
    summary: summaryLines.join("\n"),
    warnings,
    added,
    removed,
    skipped: false,
    downgrade: cmp > 0,
  };
}
