#!/usr/bin/env node
import { createInterface } from "node:readline";
import { Command, CommanderError } from "commander";
import { ERROR, SUCCESS, USAGE_ERROR } from "./exit-codes.js";
import { checkSpawnDependencies } from "./deps.js";
import { initMarch, InitError } from "./init.js";
import { updateMarch, UpdateError } from "./update.js";
import { CLI_VERSION } from "./version.js";

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
    }
    console.log(
      "march spawn is not yet implemented. It will be available after Feature 2: Spawn Dispatch.",
    );
    process.exitCode = ERROR;
  });

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  if (err instanceof CommanderError) {
    // Commander throws with exitCode 0 for any handled flag (e.g. --version, --help)
    if (err.exitCode === 0) {
      commandHandled = true;
      process.exitCode = SUCCESS;
    }
  }
  // Non-zero Commander error — fall through to the !commandHandled block below.
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
