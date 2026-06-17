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

/**
 * Build-oriented runner: stream the child's stdout/stderr straight to this
 * process's terminal (`stdio: "inherit"`) instead of buffering them. A real
 * `docker build` emits verbose progress (`npm ci`, apt, downloads) that can
 * exceed `execFileSync`'s default `maxBuffer` and abort with `ENOBUFS` — a
 * spurious "build failed" even though the same build succeeds from the package
 * scripts. Inheriting stdio sidesteps the buffer entirely and shows live build
 * output, the expected UX for `march upgrade`. Throws on non-zero exit, same as
 * {@link runCommand}; the diagnostic is already on the terminal, so callers fall
 * back to the error message for their result detail.
 */
export const runBuild: CommandRunner = (file, args, env) => {
  execFileSync(file, args, { stdio: "inherit", env });
};

/**
 * Extract the most actionable text from a failed `execFileSync` error. The
 * underlying Docker/Compose diagnostic lands on the child's stderr (captured
 * because stderr is piped), so prefer it over the generic `Command failed: …`
 * message. Falls back to the message when stderr is empty.
 */
export function describeExecError(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: Buffer | string | null }).stderr;
    const text = stderr ? stderr.toString().trim() : "";
    if (text) return text;
  }
  return err instanceof Error ? err.message : String(err);
}

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
