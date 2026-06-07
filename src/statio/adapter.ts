import { execFile } from "node:child_process";
import type { RepoInfo, ForgeClient } from "./types.js";
import { StatioForgeError } from "./types.js";

const EXEC_MAX_BUFFER = 1024 * 1024;
const DEFAULT_GH_TIMEOUT_MS = 10_000;

export interface StatioCommandOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
}

export type StatioCommandRunner = (
  command: string,
  args: readonly string[],
  options: StatioCommandOptions,
) => Promise<string>;

export interface GhForgeAdapterOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly runCommand?: StatioCommandRunner;
}

export function buildRepoInfoArgs(): string[] {
  return ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"];
}

export function parseRepoInfoGhJson(text: string): RepoInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new StatioForgeError("gh repo view returned unparseable repository metadata.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StatioForgeError("gh repo view returned malformed repository metadata.");
  }
  const record = parsed as Record<string, unknown>;
  const owner = record.nameWithOwner;
  const defaultBranchRef = record.defaultBranchRef;
  const defaultBranch =
    defaultBranchRef && typeof defaultBranchRef === "object" && !Array.isArray(defaultBranchRef)
      ? (defaultBranchRef as Record<string, unknown>).name
      : undefined;

  if (typeof owner !== "string" || owner.length === 0) {
    throw new StatioForgeError("gh repo view did not return a repository owner.");
  }
  if (typeof defaultBranch !== "string" || defaultBranch.length === 0) {
    throw new StatioForgeError("gh repo view did not return a default branch.");
  }

  return { owner, defaultBranch };
}

export function createGhForgeAdapter(
  options: GhForgeAdapterOptions = {},
): Pick<ForgeClient, "repoInfo"> {
  const runCommand = options.runCommand ?? execText;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;

  return {
    async repoInfo(): Promise<RepoInfo> {
      let stdout: string;
      try {
        stdout = await runCommand("gh", buildRepoInfoArgs(), {
          cwd: options.cwd,
          timeoutMs,
        });
      } catch {
        throw new StatioForgeError("gh repo view failed while resolving repository metadata.");
      }
      return parseRepoInfoGhJson(stdout);
    },
  };
}

function execText(
  command: string,
  args: readonly string[],
  options: StatioCommandOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args as string[],
      {
        cwd: options.cwd,
        encoding: "utf-8",
        maxBuffer: EXEC_MAX_BUFFER,
        signal: AbortSignal.timeout(options.timeoutMs),
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(typeof stdout === "string" ? stdout : "");
      },
    );
  });
}
