/**
 * Profile registry types. A *profile* is one March deployment unit: a repo + the
 * agent-deck namespace its sessions run under. Herald is the source of truth for
 * which profiles exist (the observer and the legate both iterate them), so the
 * registry is the per-profile subset of what used to live in `legate-loop-meta.json`.
 *
 * The registry is deliberately a self-contained module (its own store, routes,
 * client, and sqlite file) so it can later be lifted into a standalone "profile
 * service" without untangling it from the event log.
 */

import type { MergePolicy } from "./merge-policy.js";

/** Lifecycle status. `removed` is a soft-delete: the observer/legate stop
 *  iterating it, but its event history stays foldable. */
export type ProfileStatus = "active" | "removed";

/** A registered profile — the unit the observer + legate iterate over. */
export interface ProfileRecord {
  /** agent-deck profile name (the primary key). */
  readonly profile: string;
  readonly repoName: string;
  readonly repoPath: string;
  readonly workerGroup: string;
  /** Paired legate-agent conductor name (for doorbell / judgement routing). */
  readonly conductorName?: string;
  /** Brood service endpoint frozen at registration (null = unconfigured). */
  readonly broodEndpoint?: string | null;
  /** Path to the march CLI on the host (null = resolve from PATH). */
  readonly marchCliPath?: string | null;
  readonly mode?: string;
  /** Per-task-type override of the human-review merge gates (undefined = all required). */
  readonly mergePolicy?: MergePolicy;
  /**
   * Worker toolchain selection for this profile's spawns (issue #287). One of
   * `auto` (default — detect the stack from repo markers), `node`, or `jvm`.
   * Resolves the spawn's base image to `f(agent, toolchain)` so non-node repos
   * (e.g. Kotlin/Gradle) can build in-container. Undefined = `auto`.
   */
  readonly toolchain?: string;
  /**
   * Dispatch priority: the order the shared Legate service allocates the global
   * spawn budget across profiles each tick. **Lower wins** — priority 0 dispatches
   * first and consumes budget before higher numbers (so P0 = 0, P1 = 1, P2 = 2).
   * Undefined falls back to {@link DEFAULT_PROFILE_PRIORITY} (sorts last). Ties
   * break by profile name for a deterministic order.
   */
  readonly priority?: number;
  readonly status: ProfileStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Priority assigned to a profile that has none set — sorts after every explicit
 *  priority, so configuring even one profile's priority doesn't starve the rest. */
export const DEFAULT_PROFILE_PRIORITY = 100;

/** A profile's effective dispatch priority (lower = higher priority). */
export function profilePriority(p: { readonly priority?: number }): number {
  return typeof p.priority === "number" && Number.isFinite(p.priority)
    ? p.priority
    : DEFAULT_PROFILE_PRIORITY;
}

/** Compare profiles for dispatch order: priority ascending, then name ascending. */
export function byDispatchPriority(
  a: { readonly priority?: number; readonly profile: string },
  b: { readonly priority?: number; readonly profile: string },
): number {
  return profilePriority(a) - profilePriority(b) || a.profile.localeCompare(b.profile);
}

/** What a caller hands to {@link ProfileStore.register} (upsert). */
export interface RegisterProfileInput {
  readonly profile: string;
  readonly repoName: string;
  readonly repoPath: string;
  readonly workerGroup: string;
  readonly conductorName?: string;
  readonly broodEndpoint?: string | null;
  readonly marchCliPath?: string | null;
  readonly mode?: string;
  readonly mergePolicy?: MergePolicy;
  /** Worker toolchain selection (issue #287): `auto` (default) | `node` | `jvm`. */
  readonly toolchain?: string;
  /** Dispatch priority (lower wins); preserve-on-omit on re-register. */
  readonly priority?: number;
  readonly status?: ProfileStatus;
}

export interface ProfileStoreOptions {
  /** Home directory override (defaults to `os.homedir()`). */
  readonly homeDir?: string;
  /** Explicit db path (e.g. `":memory:"` for tests). Overrides `homeDir`. */
  readonly dbPath?: string;
}

/** Options for {@link ProfileStore.list}. */
export interface ListProfilesOptions {
  /** Include soft-removed profiles (default: active only). */
  readonly includeRemoved?: boolean;
}
