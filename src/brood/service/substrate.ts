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

export type StopComputeResult =
  | { outcome: "stopped" | "already-stopped"; containerId: string }
  | { outcome: "absent" };

/** Substrate-specific call-outs for reclaiming session compute and workspace. */
export interface TeardownSubstrate {
  /** Stop without escalation or removal. Throw when a graceful stop cannot be verified. */
  stopCompute?(target: ComputeTarget): Promise<StopComputeResult>;

  /** Resolve only after verifying absence. Throw on failed or unverified removal. */
  removeCompute(target: ComputeTarget, stopped?: StopComputeResult): Promise<void>;

  /** Reclaim only the supplied worktree path or branch. */
  removeWorkspace(
    repoRoot: string,
    target: { worktreePath?: string; branch?: string },
  ): RemoveWorktreeResult;
}

const execFileAsync = promisify(execFile);
const dockerOptions = { timeout: 10_000, killSignal: "SIGKILL" } as const;

async function findContainer(name: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("docker", [
    "container", "ls", "--all", "--no-trunc",
    "--filter", "name=^/" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
    "--format", '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project"}}',
  ], signal ? { ...dockerOptions, signal } : dockerOptions);
  return stdout.trim();
}

function verifiedId(containerName: string, found: string): string {
  const [id, name, composeProject] = found.split(/\s+/);
  if (!/^[a-f0-9]{64}$/.test(id) || name !== containerName || composeProject) {
    throw new Error(`Container "${containerName}" is not a verified ephemeral session target`);
  }
  return id;
}

async function stopHostCompute({ containerName }: ComputeTarget): Promise<StopComputeResult> {
  const signal = AbortSignal.timeout(dockerOptions.timeout);
  const options = { ...dockerOptions, signal };
  const found = await findContainer(containerName, signal);
  if (!found) return { outcome: "absent" };
  const containerId = verifiedId(containerName, found);
  const inspectStatus = async () => {
    const { stdout } = await execFileAsync("docker", [
      "container", "inspect", "--format", "{{.State.Status}}", "--", containerId,
    ], options);
    return stdout.trim();
  };
  const status = await inspectStatus();
  if (status === "exited" || status === "created") {
    return { outcome: "already-stopped", containerId };
  }
  if (status !== "running") {
    throw new Error(`Container "${containerName}" cannot be gracefully stopped from state "${status}"`);
  }

  // Send only SIGTERM. Docker stop can escalate on its own when its grace period expires.
  await execFileAsync("docker", [
    "container", "kill", "--signal", "SIGTERM", "--", containerId,
  ], options);
  const { stdout } = await execFileAsync("docker", ["container", "wait", "--", containerId], options);
  const exitCode = stdout.trim();
  if (!/^\d+$/.test(exitCode) || exitCode === "137" || await inspectStatus() !== "exited") {
    throw new Error(`Container "${containerName}" did not reach a verified graceful stop (exit: ${exitCode})`);
  }
  return { outcome: "stopped", containerId };
}

async function removeHostCompute(
  { containerName }: ComputeTarget,
  stopped?: StopComputeResult,
): Promise<void> {
  const found = await findContainer(containerName);
  if (!found) return;
  const id = verifiedId(containerName, found);
  if (stopped && (stopped.outcome === "absent" || stopped.containerId !== id)) {
    throw new Error(`Container "${containerName}" changed after the stop check`);
  }
  // Delete by immutable ID so a replacement at the same name is never removed.
  try {
    await execFileAsync("docker", [
      "container", "rm", ...(stopped ? [] : ["--force"]), "--", id,
    ], dockerOptions);
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
  stopCompute: stopHostCompute,
  removeCompute: removeHostCompute,
  removeWorkspace: removeSpawnWorktreeExact,
};
