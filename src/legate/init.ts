import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Dotprompt } from "dotprompt";
import { FINDER_BIN, isFinderAvailable, isOnPath } from "../shared/deps.js";
import { ensureLegateService, registerProfile } from "./profile-register.js";

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

function renderDisabledHeartbeatScript(conductorName: string): string {
  return `#!/bin/sh
# march-managed: ${conductorName} is reactive; legate-loop owns ticks.
exit 0
`;
}

async function writeDisabledHeartbeatScript(
  conductorDir: string,
  conductorName: string,
): Promise<string> {
  validateConductorName(conductorName);
  const target = path.join(conductorDir, "heartbeat.sh");
  await fs.writeFile(target, renderDisabledHeartbeatScript(conductorName), {
    mode: 0o755,
  });
  await fs.chmod(target, 0o755);
  return target;
}

function disableLegacyHeartbeatTimer(conductorName: string): void {
  validateConductorName(conductorName);
  const timer = `agent-deck-conductor-heartbeat-${conductorName}.timer`;
  const service = `agent-deck-conductor-heartbeat-${conductorName}.service`;
  execFileSync("systemctl", ["--user", "disable", "--now", timer], {
    stdio: "ignore",
  });
  try {
    execFileSync("systemctl", ["--user", "stop", service], {
      stdio: "ignore",
    });
  } catch {
    // The one-shot service is usually inactive after the timer fires.
  }
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], {
      stdio: "ignore",
    });
  } catch {
    // The timer is already disabled; daemon-reload is best-effort cleanup.
  }
}

const TEMPLATE_VARS = [
  "REPO_NAME",
  "REPO_PATH",
  "PROFILE",
  "CONDUCTOR_NAME",
  "LOOP_NAME",
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
  "legate.issue",
  "legate.unwedge",
] as const;
export type LegateSkillName = (typeof LEGATE_SKILLS)[number];

/**
 * Read-only `agent-deck` patterns the conductor sometimes needs outside the
 * skill scripts. In practice the conductor also legitimately reaches for
 * `session output` (to read what a worker last
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

/**
 * `march` CLI patterns the conductor needs since the legate loop is Herald-backed
 * and there is no `state.json` to read (#176). `legate.unwedge` reads the
 * escalated slice from Herald (`march herald state --json`) and un-wedges it with
 * `march legate recover <sliceId>` instead of editing a state file (#238). Like
 * {@link AGENT_DECK_READ_ALLOWS} these are belt-and-suspenders so a heartbeat-time
 * invocation never stalls on a permission prompt — `recover` is the one mutation,
 * deliberately allowed because it is the *only* deterministic escalation-recovery
 * action and is itself just an append to the event log.
 */
const MARCH_CLI_ALLOWS = [
  "Bash(march herald state *)",
  "Bash(march herald events *)",
  "Bash(march legate recover *)",
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
   * Claude model alias or full ID for the conductor session itself. Default:
   * `opus` — the conductor needs Claude Code's auto-mode classifier, which
   * is only available on opus. Effort is set separately ({@link effort}) so
   * we don't pay full reasoning cost for orchestration work.
   * Override with full IDs (e.g. `claude-opus-4-7`) when needed.
   */
  model?: string;
  /**
   * Claude Code \`--effort\` level for the conductor session: low | medium |
   * high | xhigh | max. Default: `medium` — the conductor is reasoning-light
   * (read state, dispatch, watch, update). High effort is reserved for the
   * complex escalation judgements, which the worker sessions handle. Setting
   * this lower than \`high\` materially reduces per-tick latency and cost.
   */
  effort?: string;
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
  /** Deploy the paired deterministic Legate loop service container. Default: true. */
  loop?: boolean;
  /** Deprecated alias for {@link loop}. */
  processor?: boolean;
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
  loopName?: string;
  processorName?: string;
  workerGroup: string;
  repoName: string;
  repoPath: string;
  templateOutputPath: string;
  conductorDir: string;
  loopStagingDir?: string;
  loopConductorDir?: string;
  loopSetupRan?: boolean;
  loopConfigured?: boolean;
  /** Deprecated alias for {@link loopSetupRan}. */
  processorSetupRan?: boolean;
  /** Deprecated alias for {@link loopConfigured}. */
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
  /**
   * Outcome of registering this profile with Herald + ensuring the shared
   * `march-legate` compose service. Replaces the old per-profile container launch.
   */
  legateService?: {
    /** True when the profile was registered with Herald's registry. */
    readonly registered: boolean;
    /** True when `docker compose up -d` for the legate service ran. */
    readonly serviceEnsured: boolean;
  };
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

function deriveLoopName(conductorName: string): string {
  const raw = conductorName.endsWith("-legate-agent")
    ? `${conductorName.slice(0, -"legate-agent".length)}legate-loop`
    : `${conductorName}-loop`;
  if (raw.length <= CONDUCTOR_NAME_MAX_LEN) return raw;

  const suffix = createHash("sha256").update(conductorName).digest("hex").slice(0, 8);
  const headLength = CONDUCTOR_NAME_MAX_LEN - suffix.length - 1;
  return `${raw.slice(0, headLength)}-${suffix}`;
}

function roleConductorName(profile: string, roleName: string): string {
  if (roleName === "legate-agent" || roleName === "legate-loop") {
    return `${profile}-${roleName}`;
  }
  return roleName;
}

export function deriveDefaults(repoPath: string): {
  profile: string;
  conductorName: string;
  loopName: string;
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
  const conductorName = `${slug}-legate-agent`;
  const loopName = deriveLoopName(conductorName);
  return {
    profile: slug,
    // Conductor names are unique system-wide in agent-deck — encode the repo
    // slug so multiple repos can each have their own legate without collision.
    conductorName,
    loopName,
    processorName: loopName,
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

function loopMetaFor(input: {
  profile: string;
  conductorName: string;
  loopName: string;
  repoName: string;
  repoPath: string;
  workerGroup: string;
  loopConductorDir: string;
  legateConductorDir: string;
}): Record<string, unknown> {
  return {
    schema_version: 1,
    profile: input.profile,
    paired_legate: input.conductorName,
    loop_name: input.loopName,
    processor_name: input.loopName,
    repo: {
      name: input.repoName,
      path: input.repoPath,
    },
    march_cli_path: process.argv[1] ? path.resolve(process.argv[1]) : null,
    worker_group: input.workerGroup,
    legate_state_path: path.join(input.legateConductorDir, "state.json"),
    loop_log_path: path.join(input.loopConductorDir, "legate-loop.log"),
    loop_events_path: path.join(input.loopConductorDir, "legate-loop.ndjson"),
    loop_requests_path: path.join(
      input.loopConductorDir,
      "legate-loop-requests.ndjson",
    ),
    loop_heartbeat_log_path: path.join(
      input.loopConductorDir,
      "legate-loop-heartbeat.log",
    ),
    loop_heartbeat_events_path: path.join(
      input.loopConductorDir,
      "legate-loop-heartbeat.ndjson",
    ),
    processor_log_path: path.join(input.loopConductorDir, "legate-loop.log"),
    processor_events_path: path.join(input.loopConductorDir, "legate-loop.ndjson"),
    processor_requests_path: path.join(
      input.loopConductorDir,
      "legate-loop-requests.ndjson",
    ),
    legate_conductor_dir: input.legateConductorDir,
    // Telemetry config captured at init time from the operator's env, so the
    // loop service container emits without needing env propagation.
    otel: {
      enabled: process.env.MARCH_OTEL === "1",
      endpoint: (
        process.env.MARCH_OTEL_ENDPOINT ||
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
        "http://localhost:4318"
      ).replace(/\/+$/, ""),
    },
    // Brood service endpoint, frozen at init so the loop service can REQUEST
    // teardown (#155) instead of pruning worktrees itself. Null = brood not
    // configured; the loop then removes only the agent-deck session (no prune).
    brood_endpoint: process.env.MARCH_BROOD_URL?.trim() || null,
    // Herald service endpoint, frozen at init so the containerized loop can
    // CONSUME the event inbox + write transition events (#175) without env
    // propagation. Null = herald not configured; the loop keeps its legacy
    // self-poll sense path (byte-for-byte unchanged).
    herald_endpoint: process.env.MARCH_HERALD_URL?.trim() || null,
    mode: "terminal-pr-maintenance",
  };
}

// The loop runs as the `march legate loop` service inside its own
// Hatchery-managed container; the container reads only the meta sidecar. The
// legacy `legate-loop.mjs` (run via raw node in an agent-deck session) is gone
// (Balexda/March#146), so init stages just `legate-loop-meta.json`.
async function writeLoopMeta(input: {
  stagingDir: string;
  meta: Record<string, unknown>;
}): Promise<{ stagedMetaPath: string }> {
  await fs.mkdir(input.stagingDir, { recursive: true });
  const stagedMetaPath = path.join(input.stagingDir, "legate-loop-meta.json");
  await fs.writeFile(stagedMetaPath, JSON.stringify(input.meta, null, 2) + "\n");
  return { stagedMetaPath };
}

async function copyLoopMetaIntoConductor(
  loopStagingDir: string,
  loopConductorDir: string,
): Promise<void> {
  await fs.mkdir(loopConductorDir, { recursive: true });
  await fs.copyFile(
    path.join(loopStagingDir, "legate-loop-meta.json"),
    path.join(loopConductorDir, "legate-loop-meta.json"),
  );
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
 * layer for direct `agent-deck session show / list / status` reads. Allowing
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
        ...MARCH_CLI_ALLOWS,
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
 * `agent-deck session restart` succeeds. This is the *only* opportunity
 * the model has to emit a first-turn alignment statement before loop
 * doorbells or operator messages begin: without it, the auto-mode
 * classifier evaluates `Skill(legate.*)` + skill-script bashes against
 * an essentially empty recent context.
 *
 * The prompt introduces the legate persona and goals at high level —
 * just enough for auto-mode to gauge alignment — and explicitly defers
 * to CLAUDE.md and the per-skill `SKILL.md` files for the strict
 * mechanics. Keep this short and persona-shaped; do not duplicate the
 * full loop escalation decision tree, the state.json schema, or the boundary
 * rules. Those live in CLAUDE.prompt and the skill prompts; drift
 * between this prompt and CLAUDE.md is a maintenance hazard.
 *
 * Placeholders (single-curly, replaced via `.replaceAll`):
 *   {REPO_NAME}, {REPO_PATH}, {PROFILE}, {WORKER_GROUP}
 */
const LEGATE_COLD_START_PROMPT_TEMPLATE = `Cold start as the Legate for {REPO_NAME} ({REPO_PATH}, agent-deck profile {PROFILE}). You are a Claude Code session in --permission-mode auto whose job is to keep the Smithy plan→PR→fix loop running on this one repo without operator intervention. Your CLAUDE.md is the authoritative spec for behavior — read it; this message just primes alignment.

Persona and goals:
- You orchestrate Smithy work for {REPO_NAME} only. You do not touch other repos or other profiles.
- You watch worker Claude sessions (group: {WORKER_GROUP}), track the GitHub PRs they open, and dispatch fixes when CI fails or reviewers leave inline comments. Workers do all implementation; you never edit the repo directly.
- Optimize for forward progress with minimal operator escalation: drain merged PRs and unblock waiting workers. The deterministic loop dispatches the next ready Smithy slice through Hatchery. Ask for help (NEED:) only when the situation is genuinely outside your loop.
- One /smithy.<verb> dispatch = one PR. You never auto-merge.

What you operate on:
- agent-deck conductor — parent/child links and operator/loop messages.
- smithy CLI + skills — source of truth for what work to pick next.
- gh CLI — source of truth for high-level PR state.
- The smithy.pr-review skill — source of truth for unresolved inline review threads.

Six skills carry the Claude-side mechanics. Load each once on this turn so the auto-mode classifier registers their allowed-tools:
- legate.resume — worker session-restart recovery and Resume-from-summary picker clearing.
- legate.error — opaque worker error recovery via inspection, login escalation, restart, or diagnostic prompt.
- legate.babysit — PR judgement escalations from the deterministic loop (CI classification, repeated conflicts, send failures).
- legate.merge — strict-gate auto-squash-merge.
- legate.issue — operator-driven GitHub issue intake.
- legate.unwedge — hatchery branch-collision + partial-work recovery (loop auto-recovers the safe cases; this skill handles open-PR / diverged-unknown / partial-work).

Auto-mode alignment — your routine actions are exactly:
(a) Skill() to load one of the six skills above;
(b) bash invocation of a script under .claude/skills/legate.*/scripts/;
(c) Read of state.json, task-log.md, LEARNINGS.md, POLICY.md, CLAUDE.md, meta.json, legate-loop logs/requests, or */SKILL.md inside this conductor dir;
(d) a [STATUS] or NEED: reply to a loop escalation or operator message.

The deterministic legate-loop owns routine writes to state.json and task-log.md. Do not edit those files for heartbeat-style bookkeeping, PR refresh, all-clear transitions, cleanup, or dispatch. If a judgement action changes the world by messaging a worker or rerunning CI, let the loop observe and record the resulting state on its next tick unless a skill explicitly says otherwise.

Anything else escalates via NEED: rather than executing — inline python3 -c / bash -c / node -e, scripts outside legate.*, writes outside cwd, direct network primitives, destructive git (reset --hard, push --force, clean -fd), work against another repo or profile, or agent-deck session send to a running worker.

On this turn:
1. Read CLAUDE.md end-to-end.
2. Run its cold-start checklist (read state.json if present; load legate.resume, legate.error, legate.babysit, legate.merge, legate.issue, and legate.unwedge once via the Skill tool). Do not edit state.json or task-log.md on cold start.
3. Reply with the cold-start acknowledgement: "Online for {REPO_NAME} ({PROFILE}). Skills available: legate.resume, legate.error, legate.babysit, legate.merge, legate.issue, legate.unwedge. Will not invoke anything outside their scripts without escalating."
4. Wait for a [PROCESSOR] loop escalation or operator message. Do not poll on your own.`;

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
  const conductorName = opts.conductorName !== undefined
    ? roleConductorName(profile, opts.conductorName)
    : `${profile}-legate-agent`;
  const loopEnabled = opts.loop !== false && opts.processor !== false;
  const processorEnabled = loopEnabled;
  const shouldRunSetup = opts.runSetup ?? true;
  const runLegateSetup = shouldRunSetup;
  const runLoopSetup = shouldRunSetup && loopEnabled;
  const runProcessorSetup = runLoopSetup;
  const loopName = deriveLoopName(conductorName);
  const processorName = loopName;
  const workerGroup = opts.workerGroup ?? defaults.workerGroup;
  const model = opts.model ?? "opus";
  const effort = opts.effort ?? "medium";
  const heartbeatInterval = opts.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;
  const repoName = defaults.repoName;
  const description =
    opts.description ??
    `Legate orchestrator for ${repoName} (Smithy plan→PR→fix loop)`;

  // Validate before composing any filesystem path so caller-supplied values
  // like `../../.ssh` cannot escape the staging root, and so we surface a
  // march-side error instead of shelling out and parsing agent-deck's stderr.
  validateProfileName(profile);
  validateConductorName(conductorName);
  if (loopEnabled) validateConductorName(loopName);
  validateHeartbeatInterval(heartbeatInterval);

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
    LOOP_NAME: loopName,
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
    "-no-heartbeat",
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
    "--effort",
    effort,
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
  // message after `session restart`, before loop doorbells or operator
  // messages arrive. Without it, auto-mode's classifier judges the first
  // Skill() / script-bash calls against essentially empty recent context. See
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
  const loopStagingDir = path.join(stagingDir, "loop");
  const loopConductorDir = path.join(
    home,
    ".agent-deck",
    "conductor",
    loopName,
  );
  if (processorEnabled) {
    try {
      await writeLoopMeta({
        stagingDir: loopStagingDir,
        meta: loopMetaFor({
          profile,
          conductorName,
          loopName,
          repoName,
          repoPath,
          workerGroup,
          loopConductorDir,
          legateConductorDir: conductorDir,
        }),
      });
    } catch (err) {
      throw new LegateError(
        `Failed to stage deterministic loop files: ${(err as Error).message}`,
      );
    }
  }

  let setupRan = false;
  let processorSetupRan = false;
  let processorConfigured = false;
  let autoModeConfigured = false;
  let bridgeActive = false;
  let heartbeatOverrideWritten = false;
  let legateService: { registered: boolean; serviceEnsured: boolean } | undefined;
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
    // The Claude-backed legate-agent is reactive. The deterministic
    // legate-loop owns ticking, state mutation, cleanup, PR refresh, and
    // dispatch. The agent is launched with `-no-heartbeat` and only receives
    // cold-start alignment, explicit operator messages, or loop doorbells.
    try {
      await writeDisabledHeartbeatScript(conductorDir, conductorName);
    } catch (err) {
      postSetupWarnings.push(
        `Failed to neutralize legacy heartbeat.sh in ${conductorDir}: ` +
          `${(err as Error).message}\n` +
          `The legate-agent is configured with -no-heartbeat, but a stale ` +
          `heartbeat.sh may still be invoked by an old scheduler. Remove or ` +
          `replace ${path.join(conductorDir, "heartbeat.sh")} manually.`,
      );
    }
    if (isLinuxLike) {
      try {
        disableLegacyHeartbeatTimer(conductorName);
      } catch (err) {
        postSetupWarnings.push(
          `Failed to disable legacy heartbeat timer for ${conductorName}: ` +
            `${(err as Error).message}\n` +
            `The legate-agent is reactive; stop any stale scheduler manually:\n` +
            `  systemctl --user disable --now agent-deck-conductor-heartbeat-${conductorName}.timer`,
        );
      }
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

    // Deliver the cold-start priming prompt before loop doorbells or operator
    // messages arrive. Gated on autoModeConfigured so we know the conductor
    // was successfully restarted (and is therefore alive to receive).
    // Best-effort: a failure means the conductor will still run, but
    // its first tool use may happen without priming context, so the
    // auto-mode classifier may pause more often.
    if (autoModeConfigured) {
      try {
        execFileSync(sendColdStartCommand[0], sendColdStartCommand.slice(1), {
          stdio: "inherit",
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        postSetupWarnings.push(
          `Failed to deliver cold-start priming prompt to ${conductorTitle} (exit ${status ?? "?"}). ` +
            `The conductor will still run, but its first action may happen without ` +
            `priming context — auto-mode classifier may pause more often. ` +
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
          `Bridge daemon did not stay active after start. The agent will not ` +
            `receive bridge-delivered operator or loop messages and will only act when nudged manually ` +
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
          `Without the bridge running, the agent will not receive bridge-delivered messages.`,
      );
    }
  } else {
    // No Claude conductor setup ran; record skills as staged-but-not-deployed
    // so the result shape is consistent.
    deploymentResults = LEGATE_SKILLS.map((name) => ({ name, deployed: false }));
  }

  if (runProcessorSetup) {
    // The legate is now a SINGLE profile-agnostic compose service (`march legate
    // serve`) that drives every registered profile — not a per-profile container.
    // So setup (a) registers this profile with Herald's registry (the source of
    // truth the running service reads each tick) and (b) ensures the shared
    // `march-legate` service is up. The staged meta is kept only as a back-compat
    // sidecar / Herald seed; it is no longer the loop's runtime contract.
    try {
      await copyLoopMetaIntoConductor(loopStagingDir, loopConductorDir);
      processorSetupRan = true;
    } catch (err) {
      postSetupWarnings.push(
        `Failed to stage deterministic loop meta into ${loopConductorDir}: ` +
          `${(err as Error).message}`,
      );
    }
    if (processorSetupRan) {
      const reg = await registerProfile(
        {
          profile,
          repoName,
          repoPath,
          workerGroup,
          conductorName,
          marchCliPath: process.argv[1] ? path.resolve(process.argv[1]) : null,
          mode: "terminal-pr-maintenance",
        },
        { env: process.env },
      );
      if (!reg.record) postSetupWarnings.push(reg.note);
      const svc = ensureLegateService();
      if (!svc.ran) postSetupWarnings.push(svc.note);
      legateService = { registered: reg.record != null, serviceEnsured: svc.ran };
      // "Configured" once the profile is known to the registry (the service can
      // be brought up separately via the standup recipe).
      processorConfigured = reg.record != null;
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
    : `${LEGATE_SKILLS.join(", ")} staged at ${skillsStagedDir} (copied into conductor on setup)`;
  const loopLine = processorEnabled
    ? processorConfigured
      ? `profile "${profile}" registered with Herald; driven by the shared march-legate service`
      : runProcessorSetup
        ? `${loopName} staged/registration incomplete — see warnings`
        : `${loopName} (registration deferred — run setup first)`
    : "disabled (--no-loop)";
  const legateStatus = setupRan ? "configured" : "rendered";

  const baseLines = [
    `Legate (${conductorName}) ${legateStatus} for ${repoName}.`,
    `  Profile:        ${profile}`,
    `  Agent:          ${conductorName}`,
    `  Loop:           ${loopLine}`,
    `  Worker group:   ${workerGroup}`,
    `  Repo:           ${repoPath}`,
    `  Template:       ${templateOutputPath}`,
    `  Agent dir:      ${conductorDir}`,
    `  Loop dir:       ${
      processorEnabled ? loopConductorDir : "disabled"
    }`,
    `  Auto mode:      ${
      setupRan
        ? autoModeConfigured
          ? "enabled (auto-mode field set on conductor session)"
          : "NOT configured — see warnings"
        : "deferred (run setup first)"
    }`,
    `  Model:          ${model} (effort: ${effort})${
      setupRan ? "" : " (deferred — run setup first)"
    }`,
    `  Bridge daemon:  ${
      setupRan
        ? bridgeActive
          ? "active (operator messages can reach the agent)"
          : "NOT active — agent will only respond to direct session-send messages; see warnings"
        : "deferred (run setup first)"
    }`,
    `  Heartbeat:      ${
      setupRan
        ? "disabled for legate-agent; the march-legate service owns ticks"
        : "disabled for legate-agent (deferred — run setup first)"
    }`,
    `  Service:        ${
      legateService
        ? `${legateService.registered ? "profile registered" : "registration FAILED — see warnings"}; ` +
          `${legateService.serviceEnsured ? "march-legate service ensured" : "service not ensured — see warnings"}`
        : "not configured"
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
        "Then enable auto mode, pin model, restart, and deliver the",
        "cold-start priming prompt (staged below):",
        `  ${formatShellCommand(setAutoModeCommand)}`,
        `  ${formatShellCommand(setModelCommand)}`,
        `  ${formatShellCommand(restartCommand)}`,
        `  ${sendColdStartManualHint}`,
        ...(processorEnabled
          ? [
              "",
              `The deterministic loop meta is staged at ${loopStagingDir}.`,
              "Re-running setup launches the loop service container.",
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
    ...(processorEnabled ? { loopName, processorName } : {}),
    workerGroup,
    repoName,
    repoPath,
    templateOutputPath,
    conductorDir,
    ...(processorEnabled
      ? {
          loopStagingDir,
          loopConductorDir,
          loopSetupRan: processorSetupRan,
          loopConfigured: processorConfigured,
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
    ...(legateService ? { legateService } : {}),
    summary: summaryLines.join("\n"),
  };
}
