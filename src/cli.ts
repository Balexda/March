#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { ERROR, SUCCESS, USAGE_ERROR } from "./exit-codes.js";

const program = new Command();

program
  .name("march")
  .version("0.1.0")
  .option("--yes", "Skip confirmation prompts")
  .exitOverride();

program
  .command("init")
  .description("Initialize the March environment")
  .action(() => {
    console.log("not yet implemented");
    process.exit(ERROR);
  });

try {
  program.parse(process.argv);
} catch (err: unknown) {
  if (err instanceof CommanderError) {
    // commander.version and commander.help throw with exitCode 0
    if (err.exitCode === 0) {
      process.exit(SUCCESS);
    }
  }
  // Unknown command or other parse error — fall through to show usage
}

// If we reach here, no subcommand action called process.exit,
// meaning no command was given or an unknown command was rejected.
program.outputHelp();
process.exit(USAGE_ERROR);
