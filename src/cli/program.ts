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
import {
  DEFAULT_MANAGER_GROUP,
  HatcherySpawnError,
  runHatcherySpawn,
} from "../hatchery/spawn-handoff.js";
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
  .description("Manage the per-repo Legate agent and deterministic loop");

legate
  .command("init")
  .description("Set up a Legate agent and deterministic loop for the current repository")
  .option("-p, --profile <profile>", "agent-deck profile (default: derived from repo basename)")
  .option("-n, --name <name>", "Legate agent conductor name (default: <repo-slug>-legate-agent)")
  .option("-d, --description <description>", "Legate agent conductor description")
  .option("-g, --worker-group <group>", "Group for worker sessions (default: legate-workers)")
  .option(
    "-m, --model <model>",
    "Claude model alias or full ID for the Legate agent session (default: sonnet — orchestration is reasoning-light; workers stay on the Claude default).",
  )
  .option(
    "-i, --heartbeat-interval <interval>",
    "Cadence at which the conductor's systemd heartbeat timer fires. Accepts a subset of systemd time-span syntax: positive integer + single suffix (ns, us, ms, s, m, min, h, hr, d, w, y) — e.g. 5min, 10min, 300s, 1h, 500ms, 1w. Composite forms (1h 30min) are not supported. Default: 5min — agent-deck's own default is 15min, which is too slow for the Smithy plan→PR→fix loop. Validated everywhere; the systemd drop-in is only written on Linux/WSL2 (other platforms surface a warning and the operator pins the cadence manually).",
  )
  .option("--no-setup", "Render the template only; skip `agent-deck conductor setup`")
  .option(
    "--with-container",
    "Build and launch the Hatchery-managed Legate container after setup",
  )
  .option(
    "--no-processor",
    "Deprecated alias for --no-loop",
  )
  .option(
    "--no-loop",
    "Skip deploying the paired deterministic Legate loop conductor",
  )
  .option(
    "--processor-only",
    "Deprecated alias for --loop-only",
  )
  .option(
    "--loop-only",
    "Deploy only the paired deterministic loop conductor; do not create or start the Claude Legate agent",
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
    heartbeatInterval?: string;
    setup?: boolean; // commander negates --no-setup into setup=false
    withContainer?: boolean;
    processor?: boolean; // commander negates --no-processor into processor=false
    processorOnly?: boolean;
    loop?: boolean; // commander negates --no-loop into loop=false
    loopOnly?: boolean;
    bridgeCheck?: boolean; // commander negates --no-bridge-check into bridgeCheck=false
  }) => {
    commandHandled = true;

    const loopDisabled = opts.loop === false || opts.processor === false;
    const loopOnly = opts.loopOnly === true || opts.processorOnly === true;

    if (loopOnly && loopDisabled) {
      process.stderr.write(
        "`--loop-only` cannot be combined with `--no-loop`.\n",
      );
      process.exitCode = USAGE_ERROR;
      return;
    }
    if (loopOnly && opts.withContainer) {
      process.stderr.write(
        "`--loop-only` cannot be combined with `--with-container`.\n",
      );
      process.exitCode = USAGE_ERROR;
      return;
    }
    if (opts.withContainer && loopDisabled) {
      process.stderr.write(
        "`--with-container` cannot be combined with `--no-loop`.\n",
      );
      process.exitCode = USAGE_ERROR;
      return;
    }

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
    const willRunClaudeConductorSetup = willRunSetup && !loopOnly;
    if (opts.withContainer) {
      if (!isFinderAvailable()) {
        process.stderr.write(
          "Cannot verify Docker is installed: path-search utility unavailable.\n",
        );
        process.exitCode = ERROR;
        return;
      }
      if (!isOnPath("docker")) {
        process.stderr.write(
          "Docker not found on PATH — required for `march legate init --with-container`.\n",
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
      if (willRunClaudeConductorSetup && opts.bridgeCheck !== false) {
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
        heartbeatInterval: opts.heartbeatInterval,
        runSetup: willRunSetup,
        loop: loopOnly ? true : !loopDisabled,
        loopOnly,
        processor: loopOnly ? true : !loopDisabled,
        processorOnly: loopOnly,
        withContainer: opts.withContainer === true,
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
    "--manager-group <group>",
    `agent-deck group for manager sessions (default: ${DEFAULT_MANAGER_GROUP})`,
  )
  .option("--name <name>", "agent-deck session name/title for the manager")
  .option("--title <title>", "Alias for --name")
  .option("--branch <branch>", "Branch/worktree name for the manager session")
  .option("--json", "Print the Hatchery spawn result as JSON")
  .action((opts: {
    backend?: string;
    prompt?: string;
    agentDeckProfile?: string;
    managerGroup?: string;
    name?: string;
    title?: string;
    branch?: string;
    json?: boolean;
  }) => {
    commandHandled = true;

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

    if (!isFinderAvailable()) {
      process.stderr.write(
        "Cannot verify agent-deck is installed: path-search utility unavailable.\n",
      );
      process.exitCode = ERROR;
      return;
    }
    if (!isOnPath("agent-deck")) {
      process.stderr.write(
        "agent-deck not found on PATH — required for `march hatchery spawn` manager handoff.\n",
      );
      process.exitCode = ERROR;
      return;
    }

    const deps = checkSpawnDependencies(selectedBackend.baseImage);
    if (!deps.ok) {
      process.stderr.write(deps.error + "\n");
      process.exitCode = ERROR;
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
      const result = runHatcherySpawn({
        repoPath: repoRoot,
        prompt,
        backend: selectedBackend,
        agentDeckProfile: opts.agentDeckProfile,
        managerGroup: opts.managerGroup,
        title: opts.name ?? opts.title,
        branch: opts.branch,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.summary);
      }
      process.exitCode = SUCCESS;
    } catch (err) {
      const message =
        err instanceof HatcherySpawnError ||
        err instanceof SnapshotError ||
        err instanceof BuildError ||
        err instanceof LaunchError ||
        err instanceof SpawnRecordError
          ? err.message
          : (err as Error).message;
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
  .allowUnknownOption()
  .action((subcommand?: string, options?: { backend?: string; prompt?: string }) => {
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
        containerId = createSpawnContainer({
          spawnId: worktree.spawnId,
          backend: selectedBackend,
        });
        copyPromptToContainer(containerId, prompt);
        startSpawnContainer(containerId);
        markSpawnRecordRunning(worktree.spawnId, containerId);
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
        const waitResult = waitForSpawnContainer(containerId);
        const logs = readSpawnContainerLogs(containerId);
        fs.writeFileSync(spawnOutputPath(worktree.spawnId), logs, "utf-8");
        markSpawnRecordStopped(worktree.spawnId, waitResult.exitCode);
        if (logs.length > 0) {
          process.stdout.write(logs);
          if (!logs.endsWith("\n")) process.stdout.write("\n");
        }
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
