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

/**
 * Read the hostname of the machine running the default tmux server via
 * `tmux list-sessions -F '#{host}'`. tmux evaluates `#{host}` server-side, so
 * this reports the *server's* host, not ours. Returns null when no server is
 * reachable or tmux is absent. Used to detect a foreign-owned socket (e.g. the
 * autostarted castra container) before `march up` claims the host anchor.
 */
export function readTmuxServerHost(): string | null {
  try {
    const out = execFileSync("tmux", ["list-sessions", "-F", "#{host}"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const host = out
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    return host ?? null;
  } catch {
    return null;
  }
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
