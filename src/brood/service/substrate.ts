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
   * Reclaim the spawn's container. Idempotent and best-effort — a missing
   * container is a successful no-op. Throwing surfaces a failed `container`
   * step; teardown continues to the later steps regardless.
   */
  removeContainer(spawnId: string): void;

  /**
   * Reclaim the spawn's checkout by EXACT identifier — worktree path and/or
   * branch. Implementations MUST NOT enumerate or prune other checkouts: brood
   * removes only the exact tracked path it was handed, never a blanket
   * `git worktree prune` (issue #155). Returns per-target flags rather than
   * throwing.
   */
  removeWorktreeExact(
    repoRoot: string,
    target: { worktreePath?: string; branch?: string },
  ): RemoveWorktreeResult;
}

/**
 * Default substrate: the shared host running brood. Container reclamation goes
 * through the mounted docker socket (`removeSpawnContainer`); checkout
 * reclamation goes through `removeSpawnWorktreeExact`, which removes ONLY the
 * exact worktree path / branch and NEVER runs `git worktree prune` (#155).
 */
export const hostTeardownSubstrate: TeardownSubstrate = {
  removeContainer: removeSpawnContainer,
  removeWorktreeExact: removeSpawnWorktreeExact,
};

// Extension point (SaaS readiness, #166): provide an alternative
// `TeardownSubstrate` whose `removeContainer` calls an orchestrator API
// (k8s/Nomad/Fargate) and whose `removeWorktreeExact` destroys an ephemeral
// per-execution environment/volume, then inject it via `TeardownDeps.substrate`.
// The exact-path / never-prune contract on `removeWorktreeExact` (#155) binds
// every implementation. No real orchestrator adapter ships yet:
//
//   export function createOrchestratorSubstrate(
//     opts: OrchestratorSubstrateOptions,
//   ): TeardownSubstrate { ... }
