import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoInfo } from "./types.js";
import { StatioForgeError } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_GH_TIMEOUT_MS = 15_000;

export interface RepoMetadataReader {
  repoInfo(): Promise<RepoInfo>;
  reachable(): Promise<boolean>;
}

export interface GhRepoMetadataReaderOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

interface GhRepoViewOutput {
  readonly nameWithOwner?: unknown;
  readonly defaultBranchRef?: { readonly name?: unknown } | null;
}

function shapeRepoInfo(raw: unknown): RepoInfo {
  const parsed = raw as GhRepoViewOutput;
  const owner = parsed?.nameWithOwner;
  const defaultBranch = parsed?.defaultBranchRef?.name;
  if (typeof owner !== "string" || typeof defaultBranch !== "string") {
    throw new StatioForgeError("Could not parse repository metadata from gh.");
  }
  return { owner, defaultBranch };
}

export class GhRepoMetadataReader implements RepoMetadataReader {
  private readonly cwd: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: GhRepoMetadataReaderOptions = {}) {
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  }

  async repoInfo(): Promise<RepoInfo> {
    let stdout: string;
    try {
      const result = await execFileAsync(
        "gh",
        ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
        {
          cwd: this.cwd,
          timeout: this.timeoutMs,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        },
      );
      stdout = result.stdout;
    } catch {
      throw new StatioForgeError("Could not read repository metadata from gh.");
    }

    try {
      return shapeRepoInfo(JSON.parse(stdout));
    } catch (err) {
      if (err instanceof StatioForgeError) throw err;
      throw new StatioForgeError("Could not parse repository metadata from gh.");
    }
  }

  async reachable(): Promise<boolean> {
    try {
      await this.repoInfo();
      return true;
    } catch {
      return false;
    }
  }
}

export function createGhRepoMetadataReader(
  options: GhRepoMetadataReaderOptions = {},
): RepoMetadataReader {
  return new GhRepoMetadataReader(options);
}
