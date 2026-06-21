import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Host-side probes `march doctor` uses to inspect a running stack WITHOUT a
 * source checkout: the docker socket (by container name), local git on a
 * profile's repo, and filesystem existence. Each is injectable so the checks
 * can be unit-tested with fakes, and each degrades to a null/false "could not
 * determine" rather than throwing — a probe failure is a diagnosis, not a crash.
 */

/** Reads a single env var from a running container's config. */
export type ContainerEnvReader = (
  container: string,
  name: string,
) => string | null;

/** Container lifecycle state, as reported by `docker inspect`. */
export type ContainerState = "running" | "stopped" | "absent";

/** Reads a container's lifecycle state. */
export type ContainerStateReader = (container: string) => ContainerState;

/** Runs a read-only git query against a repo, returning trimmed stdout or null. */
export type GitRunner = (repoPath: string, args: readonly string[]) => string | null;

/** Tests whether a filesystem path exists. */
export type PathExists = (path: string) => boolean;

/** Reads the hostname of the machine running the default tmux server, or null. */
export type TmuxServerHostReader = () => string | null;

/**
 * Read one env var from a container via `docker inspect`. Returns null when the
 * container is absent, docker is unavailable, or the var is unset — the caller
 * distinguishes "stack not running" (every container null) from "drift" (some
 * set, some not / values disagree).
 */
export const dockerContainerEnv: ContainerEnvReader = (container, name) => {
  let out: string;
  try {
    out = execFileSync(
      "docker",
      ["inspect", "-f", `{{range .Config.Env}}{{println .}}{{end}}`, container],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    // `No such object` (container absent) or docker unavailable.
    return null;
  }
  const prefix = `${name}=`;
  for (const line of out.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return null;
};

/** Default container-state probe via `docker inspect`. */
export const dockerContainerState: ContainerStateReader = (container) => {
  let out: string;
  try {
    out = execFileSync("docker", ["inspect", "-f", "{{.State.Status}}", container], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "absent";
  }
  return out === "running" ? "running" : "stopped";
};

/**
 * Run a read-only git command in `repoPath`. Returns trimmed stdout, or null on
 * any failure (not a repo, git missing, network error for `ls-remote`). Used
 * only for sync-health, which compares the local default branch against origin.
 */
export const runGit: GitRunner = (repoPath, args) => {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
};

/** Default path-existence probe. */
export const pathExists: PathExists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

/**
 * Read the hostname of the host running the default tmux server via
 * `tmux list-sessions -F '#{host}'`. tmux evaluates `#{host}` server-side, so
 * the value is the machine the server — and therefore every pane it spawns —
 * lives on. `list-sessions` (unlike `display-message`) needs no attached client,
 * so it works when `march doctor` runs from a plain shell. Returns null when no
 * server is running, tmux is unavailable, or there are no sessions.
 */
export const tmuxServerHost: TmuxServerHostReader = () => {
  let out: string;
  try {
    out = execFileSync("tmux", ["list-sessions", "-F", "#{host}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // No server running, no sessions, or tmux not installed.
    return null;
  }
  const first = out.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return first ?? null;
};
