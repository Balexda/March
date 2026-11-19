import { execFile } from "node:child_process";

/**
 * The single rule for "which GitHub repository is this checkout": the slug of
 * its `origin` remote. Observation (Herald/legate sensing) and Legate's scoped
 * forge mutations both resolve through here, so a PR number read from one
 * repository is never acted on in another.
 */
const REMOTE_PATTERN = /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)\/?$/i;

/** Parse an `owner/name` slug from a GitHub remote URL, or null. */
export function githubRepoFromRemote(remote: string): string | null {
  const repo = remote.trim().match(REMOTE_PATTERN)?.[1].replace(/\.git$/i, "");
  if (!repo || !repo.split("/").every(part => part && part !== "." && part !== "..")) return null;
  return repo;
}

/** Resolve the checkout's `origin` GitHub slug. Never throws; null when unresolvable. */
export function resolveOriginRepo(cwd: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile(
      "git",
      ["config", "--local", "--get", "remote.origin.url"],
      { cwd, timeout: 5_000, killSignal: "SIGKILL", encoding: "utf-8" },
      (error, stdout) => resolve(error ? null : githubRepoFromRemote(String(stdout ?? ""))),
    );
  });
}

/** Case-insensitive slug equality (GitHub owner/name are case-insensitive). */
export function sameGitHubRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
