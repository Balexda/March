import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createInterface } from "node:readline";
import { Command, CommanderError } from "commander";
import { ERROR, SUCCESS, USAGE_ERROR } from "../shared/exit-codes.js";
import {
  checkSpawnDependencies,
  isFinderAvailable,
  isOnPath,
} from "../shared/deps.js";
import {
  copyOtelEmitterToContainer,
  copyPromptToContainer,
  createSpawnContainer,
  launchSpawnContainer,
  LaunchError,
  readSpawnContainerLogs,
  removeSpawnContainer,
  startSpawnContainer,
  waitForSpawnContainer,
} from "../spawn/container-launch.js";
import {
  checkBridgeRequirements,
  initLegate,
  LegateError,
} from "../legate/init.js";
import { DEFAULT_MANAGER_GROUP } from "../hatchery/spawn-handoff.js";
import { DEFAULT_LOOP_PORT, runLoop } from "../legate/loop/index.js";
import {
  HatcheryClientError,
  runSpawnViaService,
} from "../hatchery/service/client.js";
import { runCastraServer } from "../castra/serve.js";
import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import { CastraValidationError } from "../castra/types.js";
import { initMarch, InitError } from "../bootstrap/init.js";
import { createBuildContext, SnapshotError } from "../spawn/snapshot.js";
import {
  listBackends,
  getBackend,
  missingCredentialMounts,
  missingRequiredEnvVars,
  resolveBackendSelection,
  type BackendSelectionSource,
} from "../spawn/backends.js";
import {
  buildSpawnImage,
  BuildError,
  removeSpawnImage,
  writeSpawnDockerfile,
} from "../spawn/snapshot-build.js";
import {
  markSpawnRecordFailed,
  markSpawnRecordRunning,
  markSpawnRecordStopped,
  removeSpawnRecord,
  SpawnRecordError,
  spawnOutputPath,
  updateSpawnRecordImageId,
  updateSpawnRecordPrompt,
  writeInitialSpawnRecord,
} from "../brood/spawn-record.js";
import { updateMarch, UpdateError } from "../bootstrap/update.js";
import { CLI_VERSION } from "../shared/version.js";
import { startDispatchSpan } from "../observability/spawn-trace.js";
import { recordSpawnRun } from "../observability/spawn-metrics.js";
import { buildSpawnOtelContext } from "../observability/in-spawn-emitter.js";
import { initOtel } from "../observability/otel.js";
import {
  createSpawnWorktree,
  removeSpawnWorktree,
  SpawnWorktree,
  WorktreeError,
} from "../brood/worktree.js";

/**
 * Prompts the user for a yes/no confirmation on the given question.
 * Returns true if the user confirms (answers 'y' or 'yes'), false otherwise.
 */
function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

const program = new Command();

program
  .name("march")
  .version(CLI_VERSION)
  .option("--yes", "Skip confirmation prompts")
  .exitOverride()
  .addHelpCommand(false)
  .configureOutput({
    // Suppress Commander's own error output (e.g. "error: unknown command
    // 'foo'") because the !commandHandled fallthrough block handles
    // unrecognised-command messaging explicitly via process.stderr.write.
    writeErr: () => {},
  });

// Tracks whether a registered command handled the invocation. Required because
// process.exitCode (unlike process.exit()) does not terminate immediately, so
// the usage-output fallthrough block must be gated explicitly.
let commandHandled = false;

function backendSourceLabel(source: BackendSelectionSource): string {
  if (source === "flag") return "--backend flag";
  if (source === "env") return "MARCH_BACKEND env var";
  return "default backend";
}

function resolveHatcheryBackendSelection(input: {
  readonly flagValue?: string;
  readonly envValue?: string;
}): {
  readonly requestedName: string;
  readonly source: BackendSelectionSource;
  readonly backend?: ReturnType<typeof getBackend>;
} {
  const flagValue = input.flagValue?.trim();
  if (flagValue) {
    return { requestedName: flagValue, source: "flag", backend: getBackend(flagValue) };
  }

  const envValue = input.envValue?.trim();
  if (envValue) {
    return { requestedName: envValue, source: "env", backend: getBackend(envValue) };
  }

  return {
    requestedName: "codex",
    source: "default",
    backend: getBackend("codex"),
  };
}

program
  .command("init")
  .description("Initialize the March environment")
  .action(async () => {
    commandHandled = true;
    try {
      const { summary, warnings } = await initMarch();
      console.log(summary);
      for (const warning of warnings) {
        process.stderr.write(warning + "\n");
      }
      // Set exitCode rather than calling process.exit() so buffered stdout/
      // stderr is fully flushed before the process terminates naturally.
      process.exitCode = SUCCESS;
    } catch (err) {
      if (err instanceof InitError) {
        console.error(err.message);
        process.exitCode = ERROR;
        return;
      }
      throw err;
    }
  });

program
  .command("update")
  .description("Update the March installation")
  .action(async () => {
    commandHandled = true;
    const yes = program.opts().yes as boolean | undefined;
    try {
      // When --yes is set, pass force=true on the first call so a downgrade
      // proceeds immediately without a detection roundtrip that would print
      // the "Pass --yes" warning before the update runs.
      const result = await updateMarch(undefined, yes ? true : undefined);

      if (result.downgrade) {
        // Downgrade detected and --yes was not set (force bypasses this branch).
        console.log(result.summary);
        for (const warning of result.warnings) {
          process.stderr.write(warning + "\n");
        }

        if (!process.stdin.isTTY) {
          // Non-interactive environment: instruct the user and exit 0 without
          // performing the downgrade.
          process.stderr.write(
            "Pass --yes to force the downgrade in non-interactive mode.\n",
          );
          process.exitCode = SUCCESS;
          return;
        }

        // Interactive TTY: ask for confirmation.
        const confirmed = await confirm(
          `Downgrade from v${result.summary.match(/v(\S+)/)?.[1] ?? "?"} to v${CLI_VERSION}?`,
        );
        if (!confirmed) {
          process.stderr.write("Downgrade cancelled.\n");
          process.exitCode = SUCCESS;
          return;
        }

        const forced = await updateMarch(undefined, true);
        console.log(forced.summary);
        for (const warning of forced.warnings) {
          process.stderr.write(warning + "\n");
        }
        process.exitCode = SUCCESS;
        return;
      }

      console.log(result.summary);
      for (const warning of result.warnings) {
        process.stderr.write(warning + "\n");
      }
      process.exitCode = SUCCESS;
    } catch (err) {
      if (err instanceof UpdateError) {
        console.error(err.message);
        process.exitCode = ERROR;
        return;
      }
      throw err;
    }
  });

program
  .command("version")
  .description("Display the installed CLI version")
  .action(() => {
    commandHandled = true;
    console.log(CLI_VERSION);
    process.exitCode = SUCCESS;
  });

program
  .command("help [command]")
  .description("Display help for a command")
  .action((cmd?: string) => {
    commandHandled = true;
    if (cmd) {
      const found = program.commands.find((c) => c.name() === cmd);
      if (!found) {
        process.stderr.write(`error: unknown command '${cmd}'\n`);
        program.outputHelp();
        process.exitCode = USAGE_ERROR;
        return;
      }
      found.outputHelp();
      process.exitCode = SUCCESS;
    } else {
      program.outputHelp();
      process.exitCode = SUCCESS;
    }
  });

// Subcommand group with no own action. Commander then handles both
// `march legate` (no subcommand → emits help and throws `commander.help`)
// and `march legate <bad>` (→ throws `commander.unknownCommand` naming the
// actual unknown token, instead of `commander.excessArguments` blaming the
// parent group). Both are intercepted in the bottom-of-file catch so the
// user sees either help or a precise unknown-command message.
const legate = program
  .command("legate")
  .description("Manage Legate agents + the shared profile-agnostic Legate service");

legate
  .command("init")
  .description("Set up a Legate agent and register this repo's profile with the shared Legate service")
  .option("-p, --profile <profile>", "agent-deck profile (default: derived from repo basename)")
  .option("-n, --name <name>", "Legate agent conductor name (default: <repo-slug>-legate-agent)")
  .option("-d, --description <description>", "Legate agent conductor description")
  .option("-g, --worker-group <group>", "Group for worker sessions (default: legate-workers)")
  .option(
    "-m, --model <model>",
    "Claude model alias or full ID for the Legate agent session (default: opus — auto-mode classifier requires opus; effort is set separately so we don't pay full reasoning cost for orchestration).",
  )
  .option(
    "--effort <level>",
    "Claude Code --effort level for the conductor session: low | medium | high | xhigh | max (default: medium — orchestration is reasoning-light; high effort is reserved for the worker sessions doing real implementation).",
  )
  .option(
    "-i, --heartbeat-interval <interval>",
    "Cadence at which the conductor's systemd heartbeat timer fires. Accepts a subset of systemd time-span syntax: positive integer + single suffix (ns, us, ms, s, m, min, h, hr, d, w, y) — e.g. 5min, 10min, 300s, 1h, 500ms, 1w. Composite forms (1h 30min) are not supported. Default: 5min — agent-deck's own default is 15min, which is too slow for the Smithy plan→PR→fix loop. Validated everywhere; the systemd drop-in is only written on Linux/WSL2 (other platforms surface a warning and the operator pins the cadence manually).",
  )
  .option("--no-setup", "Render the template only; skip `agent-deck conductor setup`")
  .option(
    "--no-processor",
    "Deprecated alias for --no-loop",
  )
  .option(
    "--no-loop",
    "Skip deploying the paired deterministic Legate loop service container",
  )
  .option(
    "--no-bridge-check",
    "Skip the Python 3.9+ pre-flight check for the agent-deck conductor bridge daemon. Use only when you intend to drive the conductor manually with `agent-deck session send`.",
  )
  .action(async (opts: {
    profile?: string;
    name?: string;
    description?: string;
    workerGroup?: string;
    model?: string;
    effort?: string;
    heartbeatInterval?: string;
    setup?: boolean; // commander negates --no-setup into setup=false
    processor?: boolean; // commander negates --no-processor into processor=false
    loop?: boolean; // commander negates --no-loop into loop=false
    bridgeCheck?: boolean; // commander negates --no-bridge-check into bridgeCheck=false
  }) => {
    commandHandled = true;

    const loopDisabled = opts.loop === false || opts.processor === false;

    // 1. Detect repo root. Legate is per-repo, so this is mandatory. Three
    //    distinct failures need distinct messages — pointing the user at
    //    "run from inside a git repo" when `git` itself isn't installed
    //    sends them in the wrong direction.
    if (!isFinderAvailable()) {
      process.stderr.write(
        "Cannot verify git is installed: path-search utility unavailable.\n",
      );
      process.exitCode = ERROR;
      return;
    }
    if (!isOnPath("git")) {
      process.stderr.write(
        "git not found on PATH — required to detect the repository root.\n",
      );
      process.exitCode = ERROR;
      return;
    }
    let repoRoot: string;
    try {
      repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (err) {
      const stderr = ((err as { stderr?: Buffer | string }).stderr ?? "")
        .toString()
        .trim();
      if (stderr.includes("not a git repository")) {
        process.stderr.write(
          "Run `march legate init` from inside a git repository.\n",
        );
      } else {
        process.stderr.write(
          `Failed to detect the repository root: ${stderr || (err as Error).message}\n`,
        );
      }
      process.exitCode = ERROR;
      return;
    }

    // 2. Verify agent-deck is on PATH when we'll actually invoke it.
    const willRunSetup = opts.setup !== false;
    // The deterministic loop runs as a Hatchery-managed container — the only
    // loop runtime — so Docker is required whenever setup will launch it.
    const willLaunchLoopContainer = willRunSetup && !loopDisabled;
    if (willLaunchLoopContainer) {
      if (!isFinderAvailable()) {
        process.stderr.write(
          "Cannot verify Docker is installed: path-search utility unavailable.\n",
        );
        process.exitCode = ERROR;
        return;
      }
      if (!isOnPath("docker")) {
        process.stderr.write(
          "Docker not found on PATH — required to launch the Legate loop service container (pass --no-loop or --no-setup to skip).\n",
        );
        process.exitCode = ERROR;
        return;
      }
    }
    if (willRunSetup) {
      if (!isFinderAvailable()) {
        process.stderr.write(
          "Cannot verify agent-deck is installed: path-search utility unavailable.\n",
        );
        process.exitCode = ERROR;
        return;
      }
      if (!isOnPath("agent-deck")) {
        process.stderr.write(
          "agent-deck not found on PATH — install it from https://github.com/asheshgoplani/agent-deck or pass --no-setup to render the template only.\n",
        );
        process.exitCode = ERROR;
        return;
      }

      // 3. Bridge pre-flight: confirm python3 is recent enough to actually
      //    run agent-deck's conductor bridge daemon. The bridge is what
      //    delivers heartbeats; without it, the conductor is functional
      //    but inert. Failing here is preferable to deploying a conductor
      //    that silently never wakes up. Skipped under --no-bridge-check.
      if (opts.bridgeCheck !== false) {
        const check = checkBridgeRequirements();
        if (!check.ok) {
          process.stderr.write(check.message + "\n");
          process.exitCode = ERROR;
          return;
        }
      }
    }

    // 4. Render template + (optionally) run agent-deck conductor setup.
    try {
      const result = await initLegate({
        repoPath: repoRoot,
        profile: opts.profile,
        conductorName: opts.name,
        description: opts.description,
        workerGroup: opts.workerGroup,
        model: opts.model,
        effort: opts.effort,
        heartbeatInterval: opts.heartbeatInterval,
        runSetup: willRunSetup,
        loop: !loopDisabled,
        processor: !loopDisabled,
      });
      console.log(result.summary);
      process.exitCode = SUCCESS;
    } catch (err) {
      if (err instanceof LegateError) {
        console.error(err.message);
        process.exitCode = ERROR;
        return;
      }
      throw err;
    }
  });

legate
  .command("serve")
  .alias("loop") // back-compat: `march legate loop` (the pre-rename name / baked image startup)
  .description(
    "Run the profile-agnostic Legate as a long-running service driving every registered profile (used inside the managed container)",
  )
  .option(
    "--port <port>",
    `HTTP API port, bound to loopback (default: $MARCH_LEGATE_PORT or ${DEFAULT_LOOP_PORT})`,
  )
  .action(async (opts: { port?: string }) => {
    commandHandled = true;
    const port = opts.port ? Number(opts.port) : undefined;
    if (opts.port !== undefined && (!Number.isFinite(port) || (port as number) <= 0)) {
      console.error(`Invalid --port "${opts.port}": expected a positive integer.\n`);
      process.exitCode = ERROR;
      return;
    }
    try {
      await runLoop({ port });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = ERROR;
    }
  });

legate
  .command("recover <sliceId>")
  .description(
    "Recover an escalated slice: append a recovery request so the running legate drops it and re-dispatches the still-ready smithy work fresh (no restart, no manual state surgery). Resolves Herald via MARCH_HERALD_URL.",
  )
  .option(
    "--profile <profile>",
    "Profile the slice belongs to (sliceIds are only unique within a profile). Defaults to the single-profile deployment when omitted.",
  )
  .action(async (sliceId: string, opts: { profile?: string }) => {
    commandHandled = true;
    const id = (sliceId ?? "").trim();
    if (id.length === 0) {
      process.stderr.write("Provide a non-empty <sliceId> to recover.\n");
      process.exitCode = ERROR;
      return;
    }
    const { HeraldClient, HeraldClientError } = await import("../herald/service/client.js");
    try {
      const profile = opts.profile?.trim();
      const event = await new HeraldClient().append({
        type: "slice.recovery.requested",
        sliceId: id,
        ...(profile ? { profile } : {}),
      });
      console.log(
        `Requested recovery of ${id}${profile ? ` (profile=${profile})` : ""} (seq=${event.seq}). ` +
          `The legate will drop the escalated slice and re-dispatch it on its next tick.`,
      );
      process.exitCode = SUCCESS;
    } catch (err) {
      const message = err instanceof HeraldClientError ? err.message : (err as Error).message;
      process.stderr.write(message + "\n");
      process.exitCode = ERROR;
    }
  });

// Profile registry — Herald is the source of truth for which profiles the single
// march-legate service drives. `march legate init` registers automatically; these
// verbs manage profiles directly (and are the clean seam for a future profile service).
const profile = program
  .command("profile")
  .description("Manage the profiles the shared Legate service drives (registered in Herald)");

profile
  .command("list")
  .description("List the profiles registered with Herald. Resolves Herald via MARCH_HERALD_URL.")
  .option("--all", "Include soft-removed profiles")
  .action(async (opts: { all?: boolean }) => {
    commandHandled = true;
    const { ProfileClient } = await import("../herald/profiles/client.js");
    const { HeraldClientError } = await import("../herald/service/client.js");
    try {
      const profiles = await new ProfileClient().list({ includeRemoved: Boolean(opts.all) });
      if (profiles.length === 0) {
        console.log("No profiles registered.");
      } else {
        for (const p of profiles) {
          console.log(`${p.profile}\t${p.status}\t${p.repoPath}\t(${p.workerGroup})`);
        }
      }
      process.exitCode = SUCCESS;
    } catch (err) {
      process.stderr.write(
        (err instanceof HeraldClientError ? err.message : (err as Error).message) + "\n",
      );
      process.exitCode = ERROR;
    }
  });

profile
  .command("register")
  .description("Register/upsert a profile with Herald. Resolves Herald via MARCH_HERALD_URL.")
  .requiredOption("-p, --profile <profile>", "Profile name")
  .requiredOption("--repo-path <path>", "Absolute path to the repo checkout")
  .option("--repo-name <name>", "Repo name (default: basename of --repo-path)")
  .option("-g, --worker-group <group>", "Worker session group", "legate-workers")
  .option("-n, --conductor <name>", "Paired legate-agent conductor name")
  .action(async (opts: {
    profile: string;
    repoPath: string;
    repoName?: string;
    workerGroup: string;
    conductor?: string;
  }) => {
    commandHandled = true;
    const { registerProfile } = await import("../legate/profile-register.js");
    const pathMod = await import("node:path");
    const result = await registerProfile({
      profile: opts.profile.trim(),
      repoPath: opts.repoPath,
      repoName: opts.repoName ?? pathMod.basename(opts.repoPath),
      workerGroup: opts.workerGroup,
      conductorName: opts.conductor,
    });
    if (result.record) {
      console.log(result.note);
      process.exitCode = SUCCESS;
    } else {
      process.stderr.write(result.note + "\n");
      process.exitCode = ERROR;
    }
  });

profile
  .command("remove <profile>")
  .description("Soft-remove a profile (the service stops driving it next tick). Resolves Herald via MARCH_HERALD_URL.")
  .action(async (profileName: string) => {
    commandHandled = true;
    const { ProfileClient } = await import("../herald/profiles/client.js");
    const { HeraldClientError, HeraldNotFoundError } = await import("../herald/service/client.js");
    try {
      const record = await new ProfileClient().remove(profileName.trim());
      console.log(`Removed profile "${record.profile}" (status=${record.status}).`);
      process.exitCode = SUCCESS;
    } catch (err) {
      if (err instanceof HeraldNotFoundError) {
        process.stderr.write(`Unknown profile "${profileName}".\n`);
      } else {
        process.stderr.write(
          (err instanceof HeraldClientError ? err.message : (err as Error).message) + "\n",
        );
      }
      process.exitCode = ERROR;
    }
  });

const hatchery = program
  .command("hatchery")
  .description("Manage Hatchery container/profile workflows");

hatchery
  .command("spawn")
  .description("Run a one-shot spawn and hand its patch to an agent-deck manager")
  .option(
    "--backend <name>",
    `Backend for spawn execution (${listBackends().join(", ")}; default: codex)`,
  )
  .option("--prompt <prompt>", "Task prompt for the spawn; Hatchery injects patch-output instructions")
  .option(
    "--agent-deck-profile <profile>",
    "agent-deck profile for the manager session",
  )
  .option(
    "--profile <profile>",
    "deployment profile for telemetry tagging (set at `march legate init`); defaults to unknown",
  )
  .option(
    "--manager-group <group>",
    `agent-deck group for manager sessions (default: ${DEFAULT_MANAGER_GROUP})`,
  )
  .option("--name <name>", "agent-deck session name/title for the manager")
  .option("--title <title>", "Alias for --name")
  .option("--branch <branch>", "Branch/worktree name for the manager session")
  .option("--task-type <type>", "Task type (smithy verb) for telemetry tagging")
  .option("--task-name <name>", "Task name (work-item slug) for telemetry tagging")
  .option("--slice-id <id>", "Dispatch slice id; hashed into the telemetry trace id")
  .option("--json", "Print the Hatchery spawn result as JSON")
  .action(async (opts: {
    backend?: string;
    prompt?: string;
    agentDeckProfile?: string;
    profile?: string;
    managerGroup?: string;
    name?: string;
    title?: string;
    branch?: string;
    taskType?: string;
    taskName?: string;
    sliceId?: string;
    json?: boolean;
  }) => {
    commandHandled = true;

    // Thin client: validate the cheap, caller-side things here for fast usage
    // errors, then hand the work to the hatchery service. The agent-deck/docker
    // prechecks moved server-side (see GET /readyz). Only the repo root is
    // resolved here because only the caller knows its working repo; the same
    // path must be valid inside the service container (identical bind mount).
    const backendSelection = resolveHatcheryBackendSelection({
      flagValue: opts.backend,
      envValue: process.env.MARCH_BACKEND,
    });
    const selectedBackend = backendSelection.backend;
    if (!selectedBackend) {
      process.stderr.write(
        `Unknown backend "${backendSelection.requestedName}" from ${backendSourceLabel(backendSelection.source)}. Supported backends: ${listBackends().join(", ")}\n`,
      );
      process.exitCode = USAGE_ERROR;
      return;
    }

    const prompt = opts.prompt;
    if (!prompt || prompt.length === 0) {
      process.stderr.write(
        "march hatchery spawn requires --prompt <prompt>.\n",
      );
      process.exitCode = USAGE_ERROR;
      return;
    }

    let repoRoot: string;
    try {
      repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
      }).trim();
    } catch (err) {
      process.stderr.write(
        `Failed to detect repo root: ${(err as Error).message}\n`,
      );
      process.exitCode = ERROR;
      return;
    }

    try {
      const job = await runSpawnViaService({
        repoPath: repoRoot,
        prompt,
        backend: selectedBackend.name,
        agentDeckProfile: opts.agentDeckProfile,
        profile: opts.profile,
        managerGroup: opts.managerGroup,
        title: opts.name ?? opts.title,
        branch: opts.branch,
        taskType: opts.taskType,
        taskName: opts.taskName,
        sliceId: opts.sliceId,
      });
      if (job.status === "succeeded" && job.result) {
        // stdout carries ONLY the result (the legate loop JSON.parses it).
        if (opts.json) {
          console.log(JSON.stringify(job.result, null, 2));
        } else {
          console.log(job.result.summary);
        }
        process.exitCode = SUCCESS;
      } else {
        process.stderr.write((job.error?.message ?? "Spawn job failed.") + "\n");
        process.exitCode = ERROR;
      }
    } catch (err) {
      const message =
        err instanceof HatcheryClientError ? err.message : (err as Error).message;
      process.stderr.write(message + "\n");
      process.exitCode = ERROR;
    }
  });

hatchery
  .command("serve")
  .description("Run the Hatchery service (HTTP API). Container entrypoint.")
  .option(
    "--port <port>",
    "Port to listen on (default: MARCH_HATCHERY_PORT or 8080)",
  )
  .option("--host <host>", "Bind host (default 0.0.0.0)")
  .action(async (opts: { port?: string; host?: string }) => {
    commandHandled = true;
    const { startServer } = await import("../hatchery/service/server.js");
    const port = opts.port ? Number(opts.port) : undefined;
    // Resolves only when the service shuts down (SIGTERM/SIGINT).
    await startServer({ port, host: opts.host });
    process.exitCode = SUCCESS;
  });

// Subcommand group with no own action — same pattern as `legate`/`hatchery`:
// bare `march castra` emits the group help and `march castra <bad>` reports the
// real unknown token. Both intercepted in the bottom-of-file catch.
const castra = program
  .command("castra")
  .description("Manage Castra — the interactive-sessions host fronting agent-deck over HTTP");

castra
  .command("serve")
  .description("Run the Castra HTTP service (binds loopback by default)")
  .option("--port <port>", "Port to listen on (default: deterministic 8800–9799)")
  .option("--host <host>", "Bind address (default: 127.0.0.1; the container binds 0.0.0.0)")
  .option("--token <token>", `Bearer token gating /v1/* (default: ${CASTRA_TOKEN_ENV} env var)`)
  .action(async (opts: { port?: string; host?: string; token?: string }) => {
    commandHandled = true;

    // Castra drives agent-deck directly, so it must be on PATH wherever serve runs.
    if (!isFinderAvailable()) {
      process.stderr.write(
        "Cannot verify agent-deck is installed: path-search utility unavailable.\n",
      );
      process.exitCode = ERROR;
      return;
    }
    if (!isOnPath("agent-deck")) {
      process.stderr.write(
        "agent-deck not found on PATH — required for `march castra serve`.\n",
      );
      process.exitCode = ERROR;
      return;
    }

    try {
      await runCastraServer({
        port: opts.port,
        host: opts.host,
        token: opts.token,
      });
      process.exitCode = SUCCESS;
    } catch (err) {
      if (err instanceof CastraValidationError) {
        process.stderr.write(err.message + "\n");
        process.exitCode = USAGE_ERROR;
        return;
      }
      throw err;
    }
  });

const brood = program
  .command("brood")
  .description("Manage Brood session lifecycle (state + teardown)");

brood
  .command("serve")
  .description("Run the Brood service (HTTP API). Container entrypoint.")
  .option(
    "--port <port>",
    "Port to listen on (default: MARCH_BROOD_PORT or the deterministic 8800–9799 port)",
  )
  .option("--host <host>", "Bind host (default 0.0.0.0)")
  .action(async (opts: { port?: string; host?: string }) => {
    commandHandled = true;
    const { startServer } = await import("../brood/service/server.js");
    const port = opts.port ? Number(opts.port) : undefined;
    // Resolves only when the service shuts down (SIGTERM/SIGINT).
    await startServer({ port, host: opts.host });
    process.exitCode = SUCCESS;
  });

brood
  .command("teardown <id>")
  .description(
    "Tear down a session (container, steward, worktree, branch) via Brood",
  )
  .option("--force", "Tear down even a running spawn")
  .option("--kill", "SIGKILL the container instead of graceful stop")
  .option("--reason <reason>", "Reason recorded on the torn-down session")
  .action(
    async (
      id: string,
      opts: { force?: boolean; kill?: boolean; reason?: string },
    ) => {
      commandHandled = true;
      const { BroodClient, BroodClientError, BroodNotFoundError } = await import(
        "../brood/service/client.js"
      );
      try {
        const result = await new BroodClient().teardown(id, {
          force: opts.force,
          kill: opts.kill,
          reason: opts.reason,
        });
        for (const step of result.steps) {
          console.log(
            `${step.step}: ${step.outcome}${step.detail ? ` (${step.detail})` : ""}`,
          );
        }
        for (const warning of result.warnings) {
          process.stderr.write(`warning: ${warning}\n`);
        }
        process.exitCode = SUCCESS;
      } catch (err) {
        if (err instanceof BroodNotFoundError) {
          // A 404 means Brood has no record of this session — NOT that cleanup
          // succeeded. Brood persists across restarts and returns a 200 no-op
          // for already-torndown sessions, so a 404 only happens when the
          // session was never registered (e.g. a missed registration during a
          // transient Brood outage). Exit non-zero so the caller (the legate
          // loop) defers and retries rather than archiving the slice over an
          // orphaned steward/container/worktree.
          process.stderr.write(
            `Session "${id}" is not tracked by Brood; cannot confirm teardown.\n`,
          );
          process.exitCode = ERROR;
          return;
        }
        const message =
          err instanceof BroodClientError
            ? err.message
            : (err as Error).message;
        process.stderr.write(message + "\n");
        process.exitCode = ERROR;
      }
    },
  );

brood
  .command("list")
  .description("List sessions Brood is tracking")
  .option("--kind <kind>", "Filter by kind: spawn | steward | legate")
  .option("--status <status>", "Filter by status")
  .option("--json", "Print the session list as JSON")
  .action(async (opts: { kind?: string; status?: string; json?: boolean }) => {
    commandHandled = true;
    const { BroodClient, BroodClientError } = await import(
      "../brood/service/client.js"
    );
    try {
      const sessions = await new BroodClient().list({
        kind: opts.kind as never,
        status: opts.status as never,
      });
      if (opts.json) {
        console.log(JSON.stringify(sessions, null, 2));
      } else if (sessions.length === 0) {
        console.log("No sessions tracked.");
      } else {
        for (const s of sessions) {
          console.log(
            `${s.id}\t${s.kind}\t${s.status}\t${s.branch ?? ""}\t${s.containerId ?? ""}`,
          );
        }
      }
      process.exitCode = SUCCESS;
    } catch (err) {
      const message =
        err instanceof BroodClientError ? err.message : (err as Error).message;
      process.stderr.write(message + "\n");
      process.exitCode = ERROR;
    }
  });

const herald = program
  .command("herald")
  .description("Manage Herald system-state observation (heartbeat + event log)");

herald
  .command("serve")
  .description("Run the Herald service (HTTP API + observe loop). Container entrypoint.")
  .option(
    "--port <port>",
    "Port to listen on (default: MARCH_HERALD_PORT or the deterministic 8800–9799 port)",
  )
  .option("--host <host>", "Bind host (default 0.0.0.0)")
  .option("--meta <path>", "Path to the meta JSON (else MARCH_HERALD_META / MARCH_LEGATE_LOOP_META)")
  .action(async (opts: { port?: string; host?: string; meta?: string }) => {
    commandHandled = true;
    const { startServer } = await import("../herald/service/server.js");
    const port = opts.port ? Number(opts.port) : undefined;
    // Resolves only when the service shuts down (SIGTERM/SIGINT).
    await startServer({ port, host: opts.host, metaPath: opts.meta });
    process.exitCode = SUCCESS;
  });

herald
  .command("events")
  .description("Print events Herald has recorded (the inbox the legate drains)")
  .option("--after <seq>", "Only events after this sequence number", "0")
  .option("--limit <n>", "Max events to print", "100")
  .option("--json", "Print events as JSON")
  .action(async (opts: { after?: string; limit?: string; json?: boolean }) => {
    commandHandled = true;
    const { HeraldClient, HeraldClientError } = await import("../herald/service/client.js");
    try {
      const page = await new HeraldClient().events({
        after: Number(opts.after ?? 0),
        limit: Number(opts.limit ?? 100),
      });
      if (opts.json) {
        console.log(JSON.stringify(page.events, null, 2));
      } else if (page.events.length === 0) {
        console.log("No events.");
      } else {
        for (const e of page.events) {
          console.log(`${e.seq}\t${e.ts}\t${e.source}\t${e.type}`);
        }
      }
      process.exitCode = SUCCESS;
    } catch (err) {
      const message = err instanceof HeraldClientError ? err.message : (err as Error).message;
      process.stderr.write(message + "\n");
      process.exitCode = ERROR;
    }
  });

herald
  .command("state")
  .description("Print Herald's current observed-state projection")
  .option("--at <seq>", "Project state as of this sequence number")
  .option("--json", "Print the projection as JSON")
  .action(async (opts: { at?: string; json?: boolean }) => {
    commandHandled = true;
    const { HeraldClient, HeraldClientError } = await import("../herald/service/client.js");
    try {
      const state = await new HeraldClient().state(opts.at ? Number(opts.at) : undefined);
      if (opts.json) {
        console.log(JSON.stringify(state, null, 2));
      } else {
        console.log(
          `seq=${state.seq} slices=${Object.keys(state.slices).length} ` +
            `sessions=${Object.keys(state.sessions).length} ` +
            `smithy=${state.smithy.dispatchable}/${state.smithy.blocked}/${state.smithy.total} (dispatchable/blocked/total)`,
        );
      }
      process.exitCode = SUCCESS;
    } catch (err) {
      const message = err instanceof HeraldClientError ? err.message : (err as Error).message;
      process.stderr.write(message + "\n");
      process.exitCode = ERROR;
    }
  });

program
  .command("spawn [subcommand]")
  .description("Spawn a new environment")
  .option(
    "--backend <name>",
    `Backend for spawn dispatch (${listBackends().join(", ")})`,
  )
  .option("--prompt <prompt>", "Prompt to run in the spawned backend")
  .option("--task-type <type>", "Task type for telemetry tagging")
  .option("--task-name <name>", "Task name for telemetry tagging")
  .option("--profile <profile>", "Deployment profile for telemetry tagging (default: unknown)")
  .allowUnknownOption()
  .action((subcommand?: string, options?: {
    backend?: string;
    prompt?: string;
    taskType?: string;
    taskName?: string;
    profile?: string;
  }) => {
    commandHandled = true;
    // Dispatch-only validation: only `march spawn dispatch` runs the full
    // dependency check (PATH search utility + git on PATH + docker on PATH +
    // cwd inside a git repo + base image accessible, per FR-003 and FR-004).
    // Bare `march spawn` and other subcommands skip the check so unrelated
    // spawn paths aren't forced through docker/repo/base-image validation.
    if (subcommand === "dispatch") {
      const backendSelection = resolveBackendSelection({
        flagValue: options?.backend,
        envValue: process.env.MARCH_BACKEND,
      });
      const selectedBackend = backendSelection.backend;
      if (!selectedBackend) {
        process.stderr.write(
          `Unknown backend "${backendSelection.requestedName}" from ${backendSourceLabel(backendSelection.source)}. Supported backends: ${listBackends().join(", ")}\n`,
        );
        process.exitCode = USAGE_ERROR;
        return;
      }

      const result = checkSpawnDependencies(selectedBackend.baseImage);
      if (!result.ok) {
        process.stderr.write(result.error + "\n");
        process.exitCode = ERROR;
        return;
      }

      const missingEnvVars = missingRequiredEnvVars(selectedBackend);
      if (missingEnvVars.length > 0) {
        process.stderr.write(
          `Backend "${selectedBackend.name}" requires ${selectedBackend.requiredEnvVars.join(", ")}: missing ${missingEnvVars.join(", ")}. Set the variable(s) and re-run.\n`,
        );
        process.exitCode = USAGE_ERROR;
        return;
      }

      const missingMounts = missingCredentialMounts(selectedBackend);
      if (missingMounts.length > 0) {
        process.stderr.write(
          `Backend "${selectedBackend.name}" requires readable credential directories: ${missingMounts.map((mount) => mount.hostPath).join(", ")}. Configure the credential path(s) and re-run.\n`,
        );
        process.exitCode = USAGE_ERROR;
        return;
      }

      const prompt = options?.prompt;
      if (!prompt || prompt.length === 0) {
        process.stderr.write(
          'march spawn dispatch requires --prompt <prompt> for the Codex lifecycle proof path.\n',
        );
        process.exitCode = USAGE_ERROR;
        return;
      }

      const taskType =
        options?.taskType?.trim() ||
        process.env.MARCH_TASK_TYPE?.trim() ||
        "unknown";
      const taskName =
        options?.taskName?.trim() ||
        process.env.MARCH_TASK_NAME?.trim() ||
        "unknown";
      // Profile is invoker-owned (no env fallback): a bare dispatch has no
      // Legate deployment profile, so it defaults to "unknown".
      const profile = options?.profile?.trim() || "unknown";

      // checkSpawnDependencies has already verified we're inside a git
      // repo; re-run `git rev-parse --show-toplevel` here to capture the
      // absolute repo root for the worktree + SpawnRecord modules.
      let repoRoot: string;
      try {
        repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
          encoding: "utf-8",
        }).trim();
      } catch (err) {
        process.stderr.write(
          `Failed to detect repo root: ${(err as Error).message}\n`,
        );
        process.exitCode = ERROR;
        return;
      }

      // Stage 2 (Worktree) — create branch + linked worktree. Failures
      // inside createSpawnWorktree self-roll-back before throwing;
      // failures at the subsequent SpawnRecord write roll back the
      // worktree + branch from the caller below.
      let worktree: SpawnWorktree;
      try {
        worktree = createSpawnWorktree(repoRoot);
      } catch (err) {
        const message =
          err instanceof WorktreeError ? err.message : (err as Error).message;
        process.stderr.write(message + "\n");
        process.exitCode = ERROR;
        return;
      }

      const dispatchStartMs = Date.now();
      const dispatch = startDispatchSpan({
        traceKey: worktree.spawnId,
        rootName: "spawn.dispatch",
        attributes: {
          "march.profile": profile,
          "march.task.name": taskName,
          "march.task.type": taskType,
          "march.backend": selectedBackend.name,
          "march.spawn_id": worktree.spawnId,
        },
      });
      let dispatchExitCode: number | undefined;
      try {
      // Initial SpawnRecord write (FR-019, data-model `absent → created`).
      // On failure, roll back the branch + worktree so no residual state
      // survives the partial dispatch.
      try {
        writeInitialSpawnRecord({
          id: worktree.spawnId,
          repoPath: repoRoot,
          branch: worktree.branch,
          worktreePath: worktree.worktreePath,
          backend: selectedBackend.name,
        });
        updateSpawnRecordPrompt(worktree.spawnId, prompt);
      } catch (err) {
        removeSpawnRecord(worktree.spawnId);
        removeSpawnWorktree(repoRoot, worktree);
        const message =
          err instanceof SpawnRecordError
            ? err.message
            : (err as Error).message;
        process.stderr.write(message + "\n");
        process.exitCode = ERROR;
        return;
      }

      // Stage 3 (Snapshot + Build) — assemble a temp build context from
      // the worktree's tracked files (minus the Snapshot Exclusion List),
      // generate the spawn Dockerfile, build the tagged image
      // `march-spawn-<id>`, and update the SpawnRecord with the resulting
      // imageId. Per the Dispatch Pipeline contract's "stage 7 Record
      // runs unconditionally" rule and the data-model `created → failed`
      // transition, any failure here transitions the SpawnRecord to
      // `"failed"` (preserved on disk for auditing), then rolls back the
      // image / worktree / branch in reverse order. The SpawnRecord file
      // itself is NOT deleted on Story 4 failures.
      try {
        const handle = createBuildContext(worktree.worktreePath);
        try {
          const dockerfilePath = writeSpawnDockerfile(
            handle.contextPath,
            selectedBackend.baseImage,
          );
          const imageTag = buildSpawnImage({
            spawnId: worktree.spawnId,
            contextPath: handle.contextPath,
            dockerfilePath,
          });
          updateSpawnRecordImageId(worktree.spawnId, imageTag);
        } finally {
          // Inner finally so the temp build-context dir is removed on both
          // the success and failure paths once docker has copied from it
          // (AS 4.x — "cleaned up on both success and failure").
          handle.cleanup();
        }
      } catch (err) {
        // Per the contract: transition the SpawnRecord to "failed" BEFORE
        // physical-artifact cleanup so that even if cleanup itself fails
        // partway through, the record reflects the failure for auditing.
        try {
          markSpawnRecordFailed(worktree.spawnId, {
            error: (err as Error).message,
          });
        } catch (markErr) {
          // The record may now be in an inconsistent state (still
          // "created" or partially written). Surface a clear warning but
          // continue with artifact cleanup — the operator still needs the
          // worktree / branch / image gone per FR-021.
          process.stderr.write(
            `warning: failed to transition spawn record to "failed" for spawn ${worktree.spawnId}: ${(markErr as Error).message}; the record file may be in an inconsistent state.\n`,
          );
        }

        // Reverse-order artifact cleanup: image (idempotent — no-op if
        // build never produced one) → worktree (also deletes the branch).
        // The SpawnRecord file is NOT removed — it stays on disk with
        // status "failed" so failure auditing remains possible.
        removeSpawnImage(worktree.spawnId);
        removeSpawnWorktree(repoRoot, worktree);

        const message =
          err instanceof SnapshotError ||
          err instanceof BuildError ||
          err instanceof SpawnRecordError
            ? err.message
            : (err as Error).message;
        process.stderr.write(message + "\n");
        process.exitCode = ERROR;
        return;
      }

      // Stage 4 (Launch) — start the spawn container with the hardcoded
      // SPAWN_CONFIG security configuration, capture the container ID,
      // and transition the SpawnRecord from "created" to "running"
      // (FR-011 / FR-012 / FR-013, FR-019, AS 5.1–5.5, data-model
      // created → running).
      //
      // On any failure here (LaunchError from the container launch, or
      // SpawnRecordError from the running-record update), mirror Stage 3's
      // failure pattern: transition the SpawnRecord to "failed" (preserved
      // on disk for auditing per the contracts' "stage 7 Record runs
      // unconditionally" rule and SD-002), then run reverse-order cleanup
      // (container → image → worktree+branch) before exiting 1.
      // markSpawnRecordRunning failure after a successful launch still
      // calls removeSpawnContainer so a started container does not survive
      // a failed transition (SD-002).
      let containerId: string;
      try {
        containerId = dispatch.span("spawn.start", () => {
          const otelCtx = buildSpawnOtelContext({
            traceparent: dispatch.traceparent(),
            attributes: {
              "service.name": "march-spawn",
              "march.profile": profile,
              "march.task.name": taskName,
              "march.task.type": taskType,
              "march.backend": selectedBackend.name,
              "march.spawn_id": worktree.spawnId,
            },
          });
          const cid = createSpawnContainer({
            spawnId: worktree.spawnId,
            backend: selectedBackend,
            otel: otelCtx,
          });
          copyPromptToContainer(cid, prompt);
          if (otelCtx) copyOtelEmitterToContainer(cid);
          startSpawnContainer(cid);
          markSpawnRecordRunning(worktree.spawnId, cid);
          return cid;
        });
      } catch (err) {
        try {
          markSpawnRecordFailed(worktree.spawnId, {
            error: (err as Error).message,
          });
        } catch (markErr) {
          process.stderr.write(
            `warning: failed to transition spawn record to "failed" for spawn ${worktree.spawnId}: ${(markErr as Error).message}; the record file may be in an inconsistent state.\n`,
          );
        }
        // Reverse-order artifact cleanup. removeSpawnContainer is idempotent
        // (no-op if launch never produced a container), so it is safe to
        // call unconditionally on the failure path.
        removeSpawnContainer(worktree.spawnId);
        removeSpawnImage(worktree.spawnId);
        removeSpawnWorktree(repoRoot, worktree);

        const message =
          err instanceof LaunchError || err instanceof SpawnRecordError
            ? err.message
            : (err as Error).message;
        process.stderr.write(message + "\n");
        process.exitCode = ERROR;
        return;
      }

      try {
        const waitResult = dispatch.span("spawn.end", () => {
          const result = waitForSpawnContainer(containerId);
          const out = readSpawnContainerLogs(containerId);
          fs.writeFileSync(spawnOutputPath(worktree.spawnId), out, "utf-8");
          markSpawnRecordStopped(worktree.spawnId, result.exitCode);
          if (out.length > 0) {
            process.stdout.write(out);
            if (!out.endsWith("\n")) process.stdout.write("\n");
          }
          return result;
        });
        dispatchExitCode = waitResult.exitCode;
        process.exitCode = waitResult.exitCode === 0 ? SUCCESS : ERROR;
      } catch (err) {
        try {
          markSpawnRecordFailed(worktree.spawnId, {
            error: (err as Error).message,
          });
        } catch (markErr) {
          process.stderr.write(
            `warning: failed to transition spawn record to "failed" for spawn ${worktree.spawnId}: ${(markErr as Error).message}; the record file may be in an inconsistent state.\n`,
          );
        }
        const message =
          err instanceof LaunchError || err instanceof SpawnRecordError
            ? err.message
            : (err as Error).message;
        process.stderr.write(message + "\n");
        process.exitCode = ERROR;
      }
      } finally {
        const outcome: "success" | "failure" =
          dispatchExitCode === 0 ? "success" : "failure";
        if (dispatchExitCode !== undefined) {
          dispatch.setAttributes({ "march.exit_code": dispatchExitCode });
        }
        dispatch.end({ error: outcome !== "success" });
        recordSpawnRun({
          backend: selectedBackend.name,
          taskType,
          profile,
          outcome,
          durationSeconds: (Date.now() - dispatchStartMs) / 1000,
        });
      }
      return;
    }
    console.log(
      "march spawn is not yet implemented. It will be available after Feature 2: Spawn Dispatch.",
    );
    process.exitCode = ERROR;
  });

/**
 * Walk commander's tree following positional tokens in argv to find the
 * deepest Command that exists. Used to scope the help we re-emit when
 * commander throws `commander.help` for a subcommand group whose stderr
 * help write was suppressed by our `configureOutput.writeErr` override.
 */
function findInvokedCommand(argv: readonly string[]): Command {
  let cur: Command = program;
  for (const arg of argv) {
    if (arg.startsWith("-")) continue;
    const child = cur.commands.find(
      (c) => c.name() === arg || c.aliases().includes(arg),
    );
    if (!child) break;
    cur = child;
  }
  return cur;
}

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  // The OTEL lifecycle is owned here, in the CLI subsystem, so src/cli.ts stays
  // a pure bin wrapper. No-op unless MARCH_OTEL=1; the finally force-flushes
  // spans/metrics before the process exits — which happens as soon as runCli
  // returns, since the CLI does no further work.
  const otel = initOtel();
  try {
    await dispatchCli(argv);
  } finally {
    await otel.shutdown();
  }
}

async function dispatchCli(argv: readonly string[]): Promise<void> {
  try {
    await program.parseAsync([...argv]);
  } catch (err: unknown) {
    if (err instanceof CommanderError) {
      if (err.exitCode === 0) {
        // Commander throws with exitCode 0 for any handled flag (e.g.
        // --version, --help); the corresponding output already went to stdout.
        commandHandled = true;
        process.exitCode = SUCCESS;
      } else if (err.code === "commander.help") {
        // Subcommand group invoked with no subcommand (e.g. `march legate`).
        // Commander emitted help to stderr, but our writeErr override
        // suppressed it — re-emit to stdout, scoped to the right command.
        commandHandled = true;
        findInvokedCommand(argv.slice(2)).outputHelp();
        process.exitCode = USAGE_ERROR;
      } else if (err.code === "commander.unknownCommand") {
        // err.message names the actual unknown token, even when it's a
        // subcommand inside a group (`march legate frobnicate` →
        // "error: unknown command 'frobnicate'"). The bottom-of-file argv
        // scan would otherwise mis-blame the parent group.
        commandHandled = true;
        process.stderr.write(err.message + "\n");
        findInvokedCommand(argv.slice(2)).outputHelp();
        process.exitCode = USAGE_ERROR;
      }
    }
    // Other Commander errors fall through to the !commandHandled block below.
  }

  // No command was handled: either no args given or an unrecognised command.
  if (!commandHandled) {
    const unknownCmd = argv.slice(2).find((arg) => !arg.startsWith("-"));
    if (unknownCmd) {
      process.stderr.write(`error: unknown command '${unknownCmd}'\n`);
    }
    program.outputHelp();
    process.exitCode = USAGE_ERROR;
  }
}
