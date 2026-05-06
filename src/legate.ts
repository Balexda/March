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

/**
 * Single-quote a shell argument when it contains anything outside a safe
 * literal set, escaping embedded single quotes via the standard
 * `'\''` trick. Used to render copy-paste-safe versions of `setupCommand`
 * for human-facing summaries and error messages — `execFileSync` itself
 * doesn't need this because it passes argv directly without a shell.
 */
function shellQuote(arg: string): string {
  if (/^[a-zA-Z0-9_./@:%+=,-]+$/.test(arg)) return arg;
  return "'" + arg.replaceAll("'", `'\\''`) + "'";
}

function formatShellCommand(cmd: readonly string[]): string {
  return cmd.map(shellQuote).join(" ");
}

/**
 * Result of a pre-flight check for the agent-deck conductor bridge daemon's
 * Python runtime. The bridge is required for the conductor to receive
 * heartbeat messages and act on its own; without it, mini-legate is a
 * console-mode tool driven by manual `agent-deck session send`.
 */
export type BridgeRequirementCheck =
  | {
      readonly ok: true;
      readonly pythonVersion: string;
      readonly pythonPath?: string;
    }
  | {
      readonly ok: false;
      readonly reason: "missing" | "too-old" | "unparseable";
      readonly detected?: string;
      readonly pythonPath?: string;
      readonly message: string;
    };

const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 9;

/**
 * Check the python3 interpreter the conductor bridge will actually use
 * (the one resolved by the systemd unit's `ExecStart=python3 bridge.py`,
 * which inherits PATH from the systemd --user environment, which usually
 * mirrors the user's login PATH). The bridge.py shipped by agent-deck
 * uses PEP 585 generic-builtin syntax (`list[dict]`) and crashes on
 * import under Python < 3.9.
 *
 * Returns a structured result so callers can choose whether to hard-fail,
 * print a warning, or proceed under `--no-bridge-check`.
 */
export function checkBridgeRequirements(): BridgeRequirementCheck {
  let raw: string;
  let pythonPath: string | undefined;
  try {
    raw = execFileSync("python3", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    return {
      ok: false,
      reason: "missing",
      message:
        "python3 not found on PATH. The agent-deck conductor bridge daemon " +
        "is a Python script (~/.agent-deck/conductor/bridge.py); without " +
        "Python 3.9+ available, the conductor will receive no heartbeats. " +
        "Install Python 3.9 or newer (and ensure `python3` resolves to it), " +
        "or pass --no-bridge-check to deploy a manually-driven conductor.",
    };
  }
  try {
    pythonPath = execFileSync("which", ["python3"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Best-effort; the version output below is what gates the decision.
  }

  // `python3 --version` prints e.g. "Python 3.8.10" or "Python 3.10.6".
  const match = raw.match(/^Python\s+(\d+)\.(\d+)/);
  if (!match) {
    return {
      ok: false,
      reason: "unparseable",
      detected: raw,
      pythonPath,
      message:
        `Could not parse "${raw}" as a Python version. The conductor bridge requires ` +
        `Python ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}+; install it (and ensure ` +
        `\`python3\` resolves to it) or pass --no-bridge-check to deploy a manually-driven conductor.`,
    };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (
    major < MIN_PYTHON_MAJOR ||
    (major === MIN_PYTHON_MAJOR && minor < MIN_PYTHON_MINOR)
  ) {
    return {
      ok: false,
      reason: "too-old",
      detected: `${major}.${minor}`,
      pythonPath,
      message:
        `Python ${major}.${minor} detected${pythonPath ? ` at ${pythonPath}` : ""}; ` +
        `agent-deck's conductor bridge (\`~/.agent-deck/conductor/bridge.py\`) requires ` +
        `Python ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR} or newer (it uses PEP 585 ` +
        `generic-builtin syntax such as \`list[dict]\` that throws TypeError on import ` +
        `under 3.8 and earlier). Without a working bridge the conductor receives no ` +
        `heartbeat messages and will only act when nudged manually via ` +
        `\`agent-deck session send\`.\n\n` +
        `To proceed:\n` +
        `  1. Install Python 3.9 or newer and ensure \`python3\` resolves to it ` +
        `(Ubuntu: \`sudo apt install python3.10 && sudo update-alternatives --install ` +
        `/usr/bin/python3 python3 /usr/bin/python3.10 1\`; macOS: \`brew install python@3.12\` ` +
        `then update PATH; or use pyenv/asdf for a user-level install).\n` +
        `  2. Or re-run with --no-bridge-check to deploy a manually-driven conductor ` +
        `(you will be responsible for sending heartbeats yourself).`,
    };
  }
  return { ok: true, pythonVersion: `${major}.${minor}`, pythonPath };
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
  /**
   * Claude model alias or full ID for the conductor session itself. Workers
   * are launched with the Claude default — they do real implementation work
   * and benefit from a more capable model. The conductor's job is mostly
   * orchestration (read smithy status, dispatch via agent-deck, watch gh,
   * update state.json), so a lighter model is appropriate. Default: `sonnet`.
   * Override with full IDs (e.g. `claude-opus-4-7`) when needed.
   */
  model?: string;
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
  /**
   * Staged skill directory under march's control
   * (`~/.march/legate/<name>/skill`). The source-of-truth snapshot kept by
   * `march legate init`; the conductor reads from a copy of this in its own
   * `.claude/skills/legate/`, not from this path directly.
   */
  skillStagedDir: string;
  /** True when the skill was copied into the conductor's `.claude/skills/legate`. */
  skillDeployed: boolean;
  setupCommand: string[];
  /**
   * Commands run after `agent-deck conductor setup` succeeds to put the
   * conductor session into auto mode and ensure the agent-deck bridge
   * daemon is running so heartbeats reach the conductor. Empty when
   * `runSetup === false`.
   */
  postSetupCommands: string[][];
  setupRan: boolean;
  /** True when the post-setup auto-mode commands all succeeded. */
  autoModeConfigured: boolean;
  /**
   * True when the conductor bridge daemon is verified active after this
   * run. Without it, the conductor never receives heartbeat messages and
   * never acts on its own. Linux/WSL2 only; macOS path is best-effort.
   */
  bridgeActive: boolean;
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
 * Copy the legate skill (SKILL.md + scripts/) from the source template
 * directory into a staging directory under march's control, then return that
 * staged path. agent-deck's conductor setup symlinks the conductor's
 * `CLAUDE.md` to a march-owned path; we mirror the same convention for the
 * skill so editing scripts in the staged dir takes effect on next conductor
 * restart without re-running `march legate init`.
 */
async function stageSkill(
  sourceTemplateDir: string,
  stagedSkillDir: string,
): Promise<void> {
  const sourceSkillDir = path.join(sourceTemplateDir, "skill");
  try {
    await fs.access(sourceSkillDir);
  } catch {
    throw new LegateError(
      `Cannot locate legate skill source at ${sourceSkillDir}`,
    );
  }

  // Wipe + recreate so re-runs don't leave stale scripts that were renamed
  // or removed in a newer template.
  await fs.rm(stagedSkillDir, { recursive: true, force: true });
  await fs.mkdir(path.join(stagedSkillDir, "scripts"), { recursive: true });

  // Copy SKILL.md
  await fs.copyFile(
    path.join(sourceSkillDir, "SKILL.md"),
    path.join(stagedSkillDir, "SKILL.md"),
  );

  // Copy scripts and ensure they're executable. fs.copyFile preserves content
  // but resets mode to default; chmod +x explicitly so the conductor can
  // invoke them via `bash <path>` or directly.
  const scriptsSrc = path.join(sourceSkillDir, "scripts");
  const entries = await fs.readdir(scriptsSrc);
  for (const entry of entries) {
    const src = path.join(scriptsSrc, entry);
    const dst = path.join(stagedSkillDir, "scripts", entry);
    await fs.copyFile(src, dst);
    await fs.chmod(dst, 0o755);
  }
}

// Write a narrow `.claude/settings.json` in the conductor dir that
// pre-approves exactly what the legate loop needs and nothing else.
//
// The grant model follows the convention used by the user's existing skills
// (e.g. `Skill(smithy.*:*)` in their settings.json):
//
//   - `Skill(legate:*)` — authorizes the conductor to invoke the legate
//     skill. The skill's own SKILL.md frontmatter declares its `allowed-tools`
//     (Bash patterns matching `*/legate/scripts/<each>:*`), so granting the
//     skill cascades into per-script bash approval without us having to
//     enumerate paths in this settings file.
//   - `Read(./**)` / `Edit(./**)` / `Write(./**)` — cwd-scoped file access.
//     The conductor's cwd is its own dir, so this lets it update state.json,
//     task-log.md, LEARNINGS.md, and take any additional notes it judges
//     useful, without prompting on every write. Reads of files outside cwd
//     are NOT granted — auto-mode still gates those.
//
// Deliberately *not* in the allow list: `Bash(*)`, `Read(*)`, `Edit(*)`,
// `Write(*)`, or any other tool-wide wildcard. Those would be a permission
// bypass; this allow list is the operationalization of the operator's
// choice to use the legate skill.
// The legate skill's deployed scripts. Single source of truth shared by the
// skill copier (via fs.readdir on the source) and the settings.json writer
// (which generates per-script Bash allow patterns). If a script is added or
// removed in `src/templates/legate/skill/scripts/`, this list must follow.
const LEGATE_SKILL_SCRIPTS = [
  "sync-default-branch.sh",
  "list-workers.sh",
  "launch-worker.sh",
  "discover-pr.sh",
  "babysit-pr.sh",
  "smithy-status.sh",
  "send-to-worker.sh",
  "restart-worker.sh",
  "rerun-ci.sh",
  "request-rebase.sh",
] as const;

async function writeNarrowSettings(conductorDir: string): Promise<void> {
  const settingsDir = path.join(conductorDir, ".claude");
  await fs.mkdir(settingsDir, { recursive: true });
  // Per-script Bash patterns matching the relative-path form the conductor
  // produces when it invokes a skill script (e.g.
  // `.claude/skills/legate/scripts/list-workers.sh default legate-workers`).
  // The skill's own `allowed-tools` frontmatter declares the same patterns,
  // but in practice that grant doesn't always propagate to the auto-mode
  // classifier on the conductor's first bash call after `Skill(legate)` —
  // putting the patterns directly in settings.json is the belt-and-suspenders
  // path that closes the gap. Each pattern is scoped to one specific deployed
  // script (no `Bash(*)` or `Bash(bash *)` wildcards).
  const skillBashAllows = LEGATE_SKILL_SCRIPTS.map(
    (script) => `Bash(.claude/skills/legate/scripts/${script} *)`,
  );
  const settings = {
    permissions: {
      allow: [
        "Skill(legate:*)",
        "Read(./**)",
        "Edit(./**)",
        "Write(./**)",
        ...skillBashAllows,
      ],
    },
  };
  await fs.writeFile(
    path.join(settingsDir, "settings.json"),
    JSON.stringify(settings, null, 2) + "\n",
  );
}

/**
 * Copy the rendered CLAUDE.md from the staged path directly into the
 * conductor's home so Claude Code's auto-mode classifier doesn't trip on
 * cross-boundary symlink resolution. Replaces any prior symlink/file.
 *
 * The trade-off: editing the staged file no longer auto-propagates to the
 * conductor on session restart — operators iterate by editing the source
 * template (`src/templates/legate/CLAUDE.md`) and re-running `march legate
 * init`, which re-renders + re-copies. This is the explicit cost of B
 * (auto-mode safety preserved) versus the prior symlink approach.
 */
async function copyTemplateIntoConductor(
  stagedTemplatePath: string,
  conductorDir: string,
): Promise<void> {
  const target = path.join(conductorDir, "CLAUDE.md");
  // rm with force handles all prior states: symlink, file, or missing.
  await fs.rm(target, { force: true });
  await fs.copyFile(stagedTemplatePath, target);
}

/**
 * Recursively copy the staged skill directory directly into the conductor's
 * `.claude/skills/legate/`. Same rationale as copyTemplateIntoConductor:
 * keeps every read inside the conductor's cwd so auto-mode's classifier
 * doesn't pause on cross-boundary access. Replaces any prior
 * symlink/directory.
 */
async function copySkillIntoConductor(
  stagedSkillDir: string,
  conductorDir: string,
): Promise<void> {
  const skillsDir = path.join(conductorDir, ".claude", "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  const target = path.join(skillsDir, "legate");
  // Replace prior link/dir; rm with force handles symlinks, copied dirs,
  // and missing-target alike.
  await fs.rm(target, { recursive: true, force: true });
  // fs.cp recursively copies the staged dir tree. Node 16.7+; we target 22 in
  // tsconfig so this is safe.
  await fs.cp(stagedSkillDir, target, { recursive: true });
  // Ensure scripts are +x — fs.cp preserves source mode but be explicit so
  // we never produce a scripts/ dir whose entries can't be invoked.
  const scriptsDir = path.join(target, "scripts");
  for (const entry of await fs.readdir(scriptsDir)) {
    await fs.chmod(path.join(scriptsDir, entry), 0o755);
  }
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
  const model = opts.model ?? "sonnet";
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

  // Stage the legate skill (SKILL.md + scripts/) at a sibling path under the
  // same march-owned staging dir. The skill provides deterministic, classifier-
  // friendly bash helpers for the loop's mechanics; CLAUDE.md tells the
  // conductor *what* to do, the skill provides *how*. After conductor setup
  // creates the conductor dir, we symlink it into <conductor>/.claude/skills/
  // so Claude Code auto-discovers it on the next session start.
  const sourceTemplateDir = path.dirname(templatePath);
  const stagedSkillDir = path.join(stagingDir, "skill");
  try {
    await stageSkill(sourceTemplateDir, stagedSkillDir);
  } catch (err) {
    if (err instanceof LegateError) throw err;
    throw new LegateError(
      `Failed to stage legate skill at ${stagedSkillDir}: ${(err as Error).message}`,
    );
  }

  // Build the agent-deck command. agent-deck's flag parser accepts single-dash
  // long flags (Go `flag` package); we match that style for parity with the
  // documented examples.
  //
  // We deliberately do NOT pass `-claude-md` here. agent-deck's `-claude-md`
  // creates a symlink from `<conductor-dir>/CLAUDE.md` → the staged path,
  // which Claude Code's auto-mode classifier then flags as a cross-boundary
  // read on every session start (the symlink target lives outside cwd).
  // Instead, agent-deck writes its default conductor CLAUDE.md, then we
  // overwrite it with our rendered template via copyTemplateIntoConductor
  // below. The conductor reads a regular file inside its own cwd → no
  // cross-boundary prompt. Same approach for the skill (copy, not symlink).
  const setupCommand = [
    "agent-deck",
    "-p",
    profile,
    "conductor",
    "setup",
    conductorName,
    "-description",
    description,
  ];

  // Post-setup commands persist Claude Code's auto mode on the conductor's
  // ClaudeOptions. agent-deck's [claude].auto_mode key only exists at
  // global scope (userconfig.go: ClaudeSettings.AutoMode); group and
  // conductor TOML blocks only carry config_dir + env_file. To scope auto
  // mode to *this* conductor without affecting every Claude session on the
  // host, use agent-deck's `auto-mode` mutable field (mutators.go:211),
  // which flips ClaudeOptions.AutoMode → emits `--permission-mode auto`
  // on every start/restart. Restart so the flag takes effect immediately
  // rather than on next start.
  const conductorTitle = `conductor-${conductorName}`;
  const setAutoModeCommand = [
    "agent-deck",
    "-p",
    profile,
    "session",
    "set",
    conductorTitle,
    "auto-mode",
    "true",
  ];
  // Pin the conductor's claude model via persisted extra-args. agent-deck
  // appends Instance.ExtraArgs after the auto-mode flag, producing
  // `--permission-mode auto --model <model>` on every start/restart. The
  // conductor's role is orchestration-heavy / reasoning-light, so a smaller
  // model (default `sonnet`) is intentional; workers stay on the Claude
  // default for real implementation work.
  const setModelCommand = [
    "agent-deck",
    "-p",
    profile,
    "session",
    "set",
    conductorTitle,
    "extra-args",
    "--",
    "--model",
    model,
  ];
  const restartCommand = [
    "agent-deck",
    "-p",
    profile,
    "session",
    "restart",
    conductorTitle,
  ];
  // The conductor bridge daemon delivers heartbeats to the conductor's
  // tmux session. Without it running, the conductor never wakes up on its
  // own — heartbeats are the only timer it has. agent-deck installs and
  // tries to enable+start the systemd unit during `conductor setup`, but
  // a successful unit-write does not guarantee a healthy daemon (crashed
  // dependency, missing python version, etc.), so we explicitly start +
  // verify here. Linux/WSL2 only for now; macOS users should run the
  // platform-appropriate launchctl command from the printed warning.
  const isLinuxLike = process.platform === "linux";
  const startBridgeCommand = isLinuxLike
    ? ["systemctl", "--user", "start", "agent-deck-conductor-bridge"]
    : null;
  const bridgeIsActiveCommand = isLinuxLike
    ? [
        "systemctl",
        "--user",
        "is-active",
        "--quiet",
        "agent-deck-conductor-bridge",
      ]
    : null;
  const postSetupCommands: string[][] = [
    setAutoModeCommand,
    setModelCommand,
    restartCommand,
  ];
  if (startBridgeCommand) postSetupCommands.push(startBridgeCommand);

  // Conductor dir path is needed both for the symlink-skill step (after setup
  // creates it) and for the final summary. Compute once here.
  const conductorDir = path.join(home, ".agent-deck", "conductor", conductorName);

  let setupRan = false;
  let autoModeConfigured = false;
  let bridgeActive = false;
  let skillDeployed = false;
  const postSetupWarnings: string[] = [];
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
          `Rendered template stayed at ${templateOutputPath}; you can re-run setup manually:\n  ${formatShellCommand(setupCommand)}`,
      );
    }

    // Copy the rendered CLAUDE.md and the skill directory directly into the
    // conductor's home (replacing any prior symlink from older deploys). This
    // keeps every read the conductor does inside its own cwd, so auto-mode's
    // classifier doesn't pause on cross-boundary access — see the comment on
    // copyTemplateIntoConductor for the design trade-off.
    try {
      await copyTemplateIntoConductor(templateOutputPath, conductorDir);
    } catch (err) {
      postSetupWarnings.push(
        `Failed to copy CLAUDE.md into ${conductorDir}/CLAUDE.md: ` +
          `${(err as Error).message}\n` +
          `The conductor's CLAUDE.md is whatever agent-deck's default writer left there.`,
      );
    }
    try {
      await copySkillIntoConductor(stagedSkillDir, conductorDir);
      skillDeployed = true;
    } catch (err) {
      postSetupWarnings.push(
        `Failed to copy legate skill into ${conductorDir}/.claude/skills/legate: ` +
          `${(err as Error).message}\n` +
          `The conductor will still work but won't have the skill's helper scripts.`,
      );
    }
    try {
      await writeNarrowSettings(conductorDir);
    } catch (err) {
      postSetupWarnings.push(
        `Failed to write narrow .claude/settings.json into ${conductorDir}: ` +
          `${(err as Error).message}\n` +
          `Without it, every skill-script invocation will pause for operator approval.`,
      );
    }

    // Run post-setup steps best-effort. The conductor exists at this point;
    // a failure here means the operator can fix manually with the printed
    // command rather than the whole init being lost.
    let autoModeSet = false;
    try {
      execFileSync(setAutoModeCommand[0], setAutoModeCommand.slice(1), {
        stdio: "inherit",
      });
      autoModeSet = true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      postSetupWarnings.push(
        `Failed to enable auto-mode on ${conductorTitle} (exit ${status ?? "?"}). ` +
          `Run manually:\n  ${formatShellCommand(setAutoModeCommand)}`,
      );
    }
    let modelSet = false;
    if (autoModeSet) {
      try {
        execFileSync(setModelCommand[0], setModelCommand.slice(1), {
          stdio: "inherit",
        });
        modelSet = true;
      } catch (err) {
        const status = (err as { status?: number }).status;
        postSetupWarnings.push(
          `Failed to set --model ${model} on ${conductorTitle} (exit ${status ?? "?"}). ` +
            `Run manually:\n  ${formatShellCommand(setModelCommand)}`,
        );
      }
    }
    if (autoModeSet && modelSet) {
      try {
        execFileSync(restartCommand[0], restartCommand.slice(1), {
          stdio: "inherit",
        });
        autoModeConfigured = true;
      } catch (err) {
        const status = (err as { status?: number }).status;
        postSetupWarnings.push(
          `Failed to restart ${conductorTitle} after setting auto mode + model (exit ${status ?? "?"}). ` +
            `Run manually:\n  ${formatShellCommand(restartCommand)}`,
        );
      }
    }

    // Ensure the bridge daemon is running. agent-deck's `conductor setup`
    // already attempted `enable --now`; a successful systemctl start now
    // is a no-op. We follow up with `is-active --quiet` after a brief
    // grace period so we catch crash-loops (a common failure mode is
    // bridge.py requiring Python 3.9+ on a host with 3.8 available — the
    // daemon imports, dies, systemd retries until it gives up).
    if (startBridgeCommand && bridgeIsActiveCommand) {
      try {
        execFileSync(startBridgeCommand[0], startBridgeCommand.slice(1), {
          stdio: "ignore",
        });
      } catch {
        // Non-fatal: continue to is-active check, which gives a clearer
        // message than "exit 5 from systemctl start".
      }
      // Brief settle so a crash-loop has time to fail at least once before
      // we sample is-active. 1s is enough for python import errors; we are
      // not waiting for steady state, just for the first failure to show up.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        execFileSync(
          bridgeIsActiveCommand[0],
          bridgeIsActiveCommand.slice(1),
          { stdio: "ignore" },
        );
        bridgeActive = true;
      } catch {
        bridgeActive = false;
        const bridgeLogPath = path.join(
          home,
          ".agent-deck",
          "conductor",
          "bridge.log",
        );
        postSetupWarnings.push(
          `Bridge daemon did not stay active after start. The conductor will not ` +
            `receive automatic heartbeats and will only act when nudged manually ` +
            `via \`agent-deck -p ${profile} session send ${conductorTitle} "<message>"\`. ` +
            `Common cause: bridge.py requires Python 3.9+ (PEP 585 generics). ` +
            `Inspect the failure:\n  systemctl --user status agent-deck-conductor-bridge\n  tail -n 50 ${bridgeLogPath}`,
        );
      }
    } else if (process.platform !== "linux") {
      postSetupWarnings.push(
        `Bridge daemon auto-start is currently Linux/WSL2 only (this host: ${process.platform}). ` +
          `Start it manually with the platform-appropriate command — see ` +
          `agent-deck's \`conductor status ${conductorName}\` output for the hint. ` +
          `Without the bridge running, the conductor will not receive heartbeats.`,
      );
    }
  }

  // Header is shared. The trailing how-to-edit / how-to-attach guidance
  // differs between the two flows because, in the --no-setup case, the
  // conductor does not yet exist and there is no symlink to update.
  const baseLines = [
    `Legate (${conductorName}) ${setupRan ? "configured" : "rendered"} for ${repoName}.`,
    `  Profile:        ${profile}`,
    `  Conductor:      ${conductorName}`,
    `  Worker group:   ${workerGroup}`,
    `  Repo:           ${repoPath}`,
    `  Template:       ${templateOutputPath}`,
    `  Conductor dir:  ${conductorDir}`,
    `  Auto mode:      ${
      setupRan
        ? autoModeConfigured
          ? "enabled (auto-mode field set on conductor session)"
          : "NOT configured — see warnings"
        : "deferred (run setup first)"
    }`,
    `  Model:          ${model}${
      setupRan ? "" : " (deferred — run setup first)"
    }`,
    `  Bridge daemon:  ${
      setupRan
        ? bridgeActive
          ? "active (heartbeats will reach the conductor)"
          : "NOT active — conductor will only respond to manual session-send messages; see warnings"
        : "deferred (run setup first)"
    }`,
    `  Skill:          ${
      setupRan
        ? skillDeployed
          ? `legate (deployed to .claude/skills/legate; staged source at ${stagedSkillDir})`
          : "NOT deployed — see warnings"
        : `legate staged at ${stagedSkillDir} (copied into conductor on setup)`
    }`,
    "",
  ];
  const tailLines = setupRan
    ? [
        "CLAUDE.md and the legate skill were copied into the conductor's home",
        "(no symlinks — keeps every read inside cwd so auto-mode doesn't pause).",
        "To iterate on the prompt or skill scripts: edit the source under",
        "`src/templates/legate/` in the march repo, then re-run:",
        `  march legate init --profile ${profile}`,
        "That re-renders, re-copies, and restarts the conductor.",
        "",
        "Attach:",
        `  agent-deck -p ${profile} session attach ${conductorTitle}`,
      ]
    : [
        "Setup skipped (--no-setup). The template + skill are staged at",
        `  ${stagingDir}`,
        "but no conductor has been created and nothing has been copied into",
        "a conductor dir yet. Run when ready:",
        `  ${formatShellCommand(setupCommand)}`,
        "",
        "Then enable auto mode, pin model, and restart:",
        `  ${formatShellCommand(setAutoModeCommand)}`,
        `  ${formatShellCommand(setModelCommand)}`,
        `  ${formatShellCommand(restartCommand)}`,
        "",
        "Re-running `march legate init` will perform setup AND copy the",
        "rendered template + skill into the conductor's home, then attach:",
        `  agent-deck -p ${profile} session attach ${conductorTitle}`,
      ];
  const warningLines =
    postSetupWarnings.length > 0
      ? ["", "Warnings:", ...postSetupWarnings.map((w) => `  ${w}`)]
      : [];
  const summaryLines = [...baseLines, ...tailLines, ...warningLines];

  return {
    profile,
    conductorName,
    workerGroup,
    repoName,
    repoPath,
    templateOutputPath,
    conductorDir,
    skillStagedDir: stagedSkillDir,
    skillDeployed,
    setupCommand,
    postSetupCommands,
    setupRan,
    autoModeConfigured,
    bridgeActive,
    summary: summaryLines.join("\n"),
  };
}
