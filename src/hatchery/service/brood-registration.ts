import { loadSpawnRecord } from "../../brood/spawn-record.js";
import { BroodClient, broodConfigured } from "../../brood/service/client.js";
import { DEFAULT_AGENT_DECK_PROFILE } from "../defaults.js";
// Type-only import — erased at build time, so it does not reintroduce the
// runtime cycle that moving DEFAULT_AGENT_DECK_PROFILE to `defaults.ts` broke
// (spawn-handoff imports `registerStewardLaunchWithBrood` from this module).
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
 * The canonical container/worktree/branch facts known the moment a steward's
 * Castra session is launched. Mirrors the initial SpawnRecord plus the resolved
 * agent-deck profile/group Hatchery used to launch the steward.
 */
export interface StewardLaunchInput {
  readonly spawnId: string;
  readonly stewardSessionId: string;
  readonly repoPath: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly backend: string;
  /** Resolved agent-deck profile (never the raw optional — teardown needs it). */
  readonly profile: string;
  readonly group: string;
}

/**
 * Register the steward (and a minimal `created` spawn row) with Brood at LAUNCH
 * time — as soon as the Castra session exists — so a spawn that fails mid-launch
 * (image/container build, patch extraction, prompt send) leaves a Brood-trackable
 * steward that teardown/ghost-cleanup can reclaim, instead of an un-cleanable
 * ghost (#172). Idempotent with {@link registerSpawnWithBrood}: both upsert by id
 * and the store merges only defined fields, so the success-time enrich layers
 * containerId/imageId/status/exitCode on top without clobbering or duplicating.
 *
 * Best-effort and gated on `MARCH_BROOD_URL`, exactly like the success path: when
 * brood is unconfigured or unreachable this is a no-op (a warning, never a throw),
 * because the JSON SpawnRecord remains the durable within-process state and a
 * missing registry must never fail a dispatch.
 */
export async function registerStewardLaunchWithBrood(
  input: StewardLaunchInput,
  deps: RegisterSpawnDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  if (!deps.client && !broodConfigured(env)) return;
  const client = deps.client ?? new BroodClient({ env });
  const warn = deps.warn ?? ((message) => process.stderr.write(`${message}\n`));

  try {
    // Spawn row carries the canonical container/worktree/branch for teardown.
    // Status is "created": the container has not been built or started yet.
    await client.register({
      id: input.spawnId,
      kind: "spawn",
      status: "created",
      repoPath: input.repoPath,
      branch: input.branch,
      worktreePath: input.worktreePath,
      backend: input.backend,
    });

    // Steward row links back to the spawn and carries the agent-deck handle so
    // teardown can address `agent-deck -p <profile> ...` (via Castra).
    await client.register({
      id: input.stewardSessionId,
      kind: "steward",
      parentId: input.spawnId,
      agentDeckSessionId: input.stewardSessionId,
      profile: input.profile,
      group: input.group,
      status: "running",
      repoPath: input.repoPath,
      branch: input.branch,
      worktreePath: input.worktreePath,
    });
  } catch (err) {
    warn(
      `brood launch registration failed for spawn ${input.spawnId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Enrich/finalize a SUCCEEDED spawn and its steward in Brood so the registry —
 * not the legate loop — owns their teardown. Runs from the Hatchery service's
 * onSucceeded hook and layers the terminal facts (containerId, imageId, final
 * status, exitCode) on top of the row {@link registerStewardLaunchWithBrood}
 * already wrote at launch. Idempotent: both upsert by id and the store merges
 * only defined fields, so re-registering neither duplicates nor clobbers.
 *
 * Best-effort and gated on `MARCH_BROOD_URL`: when brood is unconfigured or
 * unreachable this is a no-op (a warning, no throw), because the JSON SpawnRecord
 * remains the durable within-process state and a missing registry must never fail
 * a dispatch.
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
    // Record the RESOLVED profile (the same fallback Hatchery used to launch the
    // steward via Castra), not the raw optional — Castra's teardown requires a
    // concrete profile, so a profile-less spawn must still be removable.
    await client.register({
      id: result.managerSession.sessionId,
      kind: "steward",
      parentId: result.spawnId,
      agentDeckSessionId: result.managerSession.sessionId,
      profile: request.agentDeckProfile?.trim() || DEFAULT_AGENT_DECK_PROFILE,
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
