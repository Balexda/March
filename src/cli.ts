#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { Command, CommanderError } from "commander";
import { ERROR, SUCCESS, USAGE_ERROR } from "./exit-codes.js";
import { checkSpawnDependencies, isFinderAvailable, isOnPath } from "./deps.js";
import { checkBridgeRequirements, initLegate, LegateError } from "./legate.js";
import { initMarch, InitError } from "./init.js";
import {
  removeSpawnRecord,
  SpawnRecordError,
  writeInitialSpawnRecord,
} from "./spawn-record.js";
import { updateMarch, UpdateError } from "./update.js";
import { CLI_VERSION } from "./version.js";
import {
  createSpawnWorktree,
  removeSpawnWorktree,
  SpawnWorktree,
  WorktreeError,
} from "./worktree.js";

/**
 * Tagged base container image with the backend CLI pre-installed.
 * Used by the dispatch action to validate image availability via
 * checkSpawnDependencies(). Eventually derived from SpawnBackend.baseImage.
 */
const BASE_IMAGE = "march-base:latest";

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
  .description("Manage the per-repo legate conductor (Smithy workflow orchestrator)");

legate
  .command("init")
  .description("Set up a legate conductor for the current repository")
  .option("-p, --profile <profile>", "agent-deck profile (default: derived from repo basename)")
  .option("-n, --name <name>", "Conductor name (default: legate-<repo-slug>)")
  .option("-d, --description <description>", "Conductor description")
  .option("-g, --worker-group <group>", "Group for worker sessions (default: legate-workers)")
  .option(
    "-m, --model <model>",
    "Claude model alias or full ID for the conductor session (default: sonnet — orchestration is reasoning-light; workers stay on the Claude default).",
  )
  .option("--no-setup", "Render the template only; skip `agent-deck conductor setup`")
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
    setup?: boolean; // commander negates --no-setup into setup=false
    bridgeCheck?: boolean; // commander negates --no-bridge-check into bridgeCheck=false
  }) => {
    commandHandled = true;

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
        runSetup: willRunSetup,
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

program
  .command("spawn [subcommand]")
  .description("Spawn a new environment")
  .allowUnknownOption()
  .action((subcommand?: string) => {
    commandHandled = true;
    // Dispatch-only validation: only `march spawn dispatch` runs the full
    // dependency check (PATH search utility + git on PATH + docker on PATH +
    // cwd inside a git repo + base image accessible, per FR-003 and FR-004).
    // Bare `march spawn` and other subcommands skip the check so unrelated
    // spawn paths aren't forced through docker/repo/base-image validation.
    if (subcommand === "dispatch") {
      const result = checkSpawnDependencies(BASE_IMAGE);
      if (!result.ok) {
        process.stderr.write(result.error + "\n");
        process.exitCode = ERROR;
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
        });
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

try {
  await program.parseAsync(process.argv);
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
      findInvokedCommand(process.argv.slice(2)).outputHelp();
      process.exitCode = USAGE_ERROR;
    } else if (err.code === "commander.unknownCommand") {
      // err.message names the actual unknown token, even when it's a
      // subcommand inside a group (`march legate frobnicate` →
      // "error: unknown command 'frobnicate'"). The bottom-of-file argv
      // scan would otherwise mis-blame the parent group.
      commandHandled = true;
      process.stderr.write(err.message + "\n");
      findInvokedCommand(process.argv.slice(2)).outputHelp();
      process.exitCode = USAGE_ERROR;
    }
  }
  // Other Commander errors fall through to the !commandHandled block below.
}

// No command was handled: either no args given or an unrecognised command.
if (!commandHandled) {
  const unknownCmd = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  if (unknownCmd) {
    process.stderr.write(`error: unknown command '${unknownCmd}'\n`);
  }
  program.outputHelp();
  process.exitCode = USAGE_ERROR;
}
