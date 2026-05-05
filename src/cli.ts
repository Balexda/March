#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { Command, CommanderError } from "commander";
import { ERROR, SUCCESS, USAGE_ERROR } from "./exit-codes.js";
import { checkSpawnDependencies } from "./deps.js";
import { initMarch, InitError } from "./init.js";
import { createBuildContext, SnapshotError } from "./snapshot.js";
import {
  buildSpawnImage,
  BuildError,
  removeSpawnImage,
  writeSpawnDockerfile,
} from "./snapshot-build.js";
import { BASE_IMAGE } from "./spawn-config.js";
import {
  markSpawnRecordFailed,
  removeSpawnRecord,
  SpawnRecordError,
  updateSpawnRecordImageId,
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
          const dockerfilePath = writeSpawnDockerfile(handle.contextPath);
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
          markSpawnRecordFailed(worktree.spawnId);
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
