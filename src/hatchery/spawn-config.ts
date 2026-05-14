/**
 * Centralised spawn-time configuration constants shared across the dispatch
 * pipeline. Modules from later stages (snapshot build, container launch)
 * import {@link SPAWN_CONFIG} from here so future Feature 3 / Feature 4
 * refactors only need to change a single location.
 *
 * Scope of this module:
 * - {@link SpawnConfig} / {@link SPAWN_CONFIG} — the hardcoded container
 *   security and resource posture consumed by Stage 4 (Launch) and Stage
 *   6 (Wait). This is the single auditable source of truth: every value
 *   defined here is surfaced to the dispatch pipeline at the stage that
 *   owns it. Stage 4 surfaces `capDrop`, `user`, `memoryLimit`,
 *   `cpuLimit`, and `networkMode` as `docker create` flags.
 *   Stage 6 (owned by Story 7) enforces `timeoutSeconds` against the
 *   running container's wall clock.
 *
 * Out of scope (lives elsewhere):
 * - The `SpawnBackend` polymorphic interface — that lives in `src/spawn/`
 *   because it controls runtime entrypoints and backend-specific auth.
 * - Per-backend defaults and configurable security profiles — Hatchery
 *   (M2) makes these editable per profile.
 *
 * Network policy: Feature 4 (Spawn Sandbox Security) owns network-policy
 * hardening. The default Docker `bridge` network used here is a
 * deliberately known gap left for Feature 4 to address against the RFC's
 * Appendix A threat model.
 */

/** Default base image retained for direct Dockerfile helper calls. */
export const BASE_IMAGE = "march-spawn-claude:latest";

/**
 * Shape of the hardcoded container security and resource configuration
 * applied to every spawn launched by Feature 2. Field names and validation
 * rules mirror the data-model SpawnConfig entity verbatim.
 *
 * Hatchery (M2) replaces this compile-time constant with declarative,
 * editable per-profile configuration. Feature 4 audits the values against
 * the RFC's Appendix A threat model and may tighten them.
 */
export interface SpawnConfig {
  /** Linux capabilities to drop. Always includes `"ALL"` per AS 5.1. */
  readonly capDrop: readonly string[];
  /**
   * Non-root user identifier inside the container. Either a username
   * (e.g. `"march"`) or a numeric `uid:gid` pair (e.g. `"1000:1000"`).
   */
  readonly user: string;
  /** Docker network mode. `"bridge"` for Feature 2; Feature 4 hardens. */
  readonly networkMode: string;
  /** Container memory limit, in Docker's `<size><b|k|m|g>` format. */
  readonly memoryLimit: string;
  /** Container CPU limit, as a positive number formatted as a string. */
  readonly cpuLimit: string;
  /** Maximum execution time before the container is killed, in seconds. */
  readonly timeoutSeconds: number;
}

/**
 * The single, auditable hardcoded SpawnConfig consumed by the dispatch
 * pipeline. No other module should hardcode any of these values; every
 * field is sourced from this constant at the stage that owns it.
 *
 * Values come verbatim from the data-model SpawnConfig entity examples
 * (see `spawn-dispatch.data-model.md`):
 * - `capDrop: ["ALL"]` — Stage 4 emits one `--cap-drop=<cap>` per entry
 *   (AS 5.1).
 * - `user: "march"` — Stage 4 passes `--user`; non-root, matches the
 *   `--chown=march:march` baked into the generated Dockerfile by
 *   `writeSpawnDockerfile` (AS 5.2).
 * - `networkMode: "bridge"` — Stage 4 passes `--network`; default Docker
 *   bridge, Feature 4 owns network-policy hardening, the bridge gap is
 *   intentional (AS 5.5).
 * - `memoryLimit: "4g"`, `cpuLimit: "2"` — Stage 4 passes `--memory` and
 *   `--cpus`; hardcoded resource ceilings sized for typical Claude Code
 *   sessions (AS 5.3).
 * - `timeoutSeconds: 3600` — Stage 6 (Wait) enforces this against the
 *   running container's wall clock.
 */
export const SPAWN_CONFIG: SpawnConfig = {
  capDrop: ["ALL"],
  user: "march",
  networkMode: "bridge",
  memoryLimit: "4g",
  cpuLimit: "2",
  timeoutSeconds: 3600,
};
