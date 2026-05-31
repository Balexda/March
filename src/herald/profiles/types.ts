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
  readonly status: ProfileStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
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
