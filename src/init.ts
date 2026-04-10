import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createManifest } from "./manifest.js";
import { ERROR } from "./exit-codes.js";

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
 */
export async function initMarch(homeDir?: string): Promise<void> {
  const home = homeDir ?? os.homedir();
  const marchDir = path.join(home, ".march");
  const claudeDir = path.join(home, ".claude");
  const manifestPath = path.join(marchDir, "march-manifest.json");

  // 1. Check for existing manifest
  let manifestExists = false;
  try {
    const contents = await fs.readFile(manifestPath, "utf-8");
    manifestExists = true;

    // Try to parse it as JSON
    try {
      JSON.parse(contents);
      // Valid JSON — already installed
      console.log(
        "March is already installed. Run `march update` to upgrade.",
      );
      process.exit(ERROR);
    } catch {
      // Invalid JSON — corrupted manifest
      console.error(
        `Corrupted manifest found at ${manifestPath}. ` +
          "The file exists but contains invalid JSON. " +
          "Please remove it manually and re-run `march init`.",
      );
      process.exit(ERROR);
    }
  } catch (err: unknown) {
    if (manifestExists) {
      // Re-throw if the file existed but we somehow got here
      // (shouldn't happen, but for safety)
      throw err;
    }
    // File does not exist — this is the expected path for a fresh install
  }

  // 2. Writability pre-checks: create directories and verify write access
  for (const dir of [marchDir, claudeDir]) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      console.error(`Cannot create directory: ${dir}`);
      process.exit(ERROR);
    }

    try {
      await fs.access(dir, fs.constants.W_OK);
    } catch {
      console.error(`Directory is not writable: ${dir}`);
      process.exit(ERROR);
    }
  }

  // 3. Write manifest
  const manifest = createManifest("0.1.0");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // 4. Print success message
  console.log("March initialized successfully.");
  console.log(`  Created: ${marchDir}`);
  console.log(`  Created: ${claudeDir}`);
  console.log(`  Manifest: ${manifestPath}`);
}
