import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class LegateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegateError";
  }
}

/**
 * Conductor names are joined into filesystem paths under `~/.march/legate/`
 * and `~/.agent-deck/conductor/`, and are passed to `agent-deck conductor
 * setup`. agent-deck enforces this exact regex (see
 * `internal/session/conductor.go: ValidateConductorName`); we mirror it here
 * to (a) reject path-traversal attempts (`..`, `/`) before we compose any
 * filesystem path and (b) fail fast with a march-side message rather than
 * shelling out and parsing agent-deck's stderr.
 */
const CONDUCTOR_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const CONDUCTOR_NAME_MAX_LEN = 64;

/**
 * Profile names also appear in filesystem paths (agent-deck's profile-keyed
 * config dirs) and as a CLI flag value. Apply the same alphanumeric+`._-`
 * shape so callers cannot inject path separators or shell metacharacters.
 */
const PROFILE_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PROFILE_NAME_MAX_LEN = 64;

function validateConductorName(name: string): void {
  if (!name) {
    throw new LegateError("Conductor name cannot be empty.");
  }
  if (name.length > CONDUCTOR_NAME_MAX_LEN) {
    throw new LegateError(
      `Conductor name too long (max ${CONDUCTOR_NAME_MAX_LEN} characters): ${name}`,
    );
  }
  if (!CONDUCTOR_NAME_REGEX.test(name)) {
    throw new LegateError(
      `Invalid conductor name "${name}": must start with an alphanumeric ` +
        "character and contain only alphanumerics, dots, underscores, or hyphens.",
    );
  }
}

function validateProfileName(name: string): void {
  if (!name) {
    throw new LegateError("Profile name cannot be empty.");
  }
  if (name.length > PROFILE_NAME_MAX_LEN) {
    throw new LegateError(
      `Profile name too long (max ${PROFILE_NAME_MAX_LEN} characters): ${name}`,
    );
  }
  if (!PROFILE_NAME_REGEX.test(name)) {
    throw new LegateError(
      `Invalid profile name "${name}": must start with an alphanumeric ` +
        "character and contain only alphanumerics, dots, underscores, or hyphens.",
    );
  }
}

const TEMPLATE_VARS = [
  "REPO_NAME",
  "REPO_PATH",
  "PROFILE",
  "CONDUCTOR_NAME",
  "WORKER_GROUP",
] as const;

type TemplateVar = (typeof TEMPLATE_VARS)[number];

export interface LegateInitOptions {
  /** Absolute path to the repository the conductor will manage. */
  repoPath: string;
  /** agent-deck profile (default: derived from repo basename). */
  profile?: string;
  /** Conductor name (default: `legate-<repo-slug>`). Must be unique system-wide per agent-deck. */
  conductorName?: string;
  /** Description shown by `agent-deck conductor list`. */
  description?: string;
  /** Group for worker sessions launched by the conductor (default: `legate-workers`). */
  workerGroup?: string;
  /** Override `os.homedir()` (tests / programmatic callers). */
  homeDir?: string;
  /** Explicit template path (tests). When unset, the module locates the bundled template. */
  templatePath?: string;
  /** When false, render the template but skip `agent-deck conductor setup`. Default: true. */
  runSetup?: boolean;
}

export interface LegateInitResult {
  profile: string;
  conductorName: string;
  workerGroup: string;
  repoName: string;
  repoPath: string;
  templateOutputPath: string;
  conductorDir: string;
  setupCommand: string[];
  setupRan: boolean;
  summary: string;
}

/**
 * Slugify a string for use as an agent-deck profile or conductor-name component.
 * Conductor names must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` and be ≤ 64 chars.
 *
 * Returns an empty string when the input has no slug-able characters; callers
 * are responsible for substituting a stable per-repo fallback so two such
 * repos do not collide on the same default name.
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56); // leave headroom for "legate-" prefix without hitting 64
}

/**
 * Stable 8-hex-char content hash used to disambiguate repos whose basename
 * has no slug-able characters (purely non-ASCII or punctuation). Hashing the
 * absolute repo path keeps the resulting profile/conductor name stable across
 * runs while still being unique per repo.
 */
function repoHashSuffix(repoPath: string): string {
  return createHash("sha256").update(repoPath).digest("hex").slice(0, 8);
}

export function deriveDefaults(repoPath: string): {
  profile: string;
  conductorName: string;
  workerGroup: string;
  repoName: string;
} {
  const repoName = path.basename(repoPath);
  const baseSlug = slugify(repoName);
  // When the basename has no slug-able characters, fall back to a hash of
  // the absolute repo path so two such repos do not both default to the
  // same `repo` / `legate-repo` names — that would silently collide in
  // agent-deck's system-wide conductor namespace.
  const slug = baseSlug || `repo-${repoHashSuffix(repoPath)}`;
  return {
    profile: slug,
    // Conductor names are unique system-wide in agent-deck — encode the repo
    // slug so multiple repos can each have their own legate without collision.
    conductorName: `legate-${slug}`,
    workerGroup: "legate-workers",
    repoName,
  };
}

export function renderTemplate(
  tpl: string,
  vars: Record<TemplateVar, string>,
): string {
  let out = tpl;
  for (const k of TEMPLATE_VARS) {
    out = out.replaceAll(`{${k}}`, vars[k]);
  }
  return out;
}

/**
 * Locate the bundled CLAUDE.md template. Tries paths relative to the calling
 * module so this works both when imported from source (`src/legate.ts` →
 * `src/templates/...`) and when bundled (`dist/cli.js` → `../src/templates/...`,
 * since `package.json#files` ships `src/templates` alongside `dist`).
 */
async function findTemplate(explicit?: string): Promise<string> {
  if (explicit) {
    try {
      await fs.access(explicit);
      return explicit;
    } catch {
      throw new LegateError(`Template not found: ${explicit}`);
    }
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // src/legate.ts at runtime (vitest)
    path.join(here, "templates", "legate", "CLAUDE.md"),
    // dist/cli.js bundled with src/templates shipped as a sibling
    path.join(here, "..", "src", "templates", "legate", "CLAUDE.md"),
    // dist/cli.js installed under node_modules with src/templates also shipped
    path.join(here, "..", "..", "src", "templates", "legate", "CLAUDE.md"),
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      // try next
    }
  }
  throw new LegateError(
    `Cannot locate legate CLAUDE.md template. Searched:\n  ${candidates.join("\n  ")}`,
  );
}

/**
 * Render the legate CLAUDE.md template for `repoPath` and (by default) run
 * `agent-deck conductor setup` so the conductor's own CLAUDE.md is symlinked
 * to the rendered file. Re-runnable: the rendered template stays at a stable
 * path under `~/.march/legate/<conductor-name>/CLAUDE.md` so subsequent runs
 * update the live conductor on session restart.
 */
export async function initLegate(
  opts: LegateInitOptions,
): Promise<LegateInitResult> {
  const home = opts.homeDir ?? os.homedir();
  const repoPath = opts.repoPath;
  const defaults = deriveDefaults(repoPath);
  const profile = opts.profile ?? defaults.profile;
  const conductorName = opts.conductorName ?? defaults.conductorName;
  const workerGroup = opts.workerGroup ?? defaults.workerGroup;
  const repoName = defaults.repoName;
  const description =
    opts.description ??
    `Legate orchestrator for ${repoName} (Smithy plan→PR→fix loop)`;

  // Validate before composing any filesystem path so caller-supplied values
  // like `../../.ssh` cannot escape the staging root, and so we surface a
  // march-side error instead of shelling out and parsing agent-deck's stderr.
  validateProfileName(profile);
  validateConductorName(conductorName);

  const templatePath = await findTemplate(opts.templatePath);
  let tpl: string;
  try {
    tpl = await fs.readFile(templatePath, "utf-8");
  } catch (err) {
    throw new LegateError(
      `Cannot read template at ${templatePath}: ${(err as Error).message}`,
    );
  }
  const rendered = renderTemplate(tpl, {
    REPO_NAME: repoName,
    REPO_PATH: repoPath,
    PROFILE: profile,
    CONDUCTOR_NAME: conductorName,
    WORKER_GROUP: workerGroup,
  });

  // Stage rendered template at a stable, march-owned path. agent-deck's
  // `-claude-md <path>` flag creates a symlink from the conductor's CLAUDE.md
  // to this file — so re-running `march legate init` updates the live
  // conductor's instructions on next session restart, without needing to
  // re-run conductor setup or break the symlink.
  const stagingDir = path.join(home, ".march", "legate", conductorName);
  try {
    await fs.mkdir(stagingDir, { recursive: true });
  } catch {
    throw new LegateError(`Cannot create staging directory: ${stagingDir}`);
  }
  const templateOutputPath = path.join(stagingDir, "CLAUDE.md");
  try {
    await fs.writeFile(templateOutputPath, rendered);
  } catch {
    throw new LegateError(
      `Cannot write rendered template: ${templateOutputPath}`,
    );
  }

  // Build the agent-deck command. agent-deck's flag parser accepts single-dash
  // long flags (Go `flag` package); we match that style for parity with the
  // documented examples.
  const setupCommand = [
    "agent-deck",
    "-p",
    profile,
    "conductor",
    "setup",
    conductorName,
    "-description",
    description,
    "-claude-md",
    templateOutputPath,
  ];

  let setupRan = false;
  if (opts.runSetup ?? true) {
    try {
      execFileSync(setupCommand[0], setupCommand.slice(1), {
        stdio: "inherit",
      });
      setupRan = true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new LegateError(
        `agent-deck conductor setup failed (exit code ${status ?? "?"}). ` +
          `Rendered template stayed at ${templateOutputPath}; you can re-run setup manually:\n  ${setupCommand.join(" ")}`,
      );
    }
  }

  const conductorDir = path.join(home, ".agent-deck", "conductor", conductorName);

  const summaryLines = [
    `Legate (${conductorName}) configured for ${repoName}.`,
    `  Profile:        ${profile}`,
    `  Conductor:      ${conductorName}`,
    `  Worker group:   ${workerGroup}`,
    `  Repo:           ${repoPath}`,
    `  Template:       ${templateOutputPath}`,
    `  Conductor dir:  ${conductorDir}`,
    "",
    "The conductor's CLAUDE.md is symlinked to the template above. Edit the",
    "template to evolve legate's behavior; changes take effect after:",
    `  agent-deck -p ${profile} session restart conductor-${conductorName}`,
    "",
    "Attach:",
    `  agent-deck -p ${profile} session attach conductor-${conductorName}`,
  ];
  if (!setupRan) {
    summaryLines.push(
      "",
      "Setup skipped (--no-setup). Run when ready:",
      `  ${setupCommand.join(" ")}`,
    );
  }

  return {
    profile,
    conductorName,
    workerGroup,
    repoName,
    repoPath,
    templateOutputPath,
    conductorDir,
    setupCommand,
    setupRan,
    summary: summaryLines.join("\n"),
  };
}
