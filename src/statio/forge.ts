import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { validStatioSliceId } from "../observability/statio-trace.js";
import { getGitHubToken, TesseraClientError } from "../tessera/client.js";
import type { RepoInfo } from "./types.js";
import { StatioForgeError } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_GH_TIMEOUT_MS = 15_000;
const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_REMOTE = /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/i;

export interface RepoMetadataReader {
  repoInfo(sliceId?: string): Promise<RepoInfo>;
  reachable(sliceId?: string): Promise<boolean>;
}

export interface StatioCommandOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
}

export type StatioCommandRunner = (
  command: string,
  args: readonly string[],
  options: StatioCommandOptions,
) => Promise<string>;

export interface GhRepoMetadataReaderOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly repo?: string;
  readonly runCommand?: StatioCommandRunner;
  readonly issueToken?: typeof getGitHubToken;
}

export class StatioEntitlementError extends StatioForgeError {
  constructor(override readonly cause: TesseraClientError) {
    super("Could not obtain GitHub read access from Tessera.");
    this.name = "StatioEntitlementError";
  }
}

async function execText(
  command: string,
  args: readonly string[],
  options: StatioCommandOptions,
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function isUnauthorized(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === "string" && /^(?:gh: HTTP 401\b|HTTP 401:|gh: .*\(HTTP 401\))/.test(stderr.trimStart());
}

export function createStatioForgeCommands(options: GhRepoMetadataReaderOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  const runCommand = options.runCommand ?? execText;
  const issueToken = options.issueToken ?? getGitHubToken;

  async function resolveRepo(): Promise<string> {
    let repo = options.repo;
    if (repo === undefined) {
      try {
        const remote = await execText("git", ["remote", "get-url", "origin"], {
          cwd: options.cwd,
          timeoutMs,
        });
        repo = GITHUB_REMOTE.exec(remote.trim())?.[1];
      } catch {
        // A local discovery failure must never lead to an unscoped gh call.
      }
    }
    if (!repo || !REPO_SLUG.test(repo)) {
      throw new StatioForgeError("Could not resolve a GitHub repository from the Statio checkout.");
    }
    return repo;
  }

  async function run(repo: string, args: readonly string[], cwd?: string, sliceId?: string) {
    async function invoke(refresh?: true): Promise<string> {
      let token: string;
      try {
        ({ token } = await issueToken({
          repo, identity: "app", access: "read", sliceId: validStatioSliceId(sliceId), refresh,
        }));
      } catch (err) {
        throw new StatioEntitlementError(
          err instanceof TesseraClientError ? err : new TesseraClientError("invalid_response"),
        );
      }

      let configDir: string;
      try {
        configDir = await mkdtemp(path.join(os.tmpdir(), "march-statio-gh-"));
      } catch {
        throw new StatioForgeError("Could not isolate GitHub CLI configuration.");
      }
      const env = { ...process.env };
      delete env.GITHUB_TOKEN;
      delete env.GH_ENTERPRISE_TOKEN;
      delete env.GITHUB_ENTERPRISE_TOKEN;
      delete env.GH_REPO;
      delete env.MARCH_STATIO_TOKEN;
      delete env.MARCH_TESSERA_CLIENT_KEY;
      try {
        return await runCommand("gh", args, {
          cwd, timeoutMs,
          env: {
            ...env,
            GH_TOKEN: token,
            GH_CONFIG_DIR: configDir,
            GH_HOST: "github.com",
            GH_PROMPT_DISABLED: "1",
            GH_NO_UPDATE_NOTIFIER: "1",
            GH_DEBUG: "",
          },
        });
      } finally {
        await rm(configDir, { recursive: true, force: true }).catch(() => {
          throw new StatioForgeError("Could not clean up GitHub CLI configuration.");
        });
      }
    }

    try {
      return await invoke();
    } catch (err) {
      if (!isUnauthorized(err)) throw err;
      return invoke(true);
    }
  }

  return { resolveRepo, run };
}

export function buildRepoInfoArgs(repo?: string): string[] {
  return ["repo", "view", ...(repo ? [repo] : []), "--json", "nameWithOwner,defaultBranchRef"];
}

interface GhRepoViewOutput {
  readonly nameWithOwner?: unknown;
  readonly defaultBranchRef?: { readonly name?: unknown } | null;
}

export class GhRepoMetadataReader implements RepoMetadataReader {
  private readonly commands: ReturnType<typeof createStatioForgeCommands>;

  constructor(private readonly options: GhRepoMetadataReaderOptions = {}) {
    this.commands = createStatioForgeCommands(options);
  }

  async repoInfo(sliceId?: string): Promise<RepoInfo> {
    const repo = await this.commands.resolveRepo();
    let stdout: string;
    try {
      stdout = await this.commands.run(repo, buildRepoInfoArgs(repo), this.options.cwd, sliceId);
    } catch (err) {
      if (err instanceof StatioForgeError) throw err;
      throw new StatioForgeError("Could not read repository metadata from gh.");
    }

    try {
      const raw = JSON.parse(stdout) as GhRepoViewOutput;
      const owner = raw?.nameWithOwner;
      const defaultBranch = raw?.defaultBranchRef?.name;
      if (typeof owner === "string" && typeof defaultBranch === "string") {
        return { owner, defaultBranch };
      }
    } catch {
      // Preserve the metadata reader's typed parse error below.
    }
    throw new StatioForgeError("Could not parse repository metadata from gh.");
  }

  async reachable(sliceId?: string): Promise<boolean> {
    try {
      await this.repoInfo(sliceId);
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
