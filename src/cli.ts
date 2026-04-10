#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { SUCCESS, USAGE_ERROR } from "./exit-codes.js";
import { initMarch } from "./init.js";

const program = new Command();

program
  .name("march")
  .version("0.1.0")
  .option("--yes", "Skip confirmation prompts")
  .exitOverride();

program
  .command("init")
  .description("Initialize the March environment")
  .action(async () => {
    await initMarch();
    process.exit(SUCCESS);
  });

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  if (err instanceof CommanderError) {
    // commander.version and commander.help throw with exitCode 0
    if (err.exitCode === 0) {
      process.exit(SUCCESS);
    }
  }
  // Non-zero commander error (e.g., unknown command) — allow execution
  // to continue to usage output below
}

// If we reach here, execution fell through because either:
// (a) no command was given, or (b) an unknown command threw a CommanderError
// that was caught and not re-thrown above.
program.outputHelp();
process.exit(USAGE_ERROR);
