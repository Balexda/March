import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Dotprompt } from "dotprompt";
import { FINDER_BIN, isFinderAvailable, isOnPath } from "../shared/deps.js";
import {
  ensureLegateContainer,
  type LegateContainerResult,
} from "../hatchery/legate-container.js";

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

/**
 * Default heartbeat cadence for legate conductors. agent-deck's own default
 * is 15 min (from `~/.agent-deck/config.toml`'s `[conductor].heartbeat_interval`),
 * which is too slow for the Smithy plan→PR→fix loop: a stalled worker can
 * sit idle for the full interval before the conductor notices. 5 min keeps
 * the loop responsive without blowing through tokens — workers that are
 * mid-edit don't see the heartbeat anyway (it only fires when the conductor
 * is idle/waiting), so the cost is bounded.
 *
 * Overridable per-call via `--heartbeat-interval`; written as a systemd
 * drop-in at `~/.config/systemd/user/agent-deck-conductor-heartbeat-<name>.timer.d/override.conf`.
 */
export const DEFAULT_HEARTBEAT_INTERVAL = "5min";

/**
 * Subset of systemd time-span shape accepted as a heartbeat interval. systemd
 * itself accepts more (composites like `1h 30min`, named-month / -year units),
 * but we narrow to a single positive integer + a common single-unit suffix
 * so we can validate march-side. Any value here reaches a systemd unit file
 * the operator will not see until the next daemon-reload, so a typo surfaces
 * as a timer that silently fails to start; failing fast keeps the error
 * recoverable.
 *
 * Suffix alternation MUST list longer forms first (`ms` before `m`, `min`
 * before `m`, `hr` before `h`) — JS regex alternation is leftmost-match, so
 * `m` would otherwise win against `min` / `ms` and the trailing characters
 * would force the anchored match to fail.
 *
 * Composite forms (`1h 30min`) are intentionally out of scope; pass the
 * equivalent single-unit value instead (`5400s`).
 */
const HEARTBEAT_INTERVAL_REGEX = /^[1-9][0-9]*(ms|us|ns|min|hr|s|m|h|d|w|y)$/;
const HEARTBEAT_INTERVAL_SUFFIXES =
  "ns, us, ms, s, m, min, h, hr, d, w, or y";

function validateHeartbeatInterval(value: string): void {
  if (!value) {
    throw new LegateError("Heartbeat interval cannot be empty.");
  }
  if (!HEARTBEAT_INTERVAL_REGEX.test(value)) {
    throw new LegateError(
      `Invalid heartbeat interval "${value}": must be a positive integer ` +
        `followed by a single systemd time-span suffix (${HEARTBEAT_INTERVAL_SUFFIXES}). ` +
        'Examples: "5min", "10min", "300s", "1h", "500ms", "1w". ' +
        "Composite forms like \"1h 30min\" are not supported — use the " +
        "equivalent single-unit value (e.g. \"5400s\").",
    );
  }
}

/**
 * Build the systemd drop-in override that pins the conductor's heartbeat
 * timer to `interval`. The empty `OnBootSec=` / `OnUnitActiveSec=` lines
 * before the new values are required: systemd accumulates `[Timer]` entries
 * across drop-ins unless you blank the parent unit's values first, so
 * without them we'd append a second cadence rather than replace the 15-min
 * default.
 */
function renderHeartbeatTimerOverride(
  conductorName: string,
  interval: string,
): string {
  return `# march-managed: ${conductorName} heartbeats fire every ${interval}.
# Reverse with:
#   rm -rf ~/.config/systemd/user/agent-deck-conductor-heartbeat-${conductorName}.timer.d
#   systemctl --user daemon-reload
#   systemctl --user restart agent-deck-conductor-heartbeat-${conductorName}.timer
# The empty assignments before the new values clear the parent unit's
# defaults (systemd accumulates [Timer] entries across drop-ins unless
# you blank them first).
[Timer]
OnBootSec=
OnUnitActiveSec=
OnBootSec=${interval}
OnUnitActiveSec=${interval}
`;
}

/**
 * Write `~/.config/systemd/user/agent-deck-conductor-heartbeat-<name>.timer.d/override.conf`
 * pinning the conductor's heartbeat cadence to `interval`. Caller is
 * responsible for running `systemctl --user daemon-reload` and restarting
 * the timer to pick up the change.
 *
 * Linux-only. macOS / other platforms have no equivalent unit, so the
 * caller should skip the write and surface a warning instead.
 *
 * Returns the absolute path of the written override file.
 */
export async function writeHeartbeatTimerOverride(
  homeDir: string,
  conductorName: string,
  interval: string,
): Promise<string> {
  validateConductorName(conductorName);
  validateHeartbeatInterval(interval);
  const dropInDir = path.join(
    homeDir,
    ".config",
    "systemd",
    "user",
    `agent-deck-conductor-heartbeat-${conductorName}.timer.d`,
  );
  await fs.mkdir(dropInDir, { recursive: true });
  const target = path.join(dropInDir, "override.conf");
  await fs.writeFile(target, renderHeartbeatTimerOverride(conductorName, interval));
  return target;
}

const TEMPLATE_VARS = [
  "REPO_NAME",
  "REPO_PATH",
  "PROFILE",
  "CONDUCTOR_NAME",
  "PROCESSOR_NAME",
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
  "legate.resume",
  "legate.error",
  "legate.babysit",
  "legate.merge",
  "legate.cleanup",
  "legate.dispatch",
  "legate.issue",
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
  /**
   * Cadence at which the conductor's systemd heartbeat timer fires. Written
   * as a drop-in override at
   * `~/.config/systemd/user/agent-deck-conductor-heartbeat-<name>.timer.d/override.conf`.
   * Must be a systemd time span (e.g. `5min`, `10min`, `300s`, `1h`).
   * Default: {@link DEFAULT_HEARTBEAT_INTERVAL} (`5min`).
   * Linux-only — on macOS the override is skipped with a warning, since
   * the systemd timer doesn't exist there.
   */
  heartbeatInterval?: string;
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
  /** Deploy the paired deterministic processor conductor. Default: true. */
  processor?: boolean;
  /**
   * Deploy only the deterministic processor conductor. The Claude-backed
   * Legate conductor is not created, started, restarted, or configured.
   */
  processorOnly?: boolean;
  /** Build and launch the Hatchery-managed Legate container after setup. */
  withContainer?: boolean;
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
  processorName?: string;
  workerGroup: string;
  repoName: string;
  repoPath: string;
  templateOutputPath: string;
  conductorDir: string;
  processorStagingDir?: string;
  processorConductorDir?: string;
  processorSetupCommand?: string[];
  processorPostSetupCommands?: string[][];
  processorSetupRan?: boolean;
  processorConfigured?: boolean;
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
  /**
   * Heartbeat cadence pinned for this conductor via the systemd drop-in
   * override. Equals `opts.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL`
   * regardless of whether the override was actually written (see
   * `heartbeatOverrideWritten`).
   */
  heartbeatInterval: string;
  /**
   * True when the systemd drop-in override at
   * `~/.config/systemd/user/agent-deck-conductor-heartbeat-<name>.timer.d/override.conf`
   * was written this run. False on macOS / non-Linux and when `runSetup`
   * is false (override write is gated on setup having run).
   */
  heartbeatOverrideWritten: boolean;
  /** Hatchery-managed Legate container launched by `--with-container`. */
  legateContainer?: LegateContainerResult;
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

function deriveProcessorName(conductorName: string): string {
  const prefix = "processor-";
  const raw = `${prefix}${conductorName}`;
  if (raw.length <= CONDUCTOR_NAME_MAX_LEN) return raw;

  const suffix = createHash("sha256").update(conductorName).digest("hex").slice(0, 8);
  const headLength = CONDUCTOR_NAME_MAX_LEN - prefix.length - suffix.length - 1;
  return `${prefix}${conductorName.slice(0, headLength)}-${suffix}`;
}

export function deriveDefaults(repoPath: string): {
  profile: string;
  conductorName: string;
  processorName: string;
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
  const conductorName = `legate-${slug}`;
  return {
    profile: slug,
    // Conductor names are unique system-wide in agent-deck — encode the repo
    // slug so multiple repos can each have their own legate without collision.
    conductorName,
    processorName: deriveProcessorName(conductorName),
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

function processorMetaFor(input: {
  profile: string;
  conductorName: string;
  processorName: string;
  repoName: string;
  repoPath: string;
  workerGroup: string;
  processorConductorDir: string;
  legateConductorDir: string;
}): Record<string, unknown> {
  return {
    schema_version: 1,
    profile: input.profile,
    paired_legate: input.conductorName,
    processor_name: input.processorName,
    repo: {
      name: input.repoName,
      path: input.repoPath,
    },
    worker_group: input.workerGroup,
    legate_state_path: path.join(input.legateConductorDir, "state.json"),
    processor_log_path: path.join(input.processorConductorDir, "processor.log"),
    processor_events_path: path.join(input.processorConductorDir, "processor.ndjson"),
    processor_requests_path: path.join(
      input.processorConductorDir,
      "processor-requests.ndjson",
    ),
    legate_conductor_dir: input.legateConductorDir,
    mode: "terminal-pr-maintenance",
  };
}

const PROCESSOR_LOOP_MJS = `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const metaPath = path.join(here, "processor-meta.json");
const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
const rawIntervalSeconds = Number(process.env.MARCH_PROCESSOR_INTERVAL_SECONDS || "60");
const intervalSeconds = Number.isFinite(rawIntervalSeconds) && rawIntervalSeconds > 0
  ? rawIntervalSeconds
  : 60;

function now() {
  return new Date().toISOString();
}

function append(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + "\\n", "utf-8");
}

function appendText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text + "\\n", "utf-8");
  console.log(text);
}

function printText(text) {
  console.log(text);
}

function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\\n", "utf-8");
}

function execText(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function formatCleanupLine(event, prefix = "") {
  return \`[\${event.ts}] \${prefix}cleaned up \${event.slice_id} PR #\${event.pr_number} \${event.pr_state}: removed session \${event.session_id}, pruned worktree\`;
}

function formatCleanupFailureLine(event, prefix = "") {
  return \`[\${event.ts}] \${prefix}cleanup failed \${event.slice_id || "unknown"}\${event.pr_state ? " PR " + event.pr_state : ""}: \${event.error}\`;
}

function formatBabysitActionLine(event, prefix = "") {
  return \`[\${event.ts}] \${prefix}babysit \${event.action} \${event.slice_id} PR #\${event.pr_number}: \${event.detail}\`;
}

function formatProcessorRequestLine(event, prefix = "") {
  return \`[\${event.ts}] \${prefix}requested legate judgement for \${event.slice_id || "unknown"}\${event.pr_number ? " PR #" + event.pr_number : ""}: \${event.reason}\`;
}

function replayRecentActionEvents(limit = 10) {
  let raw;
  try {
    raw = fs.readFileSync(meta.processor_events_path, "utf-8");
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  const events = raw
    .trim()
    .split("\\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event?.kind === "cleanup" || event?.kind === "cleanup_failure" || event?.kind === "babysit_action" || event?.kind === "processor_request")
    .slice(-limit);
  if (events.length === 0) return;
  printText(\`[\${now()}] replaying \${events.length} recent processor action event(s) to stdout\`);
  for (const event of events) {
    if (event.kind === "cleanup") {
      printText(formatCleanupLine(event, "recent action: "));
    } else if (event.kind === "cleanup_failure") {
      printText(formatCleanupFailureLine(event, "recent action: "));
    } else if (event.kind === "babysit_action") {
      printText(formatBabysitActionLine(event, "recent action: "));
    } else {
      printText(formatProcessorRequestLine(event, "recent action: "));
    }
  }
}

function agentDeckList() {
  try {
    const out = execFileSync("agent-deck", ["-p", meta.profile, "list", "-json"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : parsed.sessions || [];
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

function sessionGroup(session) {
  return session.group || session.group_path || "";
}

function isWorkerSession(session) {
  const group = sessionGroup(session);
  return group === meta.worker_group || group.startsWith(meta.worker_group + "/");
}

function sessionMatchesSlice(session, slice) {
  const sessionId = String(slice.worker_session_id || "");
  if (!sessionId) return false;
  return session.id === sessionId || session.title === sessionId || session.name === sessionId;
}

function summarizeWorkers(list) {
  if (!Array.isArray(list)) return { error: list.error || "unavailable" };
  const buckets = { waiting: 0, running: 0, idle: 0, error: 0, stopped: 0, other: 0 };
  for (const session of list) {
    if (!isWorkerSession(session)) continue;
    const status = session.status || "other";
    if (Object.prototype.hasOwnProperty.call(buckets, status)) buckets[status] += 1;
    else buckets.other += 1;
  }
  return buckets;
}

function workerBySessionId(list) {
  const out = new Map();
  if (!Array.isArray(list)) return out;
  for (const session of list) {
    if (!isWorkerSession(session)) continue;
    if (session.id) out.set(String(session.id), session);
    if (session.title) out.set(String(session.title), session);
    if (session.name) out.set(String(session.name), session);
  }
  return out;
}

function prNumber(slice) {
  const n = slice?.pr?.number;
  if (typeof n === "number" && Number.isInteger(n) && n > 0) return String(n);
  if (typeof n === "string" && /^[0-9]+$/.test(n)) return n;
  return null;
}

function repoOwner(state) {
  const owner = state?.repo?.owner_with_name;
  if (typeof owner === "string" && owner.length > 0) return owner;
  const repoPath = state?.repo?.path || meta.repo?.path;
  if (typeof repoPath !== "string" || repoPath.length === 0) return null;
  try {
    const out = execText("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
      cwd: repoPath,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function ghPrArgs(slice, state, fields) {
  const number = prNumber(slice);
  if (!number) return { skipped: true, reason: "missing_pr_number" };
  const args = ["pr", "view", number, "--json", fields];
  const owner = repoOwner(state);
  if (typeof owner === "string" && owner.length > 0) {
    args.push("-R", owner);
  }
  const options = {
  };
  const repoPath = state?.repo?.path || meta.repo?.path;
  if (!owner && typeof repoPath === "string" && repoPath.length > 0) {
    options.cwd = repoPath;
  }
  return { args, options, owner, number };
}

function queryPr(slice, state) {
  const request = ghPrArgs(slice, state, "number,url,state");
  if (request.skipped) return request;
  const out = execText("gh", request.args, request.options);
  return JSON.parse(out);
}

function checksSummary(statusCheckRollup) {
  const checks = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  if (checks.length === 0) return "NONE";
  if (checks.some((check) => ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes(check.conclusion))) {
    return "FAIL";
  }
  if (checks.some((check) => ["IN_PROGRESS", "QUEUED", "PENDING"].includes(check.status))) {
    return "PENDING";
  }
  return "PASS";
}

function failedChecks(statusCheckRollup) {
  const checks = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  return checks
    .filter((check) => ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes(check.conclusion))
    .map((check) => ({
      name: check.name || check.context || "unknown",
      url: check.detailsUrl || check.targetUrl || null,
    }));
}

function queryReviewThreads(owner, prNumberValue) {
  if (!owner) return [];
  const [repoOwnerName, repoName] = owner.split("/");
  if (!repoOwnerName || !repoName) return [];
  const out = execText("gh", [
    "api",
    "graphql",
    "-F",
    \`owner=\${repoOwnerName}\`,
    "-F",
    \`name=\${repoName}\`,
    "-F",
    \`pr=\${prNumberValue}\`,
    "-f",
    \`query=query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 50) {
            nodes {
              databaseId
              body
              path
              line
              author { login }
              createdAt
            }
          }
        }
      }
    }
  }
}\`,
  ]);
  const parsed = JSON.parse(out);
  const nodes = parsed?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
  return nodes
    .filter((thread) => thread && thread.isResolved === false)
    .map((thread) => {
      const comments = Array.isArray(thread.comments?.nodes)
        ? [...thread.comments.nodes].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        : [];
      const first = comments[0] || {};
      const last = comments[comments.length - 1] || first;
      return {
        id: first.databaseId,
        path: first.path,
        line: first.line,
        author: first.author?.login,
        body_preview: String(first.body || "").slice(0, 140),
        last_author: last.author?.login,
        last_comment_at: last.createdAt,
        comment_count: comments.length,
      };
    });
}

function queryPrForBabysit(slice, state) {
  const request = ghPrArgs(
    slice,
    state,
    "number,url,state,mergeable,reviewDecision,statusCheckRollup,headRefName,title,author",
  );
  if (request.skipped) return request;
  const summary = JSON.parse(execText("gh", request.args, request.options));
  const threads = queryReviewThreads(request.owner || repoOwner(state), summary.number);
  const prAuthor = summary.author?.login || "";
  const annotated = threads.map((thread) => ({
    ...thread,
    needs_response: thread.last_author !== prAuthor,
  }));
  return {
    number: summary.number,
    url: summary.url,
    state: summary.state,
    mergeable: summary.mergeable,
    head_branch: summary.headRefName,
    title: summary.title,
    review_decision: summary.reviewDecision,
    checks: checksSummary(summary.statusCheckRollup),
    failed_checks: failedChecks(summary.statusCheckRollup),
    unresolved_threads: annotated,
    thread_count: annotated.length,
    needs_response_count: annotated.filter((thread) => thread.needs_response).length,
  };
}

function removeDispatchMessage(sliceId) {
  const base = meta.legate_conductor_dir;
  if (typeof base !== "string" || base.length === 0) return false;
  const target = path.join(base, \`dispatch-msg-\${sliceId}.md\`);
  try {
    fs.rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

function removeWorkerSession(sessionId) {
  try {
    execFileSync(
      "agent-deck",
      ["-p", meta.profile, "session", "remove", sessionId, "--prune-worktree", "--force"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { removed: true };
  } catch (err) {
    const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join("\\n");
    if (/session [^\\s]+ not found|no such session|session [^\\s]+ does not exist/i.test(output)) {
      return { removed: false, reason: "session_not_found" };
    }
    return { error: output || String(err) };
  }
}

function archiveSlice(state, sliceId, slice, pr, terminalState, ts) {
  const archived = state.archived_slices && typeof state.archived_slices === "object"
    ? state.archived_slices
    : {};
  state.archived_slices = archived;
  const archivedSlice = {
    pr_number: pr.number ?? slice?.pr?.number ?? null,
    pr_url: pr.url ?? slice?.pr?.url ?? null,
    worker_title: slice.worker_title ?? null,
    terminal_state: terminalState,
  };
  if (terminalState === "MERGED") archivedSlice.merged_at = ts;
  if (terminalState === "CLOSED") archivedSlice.closed_at = ts;
  archived[sliceId] = archivedSlice;
  delete state.slices[sliceId];
}

function cleanupTerminalPrs(state, workerList, ts) {
  const cleanups = [];
  const failures = [];
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  if (!state || !Array.isArray(workerList)) return { cleanups, failures };
  const workers = workerList.filter(isWorkerSession);
  let mutated = false;

  for (const [sliceId, slice] of Object.entries(slices)) {
    if (!slice || typeof slice !== "object") continue;
    const sessionId = String(slice.worker_session_id || "");
    if (!sessionId) continue;
    if (!workers.some((session) => sessionMatchesSlice(session, slice))) continue;

    let pr;
    try {
      pr = queryPr(slice, state);
    } catch (err) {
      failures.push({ slice_id: sliceId, session_id: sessionId, error: err?.message || String(err) });
      continue;
    }
    if (pr?.skipped) continue;
    const terminalState = pr?.state;
    if (terminalState !== "MERGED" && terminalState !== "CLOSED") continue;

    removeDispatchMessage(sliceId);
    const removal = removeWorkerSession(sessionId);
    if (removal.error) {
      slice.last_action = ts;
      slice.last_action_note = \`cleanup failed: \${removal.error}\`;
      mutated = true;
      failures.push({
        slice_id: sliceId,
        session_id: sessionId,
        pr_number: pr.number ?? slice?.pr?.number ?? null,
        pr_state: terminalState,
        error: removal.error,
      });
      continue;
    }

    archiveSlice(state, sliceId, slice, pr, terminalState, ts);
    mutated = true;
    const cleanup = {
      schema_version: 1,
      ts,
      processor: meta.processor_name,
      paired_legate: meta.paired_legate,
      kind: "cleanup",
      slice_id: sliceId,
      session_id: sessionId,
      pr_number: pr.number ?? slice?.pr?.number ?? null,
      pr_url: pr.url ?? slice?.pr?.url ?? null,
      pr_state: terminalState,
      removed: removal.removed,
      reason: removal.reason ?? null,
    };
    cleanups.push(cleanup);
  }

  if (mutated) writeJson(meta.legate_state_path, state);
  return { cleanups, failures };
}

function actionKey(action, pr, extra = "") {
  const head = pr?.head_branch || "";
  return [action, pr?.number || "", pr?.state || "", pr?.mergeable || "", pr?.checks || "", head, extra].join(":");
}

function workerErrorRequestKey(sessionId, slice, recent) {
  const stage = slice.stage || "unknown";
  const pr = prNumber(slice) || "none";
  const outputHash = hashText(recent.output || recent.error || "");
  return \`worker-error:\${sessionId}:\${stage}:\${pr}:\${outputHash}\`;
}

function markSliceAction(slice, action, key, note, ts) {
  slice.last_processor_action = action;
  slice.last_processor_action_key = key;
  slice.last_processor_action_at = ts;
  slice.last_action = ts;
  slice.last_action_note = note;
}

function alreadyDispatched(slice, key) {
  return slice.last_processor_action_key === key;
}

function sendAgentDeckMessage(sessionId, message, wait = false) {
  const args = ["-p", meta.profile, "session", "send", sessionId, message, "-q"];
  if (wait) {
    args.push("--wait", "--timeout", "600s");
  } else {
    args.push("--no-wait");
  }
  return execText("agent-deck", args);
}

function truncateText(text, max = 4000) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return value.slice(value.length - max);
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 16);
}

function captureRecentSessionOutput(sessionId) {
  try {
    const output = execText("agent-deck", ["-p", meta.profile, "session", "output", sessionId, "-q"]);
    return { output: truncateText(output.trim()) };
  } catch (err) {
    return { output: "", error: err?.message || String(err) };
  }
}

function workerErrorDetail({ sliceId, slice, worker, sessionId, recent }) {
  const pr = slice.pr || {};
  const lines = [
    "Worker session is in agent-deck error state.",
    "",
    \`slice: \${sliceId}\`,
    \`session: \${sessionId}\${worker?.title ? " (" + worker.title + ")" : ""}\`,
    \`worker_path: \${worker?.path || slice.worktree_path || "unknown"}\`,
    \`stage: \${slice.stage || "unknown"}\`,
    \`PR: \${pr.url || (pr.number ? "#" + pr.number : "none")}\`,
    \`last_action_note: \${slice.last_action_note || "none"}\`,
    "",
    "Recent output:",
    recent.output || (recent.error ? \`<unavailable: \${recent.error}>\` : "<empty>"),
    "",
    "This is not deterministic-safe for the processor. Run legate.error to inspect the worker and choose recovery: resume prompt, direct diagnostic query, restart, login/auth escalation, or operator escalation.",
  ];
  return lines.join("\\n");
}

function sendDoorbellToLegate() {
  try {
    execText("agent-deck", [
      "-p",
      meta.profile,
      "session",
      "send",
      \`conductor-\${meta.paired_legate}\`,
      "[PROCESSOR]",
      "--no-wait",
      "-q",
    ]);
    return true;
  } catch {
    return false;
  }
}

function requestLegateJudgement(input) {
  if (input.slice && input.requestKey && input.slice.last_processor_request_key === input.requestKey) {
    return null;
  }
  const event = {
    schema_version: 1,
    ts: input.ts,
    processor: meta.processor_name,
    paired_legate: meta.paired_legate,
    kind: "processor_request",
    slice_id: input.sliceId,
    session_id: input.sessionId || null,
    pr_number: input.pr?.number ?? input.prNumber ?? null,
    reason: input.reason,
    detail: input.detail,
  };
  append(meta.processor_requests_path, event);
  append(meta.processor_events_path, event);
  const delivered = sendDoorbellToLegate();
  appendText(meta.processor_log_path, \`\${formatProcessorRequestLine(event)}\${delivered ? "" : " (doorbell delivery failed)"}\`);
  if (input.slice && input.requestKey) {
    input.slice.last_processor_request_key = input.requestKey;
    input.slice.last_processor_request_at = input.ts;
  }
  return event;
}

function updatePrSnapshot(slice, pr) {
  slice.pr = {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    checks: pr.checks,
    mergeable: pr.mergeable,
  };
  if (pr.head_branch) slice.actual_branch = pr.head_branch;
  slice.thread_count = pr.thread_count;
  slice.needs_response_count = pr.needs_response_count;
  slice.unresolved_threads = pr.unresolved_threads;
}

function threadsNeedingResponse(slice, pr) {
  const openAt = slice.pr_open_at ? Date.parse(slice.pr_open_at) : NaN;
  return (pr.unresolved_threads || []).filter((thread) => {
    if (thread.needs_response) return true;
    if (slice.stage !== "pr-open" && slice.stage) return false;
    if (!Number.isFinite(openAt)) return true;
    const last = Date.parse(thread.last_comment_at || "");
    return Number.isFinite(last) && last > openAt;
  });
}

function failedChecksSummary(pr) {
  const failed = pr.failed_checks || [];
  if (failed.length === 0) return "No failed-check details were available.";
  return failed
    .map((check) => \`- \${check.name}\${check.url ? ": " + check.url : ""}\`)
    .join("\\n");
}

function prDiscoverySince(slice) {
  return slice.last_action || slice.created_at || slice.dispatched_at || slice.started_at || "";
}

function reviewThreadsSummary(threads) {
  return threads
    .map((thread) => \`- \${thread.path || "unknown path"}\${thread.line ? ":" + thread.line : ""} by \${thread.last_author || thread.author || "unknown"}: \${thread.body_preview || ""}\`)
    .join("\\n");
}

function conflictMessage(slice, pr, state) {
  const defaultBranch = state?.repo?.default_branch || "main";
  const worktree = slice.worktree_path || "<worker worktree>";
  return \`/smithy.fix

PR #\${pr.number} is blocked from merging: GitHub reports mergeable=CONFLICTING against origin/\${defaultBranch}.

Please rebase onto the latest default and resolve the conflicts:

  cd "\${worktree}"
  git fetch origin
  git rebase origin/\${defaultBranch}

Resolve conflicted files by preserving both the latest default-branch intent and this slice's spec/contracts intent. Then:

  git add <resolved-paths>
  git rebase --continue
  git push --force-with-lease

Reply with the new HEAD sha when the push completes. If the conflict reflects a genuine design disagreement, abort the rebase and summarize the conflicting paths and disagreement.\`;
}

function reviewFixMessage(pr, threads) {
  return \`/smithy.fix

Unresolved review threads on PR #\${pr.number} need a response. Please address them in the same PR branch and push the fix.

Threads:
\${reviewThreadsSummary(threads)}\`;
}

function discoverPrForSlice(slice, state, sessionId) {
  const repoPath = state?.repo?.path || meta.repo?.path;
  if (!repoPath) return null;
  try {
    const output = execText("agent-deck", ["-p", meta.profile, "session", "output", sessionId, "-q"]);
    const matches = output.match(/https:\\/\\/github\\.com\\/[^\\s/]+\\/[^\\s/]+\\/pull\\/([0-9]+)/g) || [];
    if (matches.length > 0) {
      const url = matches[matches.length - 1];
      const number = url.split("/").pop();
      const pr = queryPrForBabysit({ pr: { number } }, state);
      return pr?.skipped ? null : pr;
    }
  } catch {
    // fall through to branch-based lookup
  }
  try {
    const owner = repoOwner(state);
    const args = ["pr", "list", "--author", "@me", "--state", "open", "--json", "number,url,state,mergeable,headRefName,title,statusCheckRollup,createdAt"];
    if (owner) args.push("-R", owner);
    const options = owner ? {} : { cwd: repoPath };
    const list = JSON.parse(execText("gh", args, options));
    if (!Array.isArray(list) || list.length === 0) return null;
    const since = prDiscoverySince(slice);
    const candidates = since
      ? list.filter((candidate) => String(candidate.createdAt || "") >= since)
      : list;
    const expectedBranch = slice.actual_branch || slice.branch || "";
    const branchMatches = expectedBranch
      ? candidates.filter((candidate) => candidate.headRefName === expectedBranch)
      : [];
    const chosen = (branchMatches.length > 0 ? branchMatches : candidates)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
    if (!chosen) return null;
    return queryPrForBabysit({ pr: { number: chosen.number } }, state);
  } catch {
    return null;
  }
}

function runBabysit(state, workerList, ts) {
  const actions = [];
  const failures = [];
  const requests = [];
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  if (!state || !Array.isArray(workerList)) return { actions, failures, requests, mutated: false };
  const workers = workerBySessionId(workerList);
  let mutated = false;

  for (const [sliceId, slice] of Object.entries(slices)) {
    if (!slice || typeof slice !== "object") continue;
    if (slice.resume_pending === "selected") continue;
    const sessionId = String(slice.worker_session_id || "");
    if (!sessionId) continue;
    const worker = workers.get(sessionId);
    if (!worker) continue;
    const workerStatus = worker.status || "other";

    if (workerStatus === "error") {
      const recent = captureRecentSessionOutput(sessionId);
      const key = workerErrorRequestKey(sessionId, slice, recent);
      if (!slice.worker_error_detected_at) slice.worker_error_detected_at = ts;
      slice.worker_error_last_seen_at = ts;
      const request = requestLegateJudgement({
        ts,
        slice,
        requestKey: key,
        sliceId,
        sessionId,
        pr: slice.pr || null,
        reason: "worker_session_error",
        detail: workerErrorDetail({ sliceId, slice, worker, sessionId, recent }),
      });
      if (request) {
        requests.push(request);
      }
      mutated = true;
      continue;
    }

    if (slice.worker_error_last_seen_at) {
      delete slice.worker_error_detected_at;
      delete slice.worker_error_last_seen_at;
      mutated = true;
    }

    if (workerStatus === "running") continue;

    let pr = null;
    if (!slice.pr && slice.stage === "implementing" && (workerStatus === "waiting" || workerStatus === "idle")) {
      pr = discoverPrForSlice(slice, state, sessionId);
      if (pr) {
        updatePrSnapshot(slice, pr);
        slice.stage = "pr-open";
        slice.pr_open_at = ts;
        markSliceAction(slice, "discover-pr", actionKey("discover-pr", pr), "processor discovered PR", ts);
        mutated = true;
        actions.push({ action: "discover-pr", sliceId, sessionId, pr, detail: "discovered worker PR" });
      }
    }

    if (!pr) {
      if (!slice.pr) continue;
      try {
        pr = queryPrForBabysit(slice, state);
      } catch (err) {
        const request = requestLegateJudgement({
          ts,
          slice,
          requestKey: actionKey("query-failed", slice.pr || {}, "query"),
          sliceId,
          sessionId,
          prNumber: slice.pr?.number,
          reason: "processor could not query PR state",
          detail: err?.message || String(err),
        });
        if (request) {
          requests.push(request);
          mutated = true;
        }
        continue;
      }
      if (pr?.skipped) continue;
      updatePrSnapshot(slice, pr);
      mutated = true;
    }

    if (pr.state === "MERGED" || pr.state === "CLOSED") continue;
    if (pr.state !== "OPEN") {
      const request = requestLegateJudgement({ ts, slice, requestKey: actionKey("unknown-pr-state", pr), sliceId, sessionId, pr, reason: "unknown PR state", detail: \`state=\${pr.state}\` });
      if (request) {
        requests.push(request);
        mutated = true;
      }
      continue;
    }

    if (pr.mergeable === "CONFLICTING") {
      if (slice.stage === "pr-resolving-conflicts") {
        const request = requestLegateJudgement({
          ts,
          slice,
          requestKey: actionKey("conflict-persisted", pr),
          sliceId,
          sessionId,
          pr,
          reason: "merge conflict persisted after processor prompt",
          detail: \`PR #\${pr.number} is still CONFLICTING after the processor previously sent a conflict-resolution prompt. Legate judgement is required before repeating recovery.\`,
        });
        if (request) {
          requests.push(request);
          mutated = true;
        }
        continue;
      }
      const key = actionKey("conflict-fix", pr);
      if (alreadyDispatched(slice, key)) continue;
      try {
        sendAgentDeckMessage(sessionId, conflictMessage(slice, pr, state), false);
      } catch (err) {
        const request = requestLegateJudgement({ ts, slice, requestKey: actionKey("conflict-send-failed", pr), sliceId, sessionId, pr, reason: "processor failed to send conflict-resolution prompt", detail: err?.message || String(err) });
        if (request) {
          requests.push(request);
          mutated = true;
        }
        continue;
      }
      slice.stage = "pr-resolving-conflicts";
      markSliceAction(slice, "conflict-fix", key, "processor sent conflict-resolution fix", ts);
      mutated = true;
      actions.push({ action: "conflict-fix", sliceId, sessionId, pr, detail: "sent conflict-resolution prompt" });
      continue;
    }

    const neededThreads = threadsNeedingResponse(slice, pr);
    if (neededThreads.length > 0) {
      if (slice.stage === "pr-in-fix") continue;
      const key = actionKey("review-fix", pr, neededThreads.map((thread) => \`\${thread.id || ""}@\${thread.last_comment_at || ""}\`).join(","));
      if (alreadyDispatched(slice, key)) continue;
      try {
        sendAgentDeckMessage(sessionId, reviewFixMessage(pr, neededThreads), false);
      } catch (err) {
        const request = requestLegateJudgement({ ts, slice, requestKey: actionKey("review-send-failed", pr, key), sliceId, sessionId, pr, reason: "processor failed to send review-thread /smithy.fix", detail: err?.message || String(err) });
        if (request) {
          requests.push(request);
          mutated = true;
        }
        continue;
      }
      slice.stage = "pr-in-fix";
      markSliceAction(slice, "review-fix", key, "processor sent review-thread /smithy.fix", ts);
      mutated = true;
      actions.push({ action: "review-fix", sliceId, sessionId, pr, detail: \`sent /smithy.fix for \${neededThreads.length} review thread(s)\` });
      continue;
    }

    if (pr.checks === "FAIL") {
      const request = requestLegateJudgement({
        ts,
        slice,
        requestKey: actionKey("ci-failure", pr, (pr.failed_checks || []).map((check) => \`\${check.name}:\${check.url || ""}\`).join(",")),
        sliceId,
        sessionId,
        pr,
        reason: "CI failure requires Legate judgement",
        detail: \`PR #\${pr.number} has failing CI. The deterministic processor cannot distinguish stale-main, transient flake, and real PR-diff failure safely. Failed checks:\\n\${failedChecksSummary(pr)}\`,
      });
      if (request) {
        requests.push(request);
        mutated = true;
      }
      continue;
    }

    if (pr.checks === "PASS" && pr.thread_count === 0 && pr.mergeable !== "CONFLICTING") {
      if (["pr-in-fix", "pr-resolving-conflicts", "pr-rebasing", "pr-in-rerun", "implementing"].includes(slice.stage)) {
        slice.stage = "pr-open";
        slice.pr_open_at = ts;
        markSliceAction(slice, "pr-open", actionKey("pr-open", pr), "processor observed PR all clear", ts);
        mutated = true;
        actions.push({ action: "pr-open", sliceId, sessionId, pr, detail: "observed PR all clear" });
      }
      continue;
    }

    if (pr.checks === "PENDING" || pr.mergeable === "UNKNOWN") continue;
  }

  if (mutated) writeJson(meta.legate_state_path, state);
  return { actions, failures, requests, mutated };
}

function tick() {
  const ts = now();
  let state = null;
  let stateError = null;
  try {
    state = readJsonIfPresent(meta.legate_state_path);
  } catch (err) {
    stateError = err?.message || String(err);
  }
  const workerList = agentDeckList();
  const cleanupResult = cleanupTerminalPrs(state, workerList, ts);
  const babysitWorkerList = cleanupResult.cleanups.length > 0
    ? agentDeckList()
    : workerList;
  const babysitResult = runBabysit(state, babysitWorkerList, ts);
  const summaryWorkerList = cleanupResult.cleanups.length > 0 || babysitResult.actions.length > 0
    ? agentDeckList()
    : workerList;
  const workers = summarizeWorkers(summaryWorkerList);
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const archived = state?.archived_slices && typeof state.archived_slices === "object"
    ? state.archived_slices
    : {};
  const record = {
    schema_version: 1,
    ts,
    processor: meta.processor_name,
    paired_legate: meta.paired_legate,
    kind: "heartbeat",
    mode: "terminal-pr-maintenance",
    state_present: Boolean(state),
    state_error: stateError,
    slice_count: Object.keys(slices).length,
    archived_slice_count: Object.keys(archived).length,
    workers,
    cleanup_count: cleanupResult.cleanups.length,
    cleanup_failure_count: cleanupResult.failures.length,
    babysit_action_count: babysitResult.actions.length,
    processor_request_count: babysitResult.requests.length,
  };
  append(meta.processor_events_path, record);
  for (const cleanup of cleanupResult.cleanups) {
    append(meta.processor_events_path, cleanup);
    appendText(meta.processor_log_path, formatCleanupLine(cleanup));
  }
  for (const failure of cleanupResult.failures) {
    append(meta.processor_events_path, {
      schema_version: 1,
      ts,
      processor: meta.processor_name,
      paired_legate: meta.paired_legate,
      kind: "cleanup_failure",
      ...failure,
    });
    appendText(meta.processor_log_path, formatCleanupFailureLine({ ts, ...failure }));
  }
  for (const action of babysitResult.actions) {
    const event = {
      schema_version: 1,
      ts,
      processor: meta.processor_name,
      paired_legate: meta.paired_legate,
      kind: "babysit_action",
      action: action.action,
      slice_id: action.sliceId,
      session_id: action.sessionId,
      pr_number: action.pr?.number ?? null,
      pr_url: action.pr?.url ?? null,
      detail: action.detail,
    };
    append(meta.processor_events_path, event);
    appendText(meta.processor_log_path, formatBabysitActionLine(event));
  }
  for (const failure of babysitResult.failures) {
    const event = {
      schema_version: 1,
      ts,
      processor: meta.processor_name,
      paired_legate: meta.paired_legate,
      kind: "babysit_failure",
      ...failure,
    };
    append(meta.processor_events_path, event);
    appendText(
      meta.processor_log_path,
      \`[\${ts}] babysit failed \${failure.slice_id || "unknown"}: \${failure.error}\`,
    );
  }
  appendText(
    meta.processor_log_path,
    \`[\${ts}] heartbeat slice_count=\${record.slice_count} archived=\${record.archived_slice_count} cleanups=\${record.cleanup_count} babysit_actions=\${record.babysit_action_count} processor_requests=\${record.processor_request_count} workers=\${JSON.stringify(workers)}\${stateError ? " state_error=" + stateError : ""}\`,
  );
}

function logTickError(err) {
  const message = err?.message || String(err);
  try {
    appendText(meta.processor_log_path, \`[\${now()}] processor_error=\${message}\`);
  } catch {
    console.error(\`[\${now()}] processor_error=\${message}\`);
  }
}

function safeTick() {
  try {
    tick();
  } catch (err) {
    logTickError(err);
  }
}

appendText(meta.processor_log_path, \`[\${now()}] processor starting in terminal-pr-maintenance mode for \${meta.paired_legate}\`);
replayRecentActionEvents();
safeTick();
setInterval(safeTick, Math.max(10, intervalSeconds) * 1000);
`;

async function writeProcessorFiles(input: {
  stagingDir: string;
  processorConductorDir: string;
  meta: Record<string, unknown>;
}): Promise<{ stagedLoopPath: string; stagedMetaPath: string }> {
  await fs.mkdir(input.stagingDir, { recursive: true });
  const stagedLoopPath = path.join(input.stagingDir, "processor-loop.mjs");
  const stagedMetaPath = path.join(input.stagingDir, "processor-meta.json");
  await fs.writeFile(stagedLoopPath, PROCESSOR_LOOP_MJS);
  await fs.chmod(stagedLoopPath, 0o755);
  await fs.writeFile(stagedMetaPath, JSON.stringify(input.meta, null, 2) + "\n");
  return { stagedLoopPath, stagedMetaPath };
}

async function copyProcessorFilesIntoConductor(
  processorStagingDir: string,
  processorConductorDir: string,
): Promise<void> {
  await fs.mkdir(processorConductorDir, { recursive: true });
  for (const name of ["processor-loop.mjs", "processor-meta.json"]) {
    await fs.copyFile(
      path.join(processorStagingDir, name),
      path.join(processorConductorDir, name),
    );
  }
  await fs.chmod(path.join(processorConductorDir, "processor-loop.mjs"), 0o755);
}

/**
 * Locate the bundled template *directory*. Tries paths relative to the
 * calling module so this works both when imported from source
 * (`src/legate/init.ts` → `src/templates/...`) and when bundled (`dist/cli.js` →
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
    path.join(here, "..", "templates", "legate"),
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

# PATH augmentation, baked in at \`march legate init\` time.
#
# Why: agent-deck's heartbeat systemd unit sets a minimal PATH (typically
# /usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin). On hosts where the user's
# interactive tmux comes from Homebrew/Linuxbrew (a different prefix), the
# systemd-restricted PATH resolves \`tmux\` to the system binary, which is
# usually an older version than the running tmux server. The protocol-
# mismatched client gets disconnected (\`server exited unexpectedly\`),
# and agent-deck's session-status probe falls back to reporting \`error\`
# — heartbeats then silently fail to deliver.
#
# The line below prepends the directory holding the tmux that \`march
# legate init\` saw on its PATH at deploy time, so the systemd-fired
# script uses the same tmux the user's shell does.
{TMUX_PATH_PREPEND}

NAME="{NAME}"
GROUP="{WORKER_GROUP}"
PROFILE="{PROFILE}"
TARGET="conductor-\$NAME"

if ! agent-deck conductor status --json 2>/dev/null | grep -q '"enabled".*true'; then
    exit 0
fi

# Skip only when the conductor is genuinely unreachable. agent-deck's
# status classifier transiently flips a Claude session to "error" when
# the TUI is in certain input states (e.g. half-typed text in the
# prompt, or a stale spinner) — those are recoverable, and a fresh
# heartbeat is usually what unsticks them. Skipping on "error" used to
# strand conductors overnight: every fire silently no-op'd while the
# session sat in transient-error. Skip only "running" (genuinely busy;
# next tick can pick up) and "stopped" (no tmux to deliver into).
STATE=$(agent-deck -p "$PROFILE" session show "$TARGET" --json 2>/dev/null \\
    | awk -F'"' '/"status"/{print $4; exit}')
case "$STATE" in
    running|stopped) exit 0 ;;
    "") exit 0 ;;
    *) ;;
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
 * Resolve the directory containing the `tmux` binary on the operator's
 * current PATH. Returns `null` when tmux is not findable (no `which` /
 * `where`, no tmux on PATH).
 *
 * Used by `writeLegateHeartbeatScript` to bake the operator's tmux dir
 * into heartbeat.sh's PATH so systemd-fired heartbeats use the same tmux
 * client as the user's interactive shell (preventing protocol-mismatch
 * failures with a brew-installed tmux server).
 */
export function resolveTmuxBinDir(): string | null {
  if (!isFinderAvailable() || !isOnPath("tmux")) return null;
  try {
    const out = execFileSync(FINDER_BIN, ["tmux"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // `which`/`where` may print multiple lines if a binary appears more
    // than once on PATH; take the first match — that's the resolution
    // an unadorned `tmux` invocation in this shell would get.
    const firstLine = out.split(/\r?\n/)[0]?.trim();
    if (!firstLine) return null;
    return path.dirname(firstLine);
  } catch {
    return null;
  }
}

/**
 * Render the heartbeat script for `(conductorName, profile, workerGroup)`
 * and write it to `<conductorDir>/heartbeat.sh` with mode 0755.
 *
 * `tmuxBinDir` is prepended to PATH inside the generated script (see the
 * comment in LEGATE_HEARTBEAT_SCRIPT_TEMPLATE for why). Pass `null` to
 * emit a commented-out placeholder — the script will fall through to the
 * systemd-default PATH, which fails on hosts whose tmux server runs from
 * a non-system prefix.
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
  tmuxBinDir: string | null = resolveTmuxBinDir(),
): Promise<void> {
  // Belt: forbid characters that remain "live" inside a bash double-
  // quoted string so the substitution can't escape its surroundings:
  //   "  ends the string
  //   \n \r  break the line / inject new statements
  //   $  parameter expansion (e.g. $RANDOM, ${HOME})
  //   `  command substitution (still active inside double quotes —
  //      this is the one we missed in the first pass; flagged by
  //      Copilot and Codex review independently)
  //   \  backslash escape — would let an attacker write \" or \$ to
  //      smuggle a metacharacter past a naive regex
  // validateConductorName already covers NAME/PROFILE; this guards the
  // new substitution.
  if (tmuxBinDir !== null && /["\n\r$`\\]/.test(tmuxBinDir)) {
    throw new LegateError(
      `Refusing to embed tmux dir with shell-special characters (",\\n,\\r,$,\`,\\\\): ${tmuxBinDir}`,
    );
  }
  const pathPrepend =
    tmuxBinDir === null
      ? `# tmux not found on PATH at \`march legate init\` time. If the systemd-\n` +
        `# fired heartbeats fail with \`session not running\`, prepend the dir\n` +
        `# holding your tmux to PATH here, e.g.:\n` +
        `# export PATH="/home/linuxbrew/.linuxbrew/bin:$PATH"`
      : `export PATH="${tmuxBinDir}:$PATH"`;
  const body = LEGATE_HEARTBEAT_SCRIPT_TEMPLATE
    .replaceAll("{NAME}", conductorName)
    .replaceAll("{PROFILE}", profile)
    .replaceAll("{WORKER_GROUP}", workerGroup)
    .replaceAll("{TMUX_PATH_PREPEND}", pathPrepend);
  const target = path.join(conductorDir, "heartbeat.sh");
  await fs.writeFile(target, body, { mode: 0o755 });
  // writeFile honors mode only when creating; on overwrite, fix the mode.
  await fs.chmod(target, 0o755);
}

/**
 * Probe `gh repo view` against `repoPath` for the GitHub slug
 * (`owner/repo`) and default branch name. Best-effort: returns nulls
 * when `gh` is missing, unauthenticated, the path isn't a git checkout,
 * or the remote isn't a GitHub repo. The caller is expected to surface
 * a postSetupWarning rather than abort, since the legate conductor can
 * still operate after an operator runs `gh auth login` and re-runs init.
 *
 * Why this exists: CLAUDE.md instructs the conductor to "look the slug up
 * once and cache it in state.json" on first run, but the lookup happens at
 * the top-level prompt — outside any skill script — so auto-mode's
 * classifier pauses on the compound `(cd <repo> && gh repo view ...)`
 * call. Pre-populating state.json at deploy time skips that stall, since
 * the conductor reads the cached values instead of re-running gh.
 */
export function discoverRepoMetadata(
  repoPath: string,
): { ownerWithName: string | null; defaultBranch: string | null } {
  let raw: string;
  try {
    raw = execFileSync(
      "gh",
      ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
      { cwd: repoPath, stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" },
    );
  } catch {
    return { ownerWithName: null, defaultBranch: null };
  }
  let parsed: { nameWithOwner?: string; defaultBranchRef?: { name?: string } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ownerWithName: null, defaultBranch: null };
  }
  return {
    ownerWithName: parsed.nameWithOwner ?? null,
    defaultBranch: parsed.defaultBranchRef?.name ?? null,
  };
}

/**
 * Initial state.json shape written into a fresh conductor dir. Mirrors the
 * schema documented in `snippets/state-json-schema.md`. `default_branch`
 * and `owner_with_name` are filled in from `discoverRepoMetadata`; both
 * may be null on a host without `gh` auth, in which case the conductor
 * falls back to the same lookup at heartbeat time (which is exactly the
 * stall this bootstrap exists to prevent — a postSetupWarning is the
 * right operator-facing signal).
 */
interface InitialStateRepoFields {
  profile: string;
  repoName: string;
  repoPath: string;
  ownerWithName: string | null;
  defaultBranch: string | null;
}

/**
 * Write `<conductorDir>/state.json` with the discovered repo slug and
 * default branch pre-populated, so the conductor's first dispatch
 * heartbeat reads cached values instead of inlining a top-level
 * `gh repo view` (which auto-mode pauses on — see discoverRepoMetadata).
 *
 * Merge semantics — the conductor owns `slices` / `archived_slices` /
 * timestamps after the first heartbeat, so on re-run we must NOT clobber
 * the file. Instead:
 *   - If state.json is missing, write a fresh skeleton with discovered
 *     repo fields.
 *   - If state.json exists, fill in only repo-level fields that are
 *     null/missing (`profile`, `repo.name`, `repo.path`,
 *     `repo.owner_with_name`, `repo.default_branch`). Operator-managed
 *     `slices` / `archived_slices` are left untouched.
 *
 * Returns true when the file was created or mutated, false when it
 * existed and already had every repo field populated. The boolean is
 * surfaced in the post-setup summary so the operator can distinguish
 * "I just bootstrapped it" from "no-op, already current."
 */
export async function ensureInitialState(
  conductorDir: string,
  defaults: InitialStateRepoFields,
): Promise<boolean> {
  const target = path.join(conductorDir, "state.json");
  let existing: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(target, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    existing = null;
  }

  if (existing) {
    let mutated = false;
    if (!existing.profile) {
      existing.profile = defaults.profile;
      mutated = true;
    }
    const repoRaw = existing.repo;
    const repo: Record<string, unknown> =
      repoRaw && typeof repoRaw === "object" && !Array.isArray(repoRaw)
        ? (repoRaw as Record<string, unknown>)
        : {};
    if (existing.repo !== repo) {
      existing.repo = repo;
      mutated = true;
    }
    if (!repo.name) {
      repo.name = defaults.repoName;
      mutated = true;
    }
    if (!repo.path) {
      repo.path = defaults.repoPath;
      mutated = true;
    }
    if (!repo.owner_with_name && defaults.ownerWithName) {
      repo.owner_with_name = defaults.ownerWithName;
      mutated = true;
    }
    if (!repo.default_branch && defaults.defaultBranch) {
      repo.default_branch = defaults.defaultBranch;
      mutated = true;
    }
    if (mutated) {
      await fs.writeFile(target, JSON.stringify(existing, null, 2) + "\n");
    }
    return mutated;
  }

  const initial = {
    profile: defaults.profile,
    repo: {
      name: defaults.repoName,
      path: defaults.repoPath,
      default_branch: defaults.defaultBranch,
      owner_with_name: defaults.ownerWithName,
    },
    slices: {},
    archived_slices: {},
  };
  await fs.writeFile(target, JSON.stringify(initial, null, 2) + "\n");
  return true;
}

/**
 * Cold-start priming prompt sent to the conductor immediately after
 * `agent-deck session restart` succeeds, before the first heartbeat
 * arrives. This is the *only* opportunity the model has to emit a
 * first-turn alignment statement before tool calls begin: without it,
 * the conductor's first turn is its response to a `[HEARTBEAT]`, and
 * the auto-mode classifier evaluates `Skill(legate.*)` + skill-script
 * bashes against an essentially empty recent context.
 *
 * The prompt introduces the legate persona and goals at high level —
 * just enough for auto-mode to gauge alignment — and explicitly defers
 * to CLAUDE.md and the per-skill `SKILL.md` files for the strict
 * mechanics. Keep this short and persona-shaped; do not duplicate the
 * full heartbeat decision tree, the state.json schema, or the boundary
 * rules. Those live in CLAUDE.prompt and the skill prompts; drift
 * between this prompt and CLAUDE.md is a maintenance hazard.
 *
 * Placeholders (single-curly, replaced via `.replaceAll`):
 *   {REPO_NAME}, {REPO_PATH}, {PROFILE}, {WORKER_GROUP}
 */
const LEGATE_COLD_START_PROMPT_TEMPLATE = `Cold start as the Legate for {REPO_NAME} ({REPO_PATH}, agent-deck profile {PROFILE}). You are a Claude Code session in --permission-mode auto whose job is to keep the Smithy plan→PR→fix loop running on this one repo without operator intervention. Your CLAUDE.md is the authoritative spec for behavior — read it; this message just primes alignment.

Persona and goals:
- You orchestrate Smithy work for {REPO_NAME} only. You do not touch other repos or other profiles.
- You drive worker Claude sessions (group: {WORKER_GROUP}) through /smithy.* slash commands, watch the GitHub PRs they open, and dispatch fixes when CI fails or reviewers leave inline comments. Workers do all implementation; you never edit the repo directly.
- Optimize for forward progress with minimal operator escalation: drain merged PRs, unblock waiting workers, dispatch the next ready slice. Ask for help (NEED:) only when the situation is genuinely outside your loop.
- One /smithy.<verb> dispatch = one PR. You never auto-merge.

What you operate on:
- agent-deck conductor — parent/child links, heartbeats, transition notifications.
- smithy CLI + skills — source of truth for what work to pick next.
- gh CLI — source of truth for high-level PR state.
- The smithy.pr-review skill — source of truth for unresolved inline review threads.

Seven skills carry the mechanics. Load each once on this turn so the auto-mode classifier registers their allowed-tools:
- legate.resume — worker session-restart recovery and Resume-from-summary picker clearing.
- legate.error — opaque worker error recovery via inspection, login escalation, restart, or diagnostic prompt.
- legate.babysit — existing PRs (CI failures, conflicts, review threads, merges).
- legate.merge — strict-gate auto-squash-merge.
- legate.cleanup — post-merge teardown (kill worker, prune worktree, archive slice).
- legate.dispatch — new work (launch one worker for one ready slice).
- legate.issue — operator-driven GitHub issue intake.

Auto-mode alignment — your routine actions are exactly:
(a) Skill() to load one of the seven skills above;
(b) bash invocation of a script under .claude/skills/legate.*/scripts/;
(c) Read/Edit of state.json, task-log.md, LEARNINGS.md, POLICY.md, CLAUDE.md, meta.json, or */SKILL.md inside this conductor dir;
(d) a [STATUS] or NEED: reply to a heartbeat or operator message.

Anything else escalates via NEED: rather than executing — inline python3 -c / bash -c / node -e, scripts outside legate.*, writes outside cwd, direct network primitives, destructive git (reset --hard, push --force, clean -fd), work against another repo or profile, or agent-deck session send to a running worker.

On this turn:
1. Read CLAUDE.md end-to-end.
2. Run its cold-start checklist (read state.json if present; load legate.resume, legate.error, legate.babysit, legate.merge, legate.cleanup, legate.dispatch, and legate.issue once via the Skill tool; append a startup entry to task-log.md).
3. Reply with the cold-start acknowledgement: "Online for {REPO_NAME} ({PROFILE}). Skills available: legate.resume, legate.error, legate.babysit, legate.merge, legate.cleanup, legate.dispatch, legate.issue. Will not invoke anything outside their scripts without escalating."
4. Wait for the first [HEARTBEAT]. Do not poll on your own.`;

/**
 * Render the cold-start priming prompt for a freshly-restarted conductor.
 * Intended to be passed as the message argument of `agent-deck session send`
 * via {@link execFileSync} (argv-direct, so the embedded backticks, dashes,
 * and arrows do not need shell escaping).
 */
export function buildColdStartPrompt(opts: {
  profile: string;
  workerGroup: string;
  repoName: string;
  repoPath: string;
}): string {
  return LEGATE_COLD_START_PROMPT_TEMPLATE
    .replaceAll("{REPO_NAME}", opts.repoName)
    .replaceAll("{REPO_PATH}", opts.repoPath)
    .replaceAll("{PROFILE}", opts.profile)
    .replaceAll("{WORKER_GROUP}", opts.workerGroup);
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
  const processorOnly = opts.processorOnly === true;
  const processorEnabled = processorOnly || opts.processor !== false;
  const shouldRunSetup = opts.runSetup ?? true;
  const runLegateSetup = shouldRunSetup && !processorOnly;
  const runProcessorSetup = shouldRunSetup && processorEnabled;
  const processorName = opts.conductorName
    ? deriveProcessorName(conductorName)
    : defaults.processorName;
  const workerGroup = opts.workerGroup ?? defaults.workerGroup;
  const model = opts.model ?? "sonnet";
  const heartbeatInterval = opts.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;
  const repoName = defaults.repoName;
  const description =
    opts.description ??
    `Legate orchestrator for ${repoName} (Smithy plan→PR→fix loop)`;

  if (processorOnly && opts.processor === false) {
    throw new LegateError(
      "`--processor-only` cannot be combined with `--no-processor`.",
    );
  }
  if (processorOnly && opts.withContainer) {
    throw new LegateError(
      "`march legate init --processor-only` cannot be combined with --with-container because the Claude Legate conductor is not deployed.",
    );
  }
  // Validate before composing any filesystem path so caller-supplied values
  // like `../../.ssh` cannot escape the staging root, and so we surface a
  // march-side error instead of shelling out and parsing agent-deck's stderr.
  validateProfileName(profile);
  validateConductorName(conductorName);
  if (processorEnabled) validateConductorName(processorName);
  validateHeartbeatInterval(heartbeatInterval);
  if (opts.withContainer && !runLegateSetup) {
    throw new LegateError(
      "`march legate init --with-container` requires setup so there is a conductor directory to mount. Remove --no-setup and re-run.",
    );
  }

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
    PROCESSOR_NAME: processorName,
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
  // Cold-start priming prompt: delivered as the conductor's first user
  // message after `session restart`, before the first heartbeat arrives.
  // Without it, the model's first reply is to a terse [HEARTBEAT] line
  // and auto-mode's classifier judges the first Skill() / script-bash
  // calls against essentially empty recent context. See
  // LEGATE_COLD_START_PROMPT_TEMPLATE for rationale.
  const coldStartPrompt = buildColdStartPrompt({
    profile,
    workerGroup,
    repoName,
    repoPath,
  });
  // Stage the rendered prompt so manual remediation commands can reference
  // it via `"$(cat <file>)"` instead of inlining the multi-paragraph body.
  const coldStartPromptPath = path.join(stagingDir, "cold-start-prompt.txt");
  try {
    await fs.writeFile(coldStartPromptPath, coldStartPrompt);
  } catch {
    throw new LegateError(
      `Cannot write cold-start prompt file: ${coldStartPromptPath}`,
    );
  }
  const sendColdStartCommand = [
    "agent-deck",
    "-p",
    profile,
    "session",
    "send",
    conductorTitle,
    coldStartPrompt,
  ];
  const sendColdStartManualHint =
    `agent-deck -p ${shellQuote(profile)} session send ${shellQuote(conductorTitle)} ` +
    `"$(cat ${shellQuote(coldStartPromptPath)})"`;
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
    sendColdStartCommand,
  ];
  if (startBridgeCommand) postSetupCommands.push(startBridgeCommand);

  const conductorDir = path.join(home, ".agent-deck", "conductor", conductorName);
  const processorStagingDir = path.join(stagingDir, "processor");
  const processorConductorDir = path.join(
    home,
    ".agent-deck",
    "conductor",
    processorName,
  );
  const processorSetupCommand = [
    "agent-deck",
    "-p",
    profile,
    "conductor",
    "setup",
    processorName,
    "-description",
    `Deterministic PR maintenance Legate processor for ${repoName}`,
    "-no-heartbeat",
  ];
  const processorTitle = `conductor-${processorName}`;
  const processorRuntimeCommand = formatShellCommand([
    "node",
    path.join(processorConductorDir, "processor-loop.mjs"),
  ]);
  const setProcessorToolCommand = [
    "agent-deck",
    "-p",
    profile,
    "session",
    "set",
    processorTitle,
    "tool",
    "shell",
  ];
  const setProcessorCommandCommand = [
    "agent-deck",
    "-p",
    profile,
    "session",
    "set",
    processorTitle,
    "command",
    processorRuntimeCommand,
  ];
  const restartProcessorCommand = [
    "agent-deck",
    "-p",
    profile,
    "session",
    "restart",
    processorTitle,
  ];
  const processorPostSetupCommands = [
    setProcessorToolCommand,
    setProcessorCommandCommand,
    restartProcessorCommand,
  ];
  if (processorEnabled) {
    try {
      await writeProcessorFiles({
        stagingDir: processorStagingDir,
        processorConductorDir,
        meta: processorMetaFor({
          profile,
          conductorName,
          processorName,
          repoName,
          repoPath,
          workerGroup,
          processorConductorDir,
          legateConductorDir: conductorDir,
        }),
      });
    } catch (err) {
      throw new LegateError(
        `Failed to stage deterministic processor files: ${(err as Error).message}`,
      );
    }
  }

  let setupRan = false;
  let processorSetupRan = false;
  let processorConfigured = false;
  let autoModeConfigured = false;
  let bridgeActive = false;
  let heartbeatOverrideWritten = false;
  let legateContainer: LegateContainerResult | undefined;
  let deploymentResults: { name: LegateSkillName; deployed: boolean }[] = [];
  const postSetupWarnings: string[] = [];
  if (runLegateSetup) {
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

    // Pin the conductor's heartbeat cadence via a systemd drop-in override.
    // agent-deck's default is 15 min (set globally in
    // `~/.agent-deck/config.toml`); 5 min is the legate sweet spot — fast
    // enough that stuck workers are noticed promptly, slow enough that we
    // don't burn through tokens on no-op ticks. The drop-in is per-conductor
    // so multiple legates can coexist with different cadences if needed.
    // Linux-only: macOS has no systemd; on other platforms we skip with a
    // warning and the operator can pin the cadence manually.
    if (isLinuxLike) {
      // Probe via `systemctl --user cat` rather than `fs.stat` on a single
      // path: systemd user units can live in any of the standard search
      // paths (`~/.config/systemd/user`, `/etc/systemd/user`,
      // `/usr/lib/systemd/user`, etc.). `systemctl cat` returns exit 0 iff
      // the unit is loadable from any of them, so checking one path with
      // `fs.stat` would silently skip the override on hosts where the unit
      // ships from a system path.
      const timerUnit = `agent-deck-conductor-heartbeat-${conductorName}.timer`;
      let timerUnitExists = false;
      try {
        execFileSync("systemctl", ["--user", "cat", timerUnit], {
          stdio: "ignore",
        });
        timerUnitExists = true;
      } catch {
        timerUnitExists = false;
      }
      if (!timerUnitExists) {
        postSetupWarnings.push(
          `Heartbeat timer unit ${timerUnit} is not loadable by systemd --user ` +
            `(\`systemctl --user cat ${timerUnit}\` failed). agent-deck did not ` +
            `install a per-conductor systemd timer — the cadence-override drop-in ` +
            `was not written. The conductor will fall back to whatever cadence the ` +
            `agent-deck bridge daemon uses (default 15 min, from ` +
            `~/.agent-deck/config.toml's [conductor].heartbeat_interval).`,
        );
      } else {
        try {
          await writeHeartbeatTimerOverride(
            home,
            conductorName,
            heartbeatInterval,
          );
          heartbeatOverrideWritten = true;
          // daemon-reload + restart so the new cadence takes effect this
          // run. Best-effort: if either fails the override file is still on
          // disk and a subsequent host reboot picks it up, so we warn rather
          // than abort.
          try {
            execFileSync("systemctl", ["--user", "daemon-reload"], {
              stdio: "ignore",
            });
            execFileSync(
              "systemctl",
              [
                "--user",
                "restart",
                `agent-deck-conductor-heartbeat-${conductorName}.timer`,
              ],
              { stdio: "ignore" },
            );
          } catch (err) {
            postSetupWarnings.push(
              `Wrote heartbeat-cadence override (${heartbeatInterval}) but failed to ` +
                `reload/restart the timer: ${(err as Error).message}\n` +
                `The new cadence will take effect after the next host reboot, or ` +
                `you can apply it manually:\n` +
                `  systemctl --user daemon-reload\n` +
                `  systemctl --user restart agent-deck-conductor-heartbeat-${conductorName}.timer`,
            );
          }
        } catch (err) {
          postSetupWarnings.push(
            `Failed to write heartbeat-cadence override (${heartbeatInterval}) ` +
              `for ${conductorName}: ${(err as Error).message}\n` +
              `The conductor will fall back to the agent-deck default cadence ` +
              `(15 min). Pin manually by creating ` +
              `~/.config/systemd/user/agent-deck-conductor-heartbeat-${conductorName}.timer.d/override.conf.`,
          );
        }
      }
    } else {
      postSetupWarnings.push(
        `Heartbeat-cadence override is currently Linux/WSL2 only (this host: ` +
          `${process.platform}). The conductor will run at the agent-deck default ` +
          `cadence (15 min, from ~/.agent-deck/config.toml's [conductor].heartbeat_interval). ` +
          `To pin a different cadence, configure the platform-equivalent scheduler manually.`,
      );
    }

    // Bootstrap state.json with the GitHub slug + default branch so the
    // conductor's first dispatch does not stall on a top-level
    // `(cd <repo> && gh repo view ...)` call (auto-mode pauses on the
    // compound shell op, since it's outside any skill script). Best-effort
    // on every axis: discovery failure is reported as a warning, write
    // failure is reported as a warning, and an existing state.json is
    // merged rather than clobbered to preserve operator-managed slices.
    const repoMetadata = discoverRepoMetadata(repoPath);
    if (!repoMetadata.ownerWithName || !repoMetadata.defaultBranch) {
      postSetupWarnings.push(
        `Could not discover GitHub slug and/or default branch for ${repoPath} ` +
          `via \`gh repo view\` (got owner_with_name=${repoMetadata.ownerWithName ?? "null"}, ` +
          `default_branch=${repoMetadata.defaultBranch ?? "null"}). ` +
          `state.json will be written with whatever was discovered; the conductor ` +
          `will fall back to inlining \`gh repo view\` on its first dispatch ` +
          `heartbeat, which auto-mode pauses on. Fix: \`gh auth login\` (or ensure ` +
          `the path is a checkout of a GitHub repo), then re-run \`march legate init\`.`,
      );
    }
    try {
      await ensureInitialState(conductorDir, {
        profile,
        repoName,
        repoPath,
        ownerWithName: repoMetadata.ownerWithName,
        defaultBranch: repoMetadata.defaultBranch,
      });
    } catch (err) {
      postSetupWarnings.push(
        `Failed to bootstrap state.json in ${conductorDir}: ` +
          `${(err as Error).message}\n` +
          `Without it, the conductor's first dispatch heartbeat will inline a ` +
          `top-level \`gh repo view\` call that auto-mode pauses on — the loop ` +
          `will stall on operator approval until the slug is cached.`,
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

    // Deliver the cold-start priming prompt before the first heartbeat
    // can arrive. Gated on autoModeConfigured so we know the conductor
    // was successfully restarted (and is therefore alive to receive).
    // Best-effort: a failure means the conductor will still run, but
    // its first reply will be to a terse [HEARTBEAT] rather than the
    // priming context, so the auto-mode classifier may pause more often.
    if (autoModeConfigured) {
      try {
        execFileSync(sendColdStartCommand[0], sendColdStartCommand.slice(1), {
          stdio: "inherit",
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        postSetupWarnings.push(
          `Failed to deliver cold-start priming prompt to ${conductorTitle} (exit ${status ?? "?"}). ` +
            `The conductor will still run, but its first reply will respond to a heartbeat ` +
            `rather than priming context — auto-mode classifier may pause more often. ` +
            `Prompt staged at ${coldStartPromptPath}. Run manually:\n  ${sendColdStartManualHint}`,
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
    // No Claude conductor setup ran; record skills as staged-but-not-deployed
    // so the result shape is consistent.
    deploymentResults = LEGATE_SKILLS.map((name) => ({ name, deployed: false }));
  }

  if (runProcessorSetup) {
    try {
      execFileSync(processorSetupCommand[0], processorSetupCommand.slice(1), {
        stdio: "inherit",
      });
      processorSetupRan = true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      postSetupWarnings.push(
        `agent-deck processor conductor setup failed (exit ${status ?? "?"}). ` +
          `Processor files are staged at ${processorStagingDir}; run manually:\n` +
          `  ${formatShellCommand(processorSetupCommand)}`,
      );
    }
    if (processorSetupRan) {
      try {
        await copyProcessorFilesIntoConductor(
          processorStagingDir,
          processorConductorDir,
        );
      } catch (err) {
        postSetupWarnings.push(
          `Failed to copy deterministic processor files into ${processorConductorDir}: ` +
            `${(err as Error).message}`,
        );
      }
      let processorToolSet = false;
      try {
        execFileSync(
          setProcessorToolCommand[0],
          setProcessorToolCommand.slice(1),
          { stdio: "inherit" },
        );
        processorToolSet = true;
      } catch (err) {
        const status = (err as { status?: number }).status;
        postSetupWarnings.push(
          `Failed to set processor session tool to shell (exit ${status ?? "?"}). ` +
            `Run manually:\n  ${formatShellCommand(setProcessorToolCommand)}`,
        );
      }
      if (processorToolSet) {
        try {
          execFileSync(
            setProcessorCommandCommand[0],
            setProcessorCommandCommand.slice(1),
            { stdio: "inherit" },
          );
          execFileSync(
            restartProcessorCommand[0],
            restartProcessorCommand.slice(1),
            { stdio: "inherit" },
          );
          processorConfigured = true;
        } catch (err) {
          const status = (err as { status?: number }).status;
          postSetupWarnings.push(
            `Failed to configure/restart processor runtime (exit ${status ?? "?"}). ` +
              `Run manually:\n  ${formatShellCommand(setProcessorCommandCommand)}\n  ${formatShellCommand(restartProcessorCommand)}`,
          );
        }
      }
    }
  }

  if (opts.withContainer) {
    try {
      legateContainer = ensureLegateContainer({
        conductorName,
        profile,
        repoPath,
        conductorDir,
        homeDir: home,
      });
    } catch (err) {
      throw new LegateError(
        `Failed to launch Hatchery Legate container: ${(err as Error).message}`,
      );
    }
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
    : processorOnly
      ? `${LEGATE_SKILLS.join(", ")} staged at ${skillsStagedDir} (Claude conductor not deployed)`
      : `${LEGATE_SKILLS.join(", ")} staged at ${skillsStagedDir} (copied into conductor on setup)`;
  const processorLine = processorEnabled
    ? processorConfigured
      ? `${processorName} (terminal PR maintenance shell runtime configured)`
      : runProcessorSetup
        ? `${processorName} staged/configuration incomplete — see warnings`
        : `${processorName} (terminal PR maintenance deferred — run setup first)`
    : "disabled (--no-processor)";
  const legateStatus = processorOnly
    ? processorConfigured
      ? "processor-only configured"
      : runProcessorSetup
        ? "processor-only incomplete"
        : "processor-only rendered"
    : setupRan
      ? "configured"
      : "rendered";

  const baseLines = [
    `Legate (${conductorName}) ${legateStatus} for ${repoName}.`,
    `  Profile:        ${profile}`,
    `  Conductor:      ${
      processorOnly ? `${conductorName} (not deployed; state path only)` : conductorName
    }`,
    `  Processor:      ${processorLine}`,
    `  Worker group:   ${workerGroup}`,
    `  Repo:           ${repoPath}`,
    `  Template:       ${templateOutputPath}`,
    `  Conductor dir:  ${conductorDir}`,
    `  Processor dir:  ${
      processorEnabled ? processorConductorDir : "disabled"
    }`,
    `  Auto mode:      ${
      processorOnly
        ? "skipped (--processor-only)"
        : setupRan
        ? autoModeConfigured
          ? "enabled (auto-mode field set on conductor session)"
          : "NOT configured — see warnings"
        : "deferred (run setup first)"
    }`,
    `  Model:          ${model}${
      processorOnly ? " (skipped — processor-only)" : setupRan ? "" : " (deferred — run setup first)"
    }`,
    `  Bridge daemon:  ${
      processorOnly
        ? "skipped (--processor-only)"
        : setupRan
        ? bridgeActive
          ? "active (heartbeats will reach the conductor)"
          : "NOT active — conductor will only respond to manual session-send messages; see warnings"
        : "deferred (run setup first)"
    }`,
    `  Heartbeat:      ${
      processorOnly
        ? "skipped (--processor-only)"
        : setupRan
        ? heartbeatOverrideWritten
          ? `${heartbeatInterval} (pinned via systemd drop-in override)`
          : `${heartbeatInterval} requested — override NOT written; see warnings`
        : `${heartbeatInterval} (deferred — run setup first)`
    }`,
    `  Container:      ${
      legateContainer
        ? `${legateContainer.containerName} (${legateContainer.containerId || "id unavailable"}) using ${legateContainer.imageTag}${
            legateContainer.replaced ? " — replaced existing container" : ""
          }`
        : "not requested"
    }`,
    `  Skills:         ${skillsLine}`,
    "",
  ];
  const tailLines = processorOnly
    ? processorConfigured
      ? [
          "Processor-only deployment complete. The Claude Legate conductor was not",
          "created, started, restarted, or configured. The processor observes the",
          "existing Legate state file path when present:",
          `  ${path.join(conductorDir, "state.json")}`,
          "",
          "Attach:",
          `  agent-deck -p ${profile} session attach ${processorTitle}`,
        ]
      : runProcessorSetup
        ? [
            "Processor-only deployment was attempted, but processor configuration",
            "did not complete. The Claude Legate conductor was not created or",
            "started. See warnings above, then run the printed processor commands.",
          ]
      : [
          "Processor-only setup skipped (--no-setup). Processor files are staged at",
          `  ${processorStagingDir}`,
          "and the Claude Legate conductor will not be created. Run when ready:",
          `  ${formatShellCommand(processorSetupCommand)}`,
          "",
          "Then copy the staged processor files into the processor conductor dir:",
          `  ${formatShellCommand(["cp", path.join(processorStagingDir, "processor-loop.mjs"), path.join(processorConductorDir, "processor-loop.mjs")])}`,
          `  ${formatShellCommand(["cp", path.join(processorStagingDir, "processor-meta.json"), path.join(processorConductorDir, "processor-meta.json")])}`,
          "",
          "Then configure and start the deterministic processor:",
          `  ${formatShellCommand(setProcessorToolCommand)}`,
          `  ${formatShellCommand(setProcessorCommandCommand)}`,
          `  ${formatShellCommand(restartProcessorCommand)}`,
          "",
          "Attach:",
          `  agent-deck -p ${profile} session attach ${processorTitle}`,
        ]
    : setupRan
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
        ...(processorEnabled
          ? [`  ${formatShellCommand(processorSetupCommand)}`]
          : []),
        "",
        "Then enable auto mode, pin model, restart, and deliver the",
        "cold-start priming prompt (staged below):",
        `  ${formatShellCommand(setAutoModeCommand)}`,
        `  ${formatShellCommand(setModelCommand)}`,
        `  ${formatShellCommand(restartCommand)}`,
        `  ${sendColdStartManualHint}`,
        ...(processorEnabled
          ? [
              "",
              "Then copy the staged processor files into the processor conductor dir:",
              `  ${formatShellCommand(["cp", path.join(processorStagingDir, "processor-loop.mjs"), path.join(processorConductorDir, "processor-loop.mjs")])}`,
              `  ${formatShellCommand(["cp", path.join(processorStagingDir, "processor-meta.json"), path.join(processorConductorDir, "processor-meta.json")])}`,
              "",
              "Then configure and start the deterministic processor:",
              `  ${formatShellCommand(setProcessorToolCommand)}`,
              `  ${formatShellCommand(setProcessorCommandCommand)}`,
              `  ${formatShellCommand(restartProcessorCommand)}`,
            ]
          : []),
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
    ...(processorEnabled ? { processorName } : {}),
    workerGroup,
    repoName,
    repoPath,
    templateOutputPath,
    conductorDir,
    ...(processorEnabled
      ? {
          processorStagingDir,
          processorConductorDir,
          processorSetupCommand,
          processorPostSetupCommands,
          processorSetupRan,
          processorConfigured,
        }
      : {}),
    skillsStagedDir,
    skills,
    setupCommand,
    postSetupCommands,
    setupRan,
    autoModeConfigured,
    bridgeActive,
    heartbeatInterval,
    heartbeatOverrideWritten,
    ...(legateContainer ? { legateContainer } : {}),
    summary: summaryLines.join("\n"),
  };
}
