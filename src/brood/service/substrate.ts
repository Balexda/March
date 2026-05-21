import { removeSpawnContainer } from "../../spawn/container-launch.js";
import {
  removeSpawnWorktreeExact,
  type RemoveWorktreeResult,
} from "../worktree.js";

/**
 * Substrate adapter for brood teardown — the substrate-specific call-outs that
 * reclaim a session's compute + checkout (issue #169, part of #166).
 *
 * Brood owns the teardown *contract* (the fixed, idempotent, best-effort step
 * order in `teardown.ts`); this seam isolates *how* each resource is reclaimed
 * so the substrate can be swapped without touching that contract. It mirrors the
 * Castra-client seam already used for steward removal: a named interface plus a
 * default host implementation, injected through `TeardownDeps`.
 *
 *   - container: the mounted host docker socket today → an orchestrator API
 *     (k8s/Nomad/Fargate) in a SaaS deployment.
 *   - worktree/branch: a shared-host git worktree today → an ephemeral
 *     per-execution environment/volume in a SaaS deployment.
 *
 * Capturing logs + a record snapshot (the *archive* step) is intentionally NOT
 * part of this seam — moving the archive destination to object storage is issue
 * #168, so it stays a separate dep on `TeardownDeps`.
 */
export interface TeardownSubstrate {
  /**
   * Reclaim the spawn's compute — the running container on the host today, a
   * pod/task on an orchestrator in a SaaS deployment (the substrate detail is
   * abstracted away). Idempotent and best-effort — a missing instance is a
   * successful no-op. An implementation MAY throw to signal a real failure (e.g.
   * an orchestrator API rejecting the delete), which teardown records as a
   * failed `container` step before continuing to the later steps; a non-throwing
   * implementation (see {@link hostTeardownSubstrate}) cannot surface its
   * failures this way, so the step reflects "removal attempted" rather than
   * "removal verified".
   */
  removeSpawn(spawnId: string): void;

  /**
   * Reclaim the spawn's workspace by EXACT identifier — the host worktree path
   * and/or branch today, an ephemeral per-execution environment/volume in a
   * SaaS deployment. Implementations MUST NOT enumerate or prune other
   * workspaces: brood removes only the exact tracked path it was handed, never a
   * blanket `git worktree prune` (issue #155). Returns per-target flags rather
   * than throwing.
   */
  removeWorkspace(
    repoRoot: string,
    target: { worktreePath?: string; branch?: string },
  ): RemoveWorktreeResult;
}

/**
 * Default substrate: the shared host running brood. Container reclamation goes
 * through the mounted docker socket (`removeSpawnContainer`); checkout
 * reclamation goes through `removeSpawnWorktreeExact`, which removes ONLY the
 * exact worktree path / branch and NEVER runs `git worktree prune` (#155).
 *
 * Caveat: `removeSpawnContainer` is non-throwing by contract — it swallows
 * every docker failure (daemon down, permissions, "no such container") rather
 * than throwing. So with this substrate the teardown `container` step always
 * reports `ok` ("removal attempted"); a host-side docker failure is NOT
 * observable via the step outcome and must be diagnosed out of band (e.g.
 * `docker ps -a`). A substrate that needs failures surfaced as a failed step
 * (e.g. an orchestrator adapter) should throw from `removeSpawn` instead.
 */
export const hostTeardownSubstrate: TeardownSubstrate = {
  removeSpawn: removeSpawnContainer,
  removeWorkspace: removeSpawnWorktreeExact,
};

// Extension point (SaaS readiness, #166): provide an alternative
// `TeardownSubstrate` whose `removeSpawn` calls an orchestrator API
// (k8s/Nomad/Fargate) and whose `removeWorkspace` destroys an ephemeral
// per-execution environment/volume, then inject it via `TeardownDeps.substrate`.
// The exact-path / never-prune contract on `removeWorkspace` (#155) binds
// every implementation. No real orchestrator adapter ships yet:
//
//   export function createOrchestratorSubstrate(
//     opts: OrchestratorSubstrateOptions,
//   ): TeardownSubstrate { ... }
