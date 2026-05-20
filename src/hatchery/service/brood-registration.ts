import { loadSpawnRecord } from "../../brood/spawn-record.js";
import { BroodClient, broodConfigured } from "../../brood/service/client.js";
import type { HatcherySpawnResult } from "../spawn-handoff.js";
import type { SpawnRequest } from "./types.js";

export interface RegisterSpawnDeps {
  /** Override the client (tests). */
  readonly client?: BroodClient;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly warn?: (message: string) => void;
}

/**
 * Register a completed spawn and its steward with Brood so the registry — not
 * the legate loop — owns their teardown. Best-effort and gated on
 * `MARCH_BROOD_URL`: when brood is unconfigured or unreachable this is a no-op
 * (a warning, no throw), because the JSON SpawnRecord remains the durable
 * within-process state and a missing registry must never fail a dispatch.
 */
export async function registerSpawnWithBrood(
  result: HatcherySpawnResult,
  request: SpawnRequest,
  deps: RegisterSpawnDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  if (!deps.client && !broodConfigured(env)) return;
  const client = deps.client ?? new BroodClient({ env });
  const warn = deps.warn ?? ((message) => process.stderr.write(`${message}\n`));

  try {
    const record = loadSpawnRecord(result.spawnId, deps.homeDir);
    const worktreePath = result.managerSession.worktreePath;

    // Spawn row carries the canonical container/worktree/branch for teardown.
    await client.register({
      id: result.spawnId,
      kind: "spawn",
      status: record?.status ?? "stopped",
      repoPath: request.repoPath,
      branch: result.branch,
      worktreePath,
      containerId: record?.containerId,
      backend: request.backend,
      imageId: record?.imageId,
      exitCode: record?.exitCode,
      failureReason: record?.failureReason,
    });

    // Steward row links back to the spawn and carries the agent-deck handle.
    await client.register({
      id: result.managerSession.sessionId,
      kind: "steward",
      parentId: result.spawnId,
      agentDeckSessionId: result.managerSession.sessionId,
      profile: request.agentDeckProfile,
      group: request.managerGroup,
      status: "running",
      repoPath: request.repoPath,
      branch: result.branch,
      worktreePath,
    });
  } catch (err) {
    warn(
      `brood registration failed for spawn ${result.spawnId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
