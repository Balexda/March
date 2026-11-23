import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  removeSpawnWorktreeExactAsync,
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
  stopCompute?(target: ComputeTarget, signal?: AbortSignal): Promise<StopComputeResult>;

  /** Resolve only after verifying absence. Throw on failed or unverified removal. */
  removeCompute(target: ComputeTarget, stopped?: StopComputeResult, signal?: AbortSignal): Promise<void>;

  /** Reclaim only the supplied worktree path or branch. */
  removeWorkspace(
    repoRoot: string,
    target: { worktreePath?: string; branch?: string },
    signal?: AbortSignal,
  ): RemoveWorktreeResult | Promise<RemoveWorktreeResult>;
}

const execFileAsync = promisify(execFile);
const dockerOptions = { timeout: 10_000, killSignal: "SIGKILL" } as const;

async function docker(args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const command = execFileAsync("docker", args, { ...dockerOptions, signal });
  try {
    return (await command).stdout.trim();
  } catch (error) {
    const { child } = command;
    // Keep the retry fence until the local client has actually exited.
    if (signal.aborted && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    throw error;
  }
}

async function findContainer(name: string, signal: AbortSignal): Promise<string> {
  return docker([
    "container", "ls", "--all", "--no-trunc",
    "--filter", "name=^/" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
    "--format", '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project"}}',
  ], signal);
}

function verifiedId(containerName: string, found: string): string {
  const [id, name, composeProject] = found.split(/\s+/);
  if (!/^[a-f0-9]{64}$/.test(id) || name !== containerName || composeProject) {
    throw new Error(`Container "${containerName}" is not a verified ephemeral session target`);
  }
  return id;
}

async function stopHostCompute(
  { containerName }: ComputeTarget,
  signal = AbortSignal.timeout(dockerOptions.timeout),
): Promise<StopComputeResult> {
  const found = await findContainer(containerName, signal);
  if (!found) return { outcome: "absent" };
  const containerId = verifiedId(containerName, found);
  const inspectStatus = () => docker([
    "container", "inspect", "--format", "{{.State.Status}}", "--", containerId,
  ], signal);
  const status = await inspectStatus();
  if (status === "exited" || status === "created") {
    return { outcome: "already-stopped", containerId };
  }
  if (status !== "running") {
    throw new Error(`Container "${containerName}" cannot be gracefully stopped from state "${status}"`);
  }

  // Send only SIGTERM. Docker stop can escalate on its own when its grace period expires.
  await docker([
    "container", "kill", "--signal", "SIGTERM", "--", containerId,
  ], signal);
  const exitCode = await docker(["container", "wait", "--", containerId], signal);
  if (!/^\d+$/.test(exitCode) || exitCode === "137" || await inspectStatus() !== "exited") {
    throw new Error(`Container "${containerName}" did not reach a verified graceful stop (exit: ${exitCode})`);
  }
  return { outcome: "stopped", containerId };
}

async function removeHostCompute(
  { containerName }: ComputeTarget,
  stopped?: StopComputeResult,
  signal = AbortSignal.timeout(dockerOptions.timeout),
): Promise<void> {
  const found = await findContainer(containerName, signal);
  if (!found) return;
  const id = verifiedId(containerName, found);
  if (stopped && (stopped.outcome === "absent" || stopped.containerId !== id)) {
    throw new Error(`Container "${containerName}" changed after the stop check`);
  }
  // Delete by immutable ID so a replacement at the same name is never removed.
  try {
    await docker([
      "container", "rm", ...(stopped ? [] : ["--force"]), "--", id,
    ], signal);
  } catch (err) {
    const failure = err as { code?: number; signal?: string; stderr?: string };
    if (failure.code !== 1 || failure.signal ||
        failure.stderr?.trim() !== `Error response from daemon: No such container: ${id}`) {
      throw err;
    }
  }
  if (await findContainer(containerName, signal)) {
    throw new Error(`Container "${containerName}" still exists after removal`);
  }
}

/** Default adapter for the shared host's Docker socket and Git checkout. */
export const hostTeardownSubstrate: TeardownSubstrate = {
  stopCompute: stopHostCompute,
  removeCompute: removeHostCompute,
  removeWorkspace: removeSpawnWorktreeExactAsync,
};
