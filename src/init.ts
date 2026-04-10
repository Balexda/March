import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createManifest, isValidManifest } from "./manifest.js";

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

/**
 * Initialize the March environment.
 *
 * Creates `~/.march/march-manifest.json` after verifying the environment
 * is safe to write to. Guards against existing installations and
 * unwritable directories.
 *
 * @param homeDir - Override the home directory (defaults to `os.homedir()`).
 *                  Useful in tests and for programmatic callers that need to
 *                  target a non-default home location.
 * @returns A summary of what was created.
 * @throws {InitError} On any pre-flight or write failure.
 */
export async function initMarch(homeDir?: string): Promise<string> {
  const home = homeDir ?? os.homedir();
  const marchDir = path.join(home, ".march");
  const claudeDir = path.join(home, ".claude");
  const manifestPath = path.join(marchDir, "march-manifest.json");

  // 1. Check for existing manifest
  let manifestExists = false;
  try {
    const contents = await fs.readFile(manifestPath, "utf-8");
    manifestExists = true;

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new InitError(
        `Corrupted manifest found at ${manifestPath}. ` +
          "The file exists but contains invalid JSON. " +
          "Please remove it manually and re-run `march init`.",
      );
    }

    if (isValidManifest(parsed)) {
      throw new InitError(
        "March is already installed. Run `march update` to upgrade.",
      );
    }

    throw new InitError(
      `Corrupted manifest found at ${manifestPath}. ` +
        "The file contains JSON but is not a valid March manifest. " +
        "Please remove it manually and re-run `march init`.",
    );
  } catch (err: unknown) {
    if (err instanceof InitError) throw err;
    // Only treat ENOENT (file not found) as a fresh install.
    // Any other error (EACCES, I/O failure) should be surfaced.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw new InitError(
        `Cannot read manifest at ${manifestPath}: ${code ?? String(err)}`,
      );
    }
  }

  // 2. Writability pre-checks: create directories and verify write access
  for (const dir of [marchDir, claudeDir]) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      throw new InitError(`Cannot create directory: ${dir}`);
    }

    try {
      await fs.access(dir, fs.constants.W_OK);
    } catch {
      throw new InitError(`Directory is not writable: ${dir}`);
    }
  }

  // 3. Write manifest
  const manifest = createManifest("0.1.0");
  try {
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  } catch {
    throw new InitError(`Cannot write manifest: ${manifestPath}`);
  }

  // 4. Return success summary
  const lines = [
    "March initialized successfully.",
    `  Created: ${marchDir}`,
    `  Created: ${claudeDir}`,
    `  Manifest: ${manifestPath}`,
  ];
  return lines.join("\n");
}
