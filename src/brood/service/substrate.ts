import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  removeSpawnWorktreeExact,
  type RemoveWorktreeResult,
} from "../worktree.js";

export interface ComputeTarget {
  sessionId: string;
  kind: string;
  containerName: string;
}

/** Substrate-specific call-outs for reclaiming session compute and workspace. */
export interface TeardownSubstrate {
  /** Resolve only after verifying absence. Throw on failed or unverified removal. */
  removeCompute(target: ComputeTarget): Promise<void>;

  /** Reclaim only the supplied worktree path or branch. */
  removeWorkspace(
    repoRoot: string,
    target: { worktreePath?: string; branch?: string },
  ): RemoveWorktreeResult;
}

const execFileAsync = promisify(execFile);
const dockerOptions = { timeout: 10_000, killSignal: "SIGKILL" } as const;

async function findContainer(name: string): Promise<string> {
  const { stdout } = await execFileAsync("docker", [
    "container", "ls", "--all", "--no-trunc",
    "--filter", "name=^/" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
    "--format", '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project"}}',
  ], dockerOptions);
  return stdout.trim();
}

async function removeHostCompute({ containerName }: ComputeTarget): Promise<void> {
  const found = await findContainer(containerName);
  if (!found) return;
  const [id, name, composeProject] = found.split(/\s+/);
  if (!/^[a-f0-9]{64}$/.test(id) || name !== containerName || composeProject) {
    throw new Error(`Container "${containerName}" is not a verified ephemeral session target`);
  }
  // Delete by immutable ID so a replacement at the same name is never removed.
  try {
    await execFileAsync("docker", ["container", "rm", "--force", "--", id], dockerOptions);
  } catch (err) {
    const failure = err as { code?: number; signal?: string; stderr?: string };
    if (failure.code !== 1 || failure.signal ||
        failure.stderr?.trim() !== `Error response from daemon: No such container: ${id}`) {
      throw err;
    }
  }
  if (await findContainer(containerName)) {
    throw new Error(`Container "${containerName}" still exists after removal`);
  }
}

/** Default adapter for the shared host's Docker socket and Git checkout. */
export const hostTeardownSubstrate: TeardownSubstrate = {
  removeCompute: removeHostCompute,
  removeWorkspace: removeSpawnWorktreeExact,
};
