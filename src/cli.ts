#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { ERROR, SUCCESS, USAGE_ERROR } from "./exit-codes.js";
import { initMarch, InitError } from "./init.js";
import { CLI_VERSION } from "./version.js";

const program = new Command();

program
  .name("march")
  .version(CLI_VERSION)
  .option("--yes", "Skip confirmation prompts")
  .exitOverride();

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
  .command("version")
  .description("Display the installed CLI version")
  .action(() => {
    commandHandled = true;
    console.log(CLI_VERSION);
    process.exitCode = SUCCESS;
  });

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  if (err instanceof CommanderError) {
    // commander.version and commander.help throw with exitCode 0
    if (err.exitCode === 0) {
      commandHandled = true;
      process.exitCode = SUCCESS;
    }
  }
  // Non-zero commander error (e.g., unknown command) — fall through to usage output
}

// No command was handled: either no args given or an unrecognised command.
if (!commandHandled) {
  program.outputHelp();
  process.exitCode = USAGE_ERROR;
}
