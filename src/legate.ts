import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Dotprompt } from "dotprompt";

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
  } catch {
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
export type TemplateVars = Record<TemplateVar, string>;

/**
 * Names of the legate skills this template ships. Each must correspond to a
 * `src/templates/legate/skills/<name>/` directory containing `SKILL.prompt`
 * and a `scripts/` subdir. Listed here (rather than discovered dynamically)
 * so the settings.json grant builder can produce a per-skill `Skill(<name>:*)`
 * line and a per-script `Bash(...)` allow line — both of which are the
 * audited surface area the operator approves once at deploy time.
 *
 * Add a new skill by:
 *   1. Creating `src/templates/legate/skills/<name>/{SKILL.prompt,scripts/*.sh}`
 *   2. Adding the name here.
 *   3. Updating `CLAUDE.prompt`'s heartbeat protocol to load and use it.
 */
export const LEGATE_SKILLS = [
  "legate.babysit",
  "legate.cleanup",
  "legate.dispatch",
] as const;
export type LegateSkillName = (typeof LEGATE_SKILLS)[number];

/**
 * Read-only `agent-deck` patterns the conductor sometimes needs outside the
 * skill scripts. The dispatch skill ships `inspect-worker.sh` as the
 * audited path for `session show`, but in practice the conductor also
 * legitimately reaches for `session output` (to read what a worker last
 * said before deciding whether to dispatch to it) and the various `list`
 * / `status` commands during reconciliation. Belt-and-suspenders: with
 * these patterns allowed, a one-off direct read invocation doesn't stall
 * the heartbeat loop on a permission prompt — a failure mode that
 * historically locked the live conductor for hours.
 *
 * Deliberately *only* read operations. Any `agent-deck session send`,
 * `launch`, `restart`, `set`, or other mutation still goes through a skill
 * script — those are mutations that need to stay audited.
 *
 * Patterns are anchored on the agent-deck command tree (see
 * `agent-deck --help`); add new entries here when a read primitive shows
 * up that matches none of these. Avoid `Bash(agent-deck *)` — that would
 * be a permission bypass dressed as a fix.
 */
const AGENT_DECK_READ_ALLOWS = [
  "Bash(agent-deck * session show *)",
  "Bash(agent-deck * session show --json *)",
  "Bash(agent-deck * session output *)",
  "Bash(agent-deck * list *)",
  "Bash(agent-deck * list --json *)",
  "Bash(agent-deck * status *)",
  "Bash(agent-deck * status --json *)",
  "Bash(agent-deck * conductor list *)",
  "Bash(agent-deck * conductor status *)",
] as const;

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
  /**
   * Explicit template *directory* (tests). When unset, the module locates
   * the bundled template dir. Must point at a dir containing `CLAUDE.prompt`,
   * `snippets/`, and `skills/<name>/` subdirs.
   */
  templateDir?: string;
  /** When false, render the template but skip `agent-deck conductor setup`. Default: true. */
  runSetup?: boolean;
}

export interface LegateSkillDeployment {
  name: LegateSkillName;
  /** Per-skill staged directory under `~/.march/legate/<conductor>/skills/<name>/`. */
  stagedDir: string;
  /** True when the skill was copied into the conductor's `.claude/skills/<name>/`. */
  deployed: boolean;
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
   * Parent dir of every staged skill: `~/.march/legate/<conductor>/skills/`.
   * Per-skill subdirs hang off this; see `skills` for the per-skill detail.
   */
  skillsStagedDir: string;
  /** Per-skill deployment detail. One entry per name in `LEGATE_SKILLS`. */
  skills: LegateSkillDeployment[];
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

/**
 * Load every `<name>.md` under `snippetsDir` into a `name → content` map for
 * Dotprompt's partials option. Snippet filenames become the partial name:
 * `state-json-schema.md` → `{{>state-json-schema}}`. Returns an empty map
 * when the dir is missing — which is fine for callers using prompts that
 * don't reference any partials.
 */
async function loadSnippets(snippetsDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let entries: string[];
  try {
    entries = await fs.readdir(snippetsDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    if (entry === "README.md") continue; // README is dev docs, never a partial.
    const name = entry.replace(/\.md$/, "");
    out[name] = await fs.readFile(path.join(snippetsDir, entry), "utf-8");
  }
  return out;
}

/**
 * Render a single `.prompt` file via Dotprompt: resolve `{{>partial}}`
 * inclusions and `{{variable}}` substitutions in one pass, then re-attach
 * any frontmatter (which Dotprompt strips during parsing because it tries
 * to validate against its own schema, and our skill frontmatter uses
 * `allowed-tools` which isn't part of that schema).
 *
 * Exported so the test suite can exercise the render contract directly.
 */
export async function renderPrompt(
  promptContent: string,
  partials: Record<string, string>,
  vars: TemplateVars,
): Promise<string> {
  const renderer = new Dotprompt({ partials });
  const frontmatterMatch = promptContent.match(/^(---\s*\n[\s\S]*?\n---\s*\n)/);
  const frontmatter = frontmatterMatch?.[1] ?? "";
  const body = frontmatter ? promptContent.slice(frontmatter.length) : promptContent;
  const result = await renderer.render(body, { input: vars as Record<string, unknown> });
  const rendered = result.messages
    .map((m) => m.content.map((p) => ("text" in p ? p.text : "")).join(""))
    .join("\n");
  return frontmatter + rendered;
}

/**
 * Render an arbitrary template string. Kept for tests and programmatic
 * callers; production code uses `renderPrompt` directly with a snippets
 * map. Variables follow Handlebars `{{NAME}}` syntax.
 */
export async function renderTemplate(
  tpl: string,
  vars: TemplateVars,
  partials: Record<string, string> = {},
): Promise<string> {
  return renderPrompt(tpl, partials, vars);
}

/**
 * Locate the bundled template *directory*. Tries paths relative to the
 * calling module so this works both when imported from source
 * (`src/legate.ts` → `src/templates/...`) and when bundled (`dist/cli.js` →
 * `../src/templates/...`, since `package.json#files` ships `src/templates`
 * alongside `dist`).
 */
async function findTemplateDir(explicit?: string): Promise<string> {
  if (explicit) {
    try {
      await fs.access(path.join(explicit, "CLAUDE.prompt"));
      return explicit;
    } catch {
      throw new LegateError(`Template dir not found or missing CLAUDE.prompt: ${explicit}`);
    }
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "templates", "legate"),
    path.join(here, "..", "src", "templates", "legate"),
    path.join(here, "..", "..", "src", "templates", "legate"),
  ];
  for (const c of candidates) {
    try {
      await fs.access(path.join(c, "CLAUDE.prompt"));
      return c;
    } catch {
      // try next
    }
  }
  throw new LegateError(
    `Cannot locate legate template dir. Searched:\n  ${candidates.join("\n  ")}`,
  );
}

/**
 * Render and stage one skill: read its `SKILL.prompt`, resolve partials +
 * variables through Dotprompt, write the resulting `SKILL.md` to the staged
 * skill dir, then copy every script under `scripts/` (preserving +x).
 * Wipes the staged skill dir first so re-runs don't carry forward removed
 * scripts from an earlier template version.
 */
async function stageSkill(
  sourceTemplateDir: string,
  skillName: LegateSkillName,
  partials: Record<string, string>,
  vars: TemplateVars,
  stagedSkillDir: string,
): Promise<void> {
  const sourceSkillDir = path.join(sourceTemplateDir, "skills", skillName);
  const sourcePrompt = path.join(sourceSkillDir, "SKILL.prompt");
  try {
    await fs.access(sourcePrompt);
  } catch {
    throw new LegateError(
      `Cannot locate skill source at ${sourcePrompt} — does the directory exist?`,
    );
  }

  // Wipe + recreate so re-runs don't leave stale scripts behind.
  await fs.rm(stagedSkillDir, { recursive: true, force: true });
  await fs.mkdir(path.join(stagedSkillDir, "scripts"), { recursive: true });

  // Render SKILL.prompt → SKILL.md (preserving frontmatter).
  const promptContent = await fs.readFile(sourcePrompt, "utf-8");
  const rendered = await renderPrompt(promptContent, partials, vars);
  await fs.writeFile(path.join(stagedSkillDir, "SKILL.md"), rendered);

  // Copy scripts. fs.copyFile preserves content but resets mode to default;
  // chmod +x explicitly so the conductor can invoke them via `bash <path>`
  // or directly.
  const scriptsSrc = path.join(sourceSkillDir, "scripts");
  let entries: string[];
  try {
    entries = await fs.readdir(scriptsSrc);
  } catch {
    // A skill is allowed to ship no scripts (pure-prompt skill). Skip the copy
    // step gracefully rather than erroring.
    return;
  }
  for (const entry of entries) {
    const src = path.join(scriptsSrc, entry);
    const dst = path.join(stagedSkillDir, "scripts", entry);
    await fs.copyFile(src, dst);
    await fs.chmod(dst, 0o755);
  }
}

/**
 * Build the `.claude/settings.json` allow list. Per-skill grants follow the
 * convention used in the user's wider config (`Skill(smithy.*:*)`) — each
 * skill gets its own `Skill(<name>:*)` entry plus per-script `Bash(...)`
 * allows that mirror what the skill's own `allowed-tools` declares.
 *
 * The per-script allows are belt-and-suspenders: in practice the skill's
 * own frontmatter grant doesn't always propagate to the auto-mode classifier
 * on the first bash call after `Skill(<name>)`; putting the patterns
 * directly in settings.json closes the gap. Each pattern is scoped to one
 * specific deployed script (no `Bash(*)` or `Bash(bash *)` wildcards).
 *
 * The `AGENT_DECK_READ_ALLOWS` patterns are a separate belt-and-suspenders
 * layer for direct `agent-deck session show / list / status` reads — the
 * dispatch skill's `inspect-worker.sh` covers the common case, but allowing
 * the underlying read patterns means a future ad-hoc invocation doesn't
 * stall the loop.
 */
async function writeNarrowSettings(
  conductorDir: string,
  stagedSkillsDir: string,
): Promise<void> {
  const settingsDir = path.join(conductorDir, ".claude");
  await fs.mkdir(settingsDir, { recursive: true });

  // Per-skill grants: enumerate the staged skills and, for each, every
  // deployed script. Reads from the staged dir (under march's control), not
  // from the conductor's dir, so the settings file is built before the skill
  // is copied into place.
  const skillGrants: string[] = [];
  const scriptAllows: string[] = [];
  for (const skillName of LEGATE_SKILLS) {
    skillGrants.push(`Skill(${skillName}:*)`);
    const scriptsDir = path.join(stagedSkillsDir, skillName, "scripts");
    let entries: string[];
    try {
      entries = await fs.readdir(scriptsDir);
    } catch {
      // Pure-prompt skill (no scripts) is legal; no per-script grants needed.
      continue;
    }
    for (const entry of entries.sort()) {
      scriptAllows.push(
        `Bash(.claude/skills/${skillName}/scripts/${entry} *)`,
      );
    }
  }

  const settings = {
    permissions: {
      allow: [
        ...skillGrants,
        "Read(./**)",
        "Edit(./**)",
        "Write(./**)",
        ...scriptAllows,
        ...AGENT_DECK_READ_ALLOWS,
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
 * template (`src/templates/legate/CLAUDE.prompt`) and re-running `march
 * legate init`, which re-renders + re-copies. This is the explicit cost of
 * preserving auto-mode safety vs. the prior symlink approach.
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
 * Recursively copy each staged skill directly into the conductor's
 * `.claude/skills/<skill-name>/`. Same rationale as
 * copyTemplateIntoConductor: keeps every read inside the conductor's cwd so
 * auto-mode's classifier doesn't pause on cross-boundary access. Replaces
 * any prior symlink/directory at each per-skill target.
 *
 * Also nukes the legacy single-skill dir (`.claude/skills/legate/`) when
 * present — old deployments shipped one monolithic skill and Claude Code
 * loads every directory under `.claude/skills/`, so leaving the legacy dir
 * in place would shadow the new per-skill grants and re-introduce the
 * conflict-handling gap this refactor exists to close.
 */
async function copySkillsIntoConductor(
  stagedSkillsDir: string,
  conductorDir: string,
): Promise<{ name: LegateSkillName; deployed: boolean }[]> {
  const skillsDir = path.join(conductorDir, ".claude", "skills");
  await fs.mkdir(skillsDir, { recursive: true });

  // Remove the legacy monolithic skill dir if present. Older `march legate
  // init` runs deployed `<conductor>/.claude/skills/legate/`; Claude Code
  // would still autoload it, which would shadow the new split skills.
  await fs.rm(path.join(skillsDir, "legate"), { recursive: true, force: true });

  const results: { name: LegateSkillName; deployed: boolean }[] = [];
  for (const skillName of LEGATE_SKILLS) {
    const src = path.join(stagedSkillsDir, skillName);
    const dst = path.join(skillsDir, skillName);
    try {
      // Replace prior link/dir; rm with force handles symlinks, copied dirs,
      // and missing-target alike.
      await fs.rm(dst, { recursive: true, force: true });
      await fs.cp(src, dst, { recursive: true });
      // Ensure scripts are +x — fs.cp preserves source mode but be explicit
      // so we never produce a scripts/ dir whose entries can't be invoked.
      const scriptsDst = path.join(dst, "scripts");
      try {
        for (const entry of await fs.readdir(scriptsDst)) {
          await fs.chmod(path.join(scriptsDst, entry), 0o755);
        }
      } catch {
        // Pure-prompt skill (no scripts/ dir).
      }
      results.push({ name: skillName, deployed: true });
    } catch {
      results.push({ name: skillName, deployed: false });
    }
  }
  return results;
}

/**
 * Heartbeat script body. agent-deck's `conductor setup` writes its own
 * heartbeat.sh that sends a "Heartbeat:" prefixed message — but the legate
 * CLAUDE.md only treats messages starting with `[HEARTBEAT]` as heartbeat
 * triggers, so the agent-deck-managed script silently fails to drive the
 * loop. We overwrite it with this version, which mirrors the format
 * bridge.py's in-process heartbeat_loop produces:
 *   [HEARTBEAT] [<name>] Status: N waiting, N running, N idle, N error,
 *   N stopped. Waiting sessions: ... Check if any need auto-response or
 *   user attention.
 *
 * agent-deck's `MigrateConductorHeartbeatScripts` auto-migrator
 * (internal/session/conductor.go) detects "managed" scripts via two
 * substrings — both must be absent here so the migrator classifies our
 * script as user-authored and skips it. If you edit this template, do not
 * reintroduce either pattern (see legate.test.ts for the assertions).
 *
 * `{NAME}` is the conductor name, `{PROFILE}` the agent-deck profile,
 * `{WORKER_GROUP}` the group whose member sessions should appear in the
 * status counts. Substitution is straight string replacement; values are
 * already validated by validateConductorName / validateProfileName before
 * we reach here.
 */
const LEGATE_HEARTBEAT_SCRIPT_TEMPLATE = `#!/bin/bash
# march-managed heartbeat dispatcher for the {NAME} legate conductor.
# Replaces agent-deck's auto-generated heartbeat.sh; sends the [HEARTBEAT]
# format the legate CLAUDE.md actually treats as a trigger.

set -u

NAME="{NAME}"
GROUP="{WORKER_GROUP}"
PROFILE="{PROFILE}"
TARGET="conductor-\${NAME}"

if ! agent-deck conductor status --json 2>/dev/null | grep -q '"enabled".*true'; then
    exit 0
fi

# Don't fire while the conductor itself is busy.
STATE=$(agent-deck -p "$PROFILE" session show "$TARGET" --json 2>/dev/null \\
    | awk -F'"' '/"status"/{print $4; exit}')
case "$STATE" in
    idle|waiting) ;;
    *) exit 0 ;;
esac

# Pull worker session list. Passed to python via env var so the heredoc
# carrying the python script does not shadow the pipe.
SESSIONS_JSON=$(agent-deck -p "$PROFILE" list --json 2>/dev/null)
if [ -z "$SESSIONS_JSON" ]; then
    exit 0
fi

PAYLOAD=$(
    SESSIONS_JSON="$SESSIONS_JSON" \\
    HB_NAME="$NAME" \\
    HB_GROUP="$GROUP" \\
    python3 -c '
import json, os, sys

name = os.environ["HB_NAME"]
group = os.environ["HB_GROUP"]
try:
    data = json.loads(os.environ["SESSIONS_JSON"])
except Exception:
    sys.exit(0)
sessions = data.get("sessions", data) if isinstance(data, dict) else data
if not isinstance(sessions, list):
    sys.exit(0)

scoped = []
for s in sessions:
    title = s.get("title", "") or ""
    g = s.get("group", "") or ""
    if title.startswith("conductor-"):
        continue
    if g != group and not g.startswith(group + "/"):
        continue
    scoped.append(s)

buckets = {"waiting": [], "running": [], "idle": [], "error": [], "stopped": []}
for s in scoped:
    buckets.setdefault(s.get("status", ""), []).append(s)

def n(b):
    return len(buckets.get(b, []))

parts = [
    "[HEARTBEAT] [%s] Status: %d waiting, %d running, %d idle, %d error, %d stopped."
    % (name, n("waiting"), n("running"), n("idle"), n("error"), n("stopped"))
]

def details(bucket):
    return ", ".join(
        "%s (project: %s)" % (s.get("title", "untitled"), s.get("path", ""))
        for s in buckets.get(bucket, [])
    )

if buckets["waiting"]:
    parts.append("Waiting sessions: %s." % details("waiting"))
if buckets["error"]:
    parts.append("Error sessions: %s." % details("error"))
parts.append("Check if any need auto-response or user attention.")

print(" ".join(parts))
'
)

if [ -z "\${PAYLOAD:-}" ]; then
    exit 0
fi

agent-deck -p "$PROFILE" session send "$TARGET" "$PAYLOAD" --no-wait -q
`;

/**
 * Render the heartbeat script for `(conductorName, profile, workerGroup)`
 * and write it to `<conductorDir>/heartbeat.sh` with mode 0755.
 *
 * Caller is responsible for ensuring `agent-deck conductor setup` has
 * already run so the conductor dir exists; this overwrites whatever
 * heartbeat.sh agent-deck just wrote.
 */
export async function writeLegateHeartbeatScript(
  conductorDir: string,
  conductorName: string,
  profile: string,
  workerGroup: string,
): Promise<void> {
  const body = LEGATE_HEARTBEAT_SCRIPT_TEMPLATE
    .replaceAll("{NAME}", conductorName)
    .replaceAll("{PROFILE}", profile)
    .replaceAll("{WORKER_GROUP}", workerGroup);
  const target = path.join(conductorDir, "heartbeat.sh");
  await fs.writeFile(target, body, { mode: 0o755 });
  // writeFile honors mode only when creating; on overwrite, fix the mode.
  await fs.chmod(target, 0o755);
}

/**
 * Render the legate CLAUDE.prompt template for `repoPath` and (by default) run
 * `agent-deck conductor setup` so the conductor's own CLAUDE.md is copied
 * from the rendered file. Re-runnable: the rendered template stays at a
 * stable path under `~/.march/legate/<conductor-name>/CLAUDE.md` so
 * subsequent runs update the live conductor on session restart.
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

  const templateDir = await findTemplateDir(opts.templateDir);
  const claudePromptPath = path.join(templateDir, "CLAUDE.prompt");
  let claudePromptContent: string;
  try {
    claudePromptContent = await fs.readFile(claudePromptPath, "utf-8");
  } catch (err) {
    throw new LegateError(
      `Cannot read CLAUDE.prompt at ${claudePromptPath}: ${(err as Error).message}`,
    );
  }

  // Snippets are optional — load whatever's in the dir (empty map if missing).
  const partials = await loadSnippets(path.join(templateDir, "snippets"));
  const vars: TemplateVars = {
    REPO_NAME: repoName,
    REPO_PATH: repoPath,
    PROFILE: profile,
    CONDUCTOR_NAME: conductorName,
    WORKER_GROUP: workerGroup,
  };

  let rendered: string;
  try {
    rendered = await renderPrompt(claudePromptContent, partials, vars);
  } catch (err) {
    throw new LegateError(
      `Failed to render CLAUDE.prompt: ${(err as Error).message}`,
    );
  }

  // Stage rendered template at a stable, march-owned path. Re-running `march
  // legate init` overwrites this file in place and the active deploy step
  // copies it into the conductor on every run.
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

  // Stage every skill at sibling paths under the same march-owned staging dir.
  // CLAUDE.md tells the conductor *what* to do; the skills provide *how*.
  const skillsStagedDir = path.join(stagingDir, "skills");
  try {
    await fs.mkdir(skillsStagedDir, { recursive: true });
  } catch {
    throw new LegateError(
      `Cannot create skills staging directory: ${skillsStagedDir}`,
    );
  }
  // Wipe any legacy monolithic `<staging>/skill/` dir from prior versions
  // before re-staging — the new layout uses `<staging>/skills/<name>/`.
  await fs.rm(path.join(stagingDir, "skill"), { recursive: true, force: true });

  const stagedSkills: { name: LegateSkillName; stagedDir: string }[] = [];
  for (const skillName of LEGATE_SKILLS) {
    const stagedDir = path.join(skillsStagedDir, skillName);
    try {
      await stageSkill(templateDir, skillName, partials, vars, stagedDir);
    } catch (err) {
      if (err instanceof LegateError) throw err;
      throw new LegateError(
        `Failed to stage skill ${skillName} at ${stagedDir}: ${(err as Error).message}`,
      );
    }
    stagedSkills.push({ name: skillName, stagedDir });
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
  // cross-boundary prompt. Same approach for each skill (copy, not symlink).
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

  const conductorDir = path.join(home, ".agent-deck", "conductor", conductorName);

  let setupRan = false;
  let autoModeConfigured = false;
  let bridgeActive = false;
  let deploymentResults: { name: LegateSkillName; deployed: boolean }[] = [];
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

    // Copy the rendered CLAUDE.md and every skill directly into the conductor's
    // home (replacing any prior symlink/dir from older deploys). This keeps
    // every read the conductor does inside its own cwd, so auto-mode's
    // classifier doesn't pause on cross-boundary access.
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
      deploymentResults = await copySkillsIntoConductor(
        skillsStagedDir,
        conductorDir,
      );
    } catch (err) {
      postSetupWarnings.push(
        `Failed to copy legate skills into ${conductorDir}/.claude/skills/: ` +
          `${(err as Error).message}\n` +
          `The conductor will still work but won't have the skill scripts.`,
      );
      // Still record one entry per skill so the result shape is stable.
      deploymentResults = LEGATE_SKILLS.map((name) => ({ name, deployed: false }));
    }
    try {
      await writeNarrowSettings(conductorDir, skillsStagedDir);
    } catch (err) {
      postSetupWarnings.push(
        `Failed to write narrow .claude/settings.json into ${conductorDir}: ` +
          `${(err as Error).message}\n` +
          `Without it, every skill-script invocation will pause for operator approval.`,
      );
    }
    try {
      await writeLegateHeartbeatScript(
        conductorDir,
        conductorName,
        profile,
        workerGroup,
      );
    } catch (err) {
      postSetupWarnings.push(
        `Failed to overwrite heartbeat.sh in ${conductorDir}: ` +
          `${(err as Error).message}\n` +
          `Without this, the agent-deck-managed heartbeat sends a "Heartbeat:" message ` +
          `that the legate CLAUDE.md does not recognize as a trigger — the conductor ` +
          `will receive periodic messages but never run babysit/cleanup/dispatch.`,
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

    // Ensure the bridge daemon is running.
    if (startBridgeCommand && bridgeIsActiveCommand) {
      try {
        execFileSync(startBridgeCommand[0], startBridgeCommand.slice(1), {
          stdio: "ignore",
        });
      } catch {
        // Non-fatal: continue to is-active check.
      }
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
  } else {
    // No setup ran; record skills as staged-but-not-deployed so the result
    // shape is consistent.
    deploymentResults = LEGATE_SKILLS.map((name) => ({ name, deployed: false }));
  }

  const skills: LegateSkillDeployment[] = stagedSkills.map(({ name, stagedDir }) => ({
    name,
    stagedDir,
    deployed: deploymentResults.find((r) => r.name === name)?.deployed ?? false,
  }));
  const allSkillsDeployed = skills.every((s) => s.deployed);

  // Header is shared. The trailing how-to-edit / how-to-attach guidance
  // differs between the two flows because, in the --no-setup case, the
  // conductor does not yet exist and there is no symlink to update.
  const skillsLine = setupRan
    ? allSkillsDeployed
      ? `${LEGATE_SKILLS.join(", ")} (deployed to .claude/skills/; staged source under ${skillsStagedDir})`
      : `partial — see warnings (${skills.filter((s) => s.deployed).map((s) => s.name).join(", ") || "none"} deployed)`
    : `${LEGATE_SKILLS.join(", ")} staged at ${skillsStagedDir} (copied into conductor on setup)`;

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
    `  Skills:         ${skillsLine}`,
    "",
  ];
  const tailLines = setupRan
    ? [
        "CLAUDE.md and the legate skills were copied into the conductor's home",
        "(no symlinks — keeps every read inside cwd so auto-mode doesn't pause).",
        "To iterate on the prompt, snippets, or skill scripts: edit the source",
        "under `src/templates/legate/` in the march repo, then re-run:",
        `  march legate init --profile ${profile}`,
        "That re-renders, re-copies, and restarts the conductor.",
        "",
        "Attach:",
        `  agent-deck -p ${profile} session attach ${conductorTitle}`,
      ]
    : [
        "Setup skipped (--no-setup). The template + skills are staged at",
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
        "rendered template + skills into the conductor's home, then attach:",
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
    skillsStagedDir,
    skills,
    setupCommand,
    postSetupCommands,
    setupRan,
    autoModeConfigured,
    bridgeActive,
    summary: summaryLines.join("\n"),
  };
}
