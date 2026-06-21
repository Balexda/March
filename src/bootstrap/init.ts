import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createManifest, isValidManifest } from "./manifest.js";
import { getM1Skills } from "./skills.js";
import { CLI_VERSION } from "../shared/version.js";
import { FINDER_BIN, INIT_DEPENDENCIES, isFinderAvailable, isOnPath } from "../shared/deps.js";

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

export interface InitResult {
  summary: string;
  warnings: string[];
}

/**
 * Whether the March CLI installation is already bootstrapped on this host — i.e.
 * a *valid* manifest exists at `~/.march/march-manifest.json`. Used by `march
 * init` to decide whether to run the one-time global bootstrap before onboarding
 * a profile (the bootstrap is first-run-gated because {@link initMarch} refuses
 * to run over an existing install).
 *
 * Returns `false` for a missing manifest **and** for a present-but-corrupt one,
 * so the caller proceeds to {@link initMarch}, which surfaces the precise
 * corrupt-manifest error. Any other read failure (e.g. EACCES) is likewise
 * treated as "not installed" so {@link initMarch} reports it consistently.
 *
 * @param homeDir - Override the home directory (defaults to `os.homedir()`).
 */
export async function isMarchInstalled(homeDir?: string): Promise<boolean> {
  const home = homeDir ?? os.homedir();
  const manifestPath = path.join(home, ".march", "march-manifest.json");
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    return isValidManifest(parsed);
  } catch {
    return false;
  }
}

/**
 * Initialize the March environment.
 *
 * Creates `~/.march/march-manifest.json` and deploys the M1 placeholder
 * skill files to `~/.claude/commands/` and `~/.claude/prompts/` after
 * verifying the environment is safe to write to. Guards against existing
 * installations and unwritable directories. The manifest is written last
 * to prevent partial state where the manifest claims files exist that
 * were not yet deployed. After deployment, checks for `git` and `docker`
 * on PATH; any missing dependencies produce warnings collected in the
 * returned `InitResult.warnings` array without blocking completion.
 *
 * @param homeDir - Override the home directory (defaults to `os.homedir()`).
 *                  Useful in tests and for programmatic callers that need to
 *                  target a non-default home location.
 * @returns An {@link InitResult} with a success summary and any dependency warnings.
 * @throws {InitError} On any pre-flight or write failure.
 */
export async function initMarch(homeDir?: string): Promise<InitResult> {
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

  // 3. Deploy skill files
  const skills = getM1Skills();
  const deployedPaths: string[] = [];

  for (const skill of skills) {
    const targetDir = path.join(home, skill.deployTarget);
    try {
      await fs.mkdir(targetDir, { recursive: true });
    } catch {
      throw new InitError(`Cannot create directory: ${targetDir}`);
    }
    try {
      await fs.writeFile(path.join(targetDir, skill.filename), skill.content);
    } catch {
      throw new InitError(
        `Cannot write skill file: ${path.join(targetDir, skill.filename)}`,
      );
    }
    deployedPaths.push(skill.deployTarget + "/" + skill.filename);
  }

  // 4. Write manifest last with files.claude populated
  const manifest = createManifest(CLI_VERSION);
  manifest.files.claude = deployedPaths;
  try {
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  } catch {
    throw new InitError(`Cannot write manifest: ${manifestPath}`);
  }

  // 5. Check dependencies and collect warnings
  const warnings: string[] = [];
  if (!isFinderAvailable()) {
    warnings.push(
      `\`${FINDER_BIN}\` not found \u2014 cannot verify git or Docker are installed.`,
    );
  } else {
    for (const dep of INIT_DEPENDENCIES) {
      if (!isOnPath(dep.name)) {
        warnings.push(dep.warning);
      }
    }
  }

  // 6. Return success summary and any warnings
  const lines = [
    "March initialized successfully.",
    `  Created: ${marchDir}`,
    `  Created: ${claudeDir}`,
    `  Manifest: ${manifestPath}`,
    "  Deployed skills:",
    ...deployedPaths.map((p) => `    ${p}`),
  ];
  return { summary: lines.join("\n"), warnings };
}
