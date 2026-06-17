import { execFileSync } from "node:child_process";

/**
 * Shared command-execution helpers for the stack-lifecycle commands
 * (`march up` / `down` / ...). Kept separate so both commands depend on the
 * same runner contract without importing each other.
 */

/** Runs a command, throwing on non-zero exit (the `execFileSync` contract). */
export type CommandRunner = (
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => void;

/** Default runner: invoke the binary, inheriting nothing but the given env. */
export const runCommand: CommandRunner = (file, args, env) => {
  execFileSync(file, args, { stdio: ["ignore", "ignore", "pipe"], env });
};

/** True when a local Docker image exists (`docker image inspect` exits 0). */
export function imageExists(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}
