/**
 * Centralised spawn-time configuration constants shared across the dispatch
 * pipeline. Modules from later stages (snapshot build, container launch)
 * import the base image tag and {@link SPAWN_CONFIG} from here so future
 * Feature 3 / Feature 4 refactors only need to change a single location.
 *
 * Scope of this module:
 * - {@link BASE_IMAGE} — the tagged base container image with the backend
 *   CLI pre-installed.
 * - {@link SpawnConfig} / {@link SPAWN_CONFIG} — the hardcoded container
 *   security and resource posture consumed by Stage 4 (Launch) and Stage
 *   6 (Wait). This is the single auditable source of truth: every value
 *   defined here is surfaced to the dispatch pipeline at the stage that
 *   owns it. Stage 4 surfaces `capDrop`, `user`, `memoryLimit`,
 *   `cpuLimit`, `networkMode`, and `envWhitelist` as `docker run` flags.
 *   Stage 6 (owned by Story 7) enforces `timeoutSeconds` against the
 *   running container's wall clock.
 *
 * - {@link PROMPT_PATH} — the in-container path where Stage 5 (Handoff)
 *   writes the finalized prompt and where {@link claudeCodeBackend}'s
 *   entrypoint reads it. Single source of truth so the entrypoint command
 *   and the handoff destination cannot drift apart (SD-004 from US6
 *   slice 1).
 * - {@link SpawnBackend} / {@link claudeCodeBackend} — the interface
 *   boundary Feature 3 polymorphically extends, plus Feature 2's single
 *   hardcoded Claude Code implementation. Verbatim from the contracts'
 *   SpawnBackend Interface and Claude Code Implementation sections.
 *
 * Out of scope (lives elsewhere):
 * - Per-backend defaults and configurable security profiles — Hatchery
 *   (M2) makes these editable per profile.
 * - The Stage 5 handoff helper itself that writes the finalized prompt
 *   into the running container at {@link PROMPT_PATH} — that lands in
 *   Task 4 of this same slice.
 *
 * Network policy: Feature 4 (Spawn Sandbox Security) owns network-policy
 * hardening. The default Docker `bridge` network used here is a
 * deliberately known gap left for Feature 4 to address against the RFC's
 * Appendix A threat model.
 */

/**
 * Tagged base container image with the backend CLI pre-installed.
 *
 * Consumed by:
 * - `src/cli.ts` dispatch action — passes this to `checkSpawnDependencies`
 *   so the dispatch fails fast if the image is unavailable.
 * - `src/snapshot-build.ts` — used as the `FROM` line of the generated
 *   Dockerfile per the Image Build contract.
 *
 * Will eventually be derived from `SpawnBackend.baseImage` once Feature 3
 * lands the polymorphic backend selection mechanism; until then the
 * Claude Code default is hardcoded here so all consumers agree on a single
 * source of truth.
 */
export const BASE_IMAGE = "march-base:latest";

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
  /**
   * Environment variable names allowed to pass into the container. For
   * Feature 2 this is the backend-specific auth key only — pass-through
   * form, no inlined values (Docker reads each value from the operator's
   * environment at launch time).
   */
  readonly envWhitelist: readonly string[];
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
 *   running container's wall clock; Story 7 owns the enforcement.
 * - `envWhitelist: ["ANTHROPIC_API_KEY"]` — Stage 4 emits one `-e VAR`
 *   passthrough flag per entry; only the backend's auth key is forwarded
 *   into the sandbox (AS 5.4).
 */
export const SPAWN_CONFIG: SpawnConfig = {
  capDrop: ["ALL"],
  user: "march",
  networkMode: "bridge",
  memoryLimit: "4g",
  cpuLimit: "2",
  timeoutSeconds: 3600,
  envWhitelist: ["ANTHROPIC_API_KEY"],
};

/**
 * In-container path where the finalized prompt is written by the Stage 5
 * handoff helper and read by {@link claudeCodeBackend}'s entrypoint via
 * `$(cat ...)` shell expansion. Single source of truth so the entrypoint
 * command and the handoff destination cannot drift apart (SD-004 from US6
 * slice 1).
 *
 * Out of scope per the Feature 2 contract: the prompt is NOT baked into
 * the image — it is delivered to the running container at Stage 5. The
 * Dockerfile template in `snapshot-build.ts` (`FROM` / `COPY` / `WORKDIR`)
 * and the `createBuildContext` output in `snapshot.ts` remain untouched.
 */
export const PROMPT_PATH = "/march/prompt.txt";

/**
 * Interface boundary defining how Feature 2 invokes an AI backend inside a
 * spawn container. Feature 2 ships a single hardcoded implementation
 * ({@link claudeCodeBackend}); Feature 3 introduces polymorphic backend
 * selection (Gemini + a selection mechanism) by replacing the hardcoded
 * import in the dispatch action with a registry lookup keyed on a CLI flag
 * or configuration.
 *
 * Shape comes verbatim from `spawn-dispatch.contracts.md` →
 * "SpawnBackend Interface".
 */
export interface SpawnBackend {
  /** Backend identifier (e.g. `"claude-code"`, `"gemini"`). */
  readonly name: string;
  /** Base Docker image tag that has this backend CLI pre-installed. */
  readonly baseImage: string;
  /**
   * Environment variable names the backend requires (e.g.
   * `"ANTHROPIC_API_KEY"`). Story 5's Stage 4 Launch will source the
   * `-e VAR` passthrough flags from this list once Feature 3 lands the
   * polymorphic backend selection mechanism; for Feature 2 the values
   * mirror {@link SpawnConfig.envWhitelist}.
   */
  readonly requiredEnvVars: readonly string[];
  /**
   * Constructs the container entrypoint command. Returns the argv array
   * docker should exec inside the container. Because Docker's exec form
   * does not invoke a shell, this returns an explicit `sh -c` wrapper when
   * shell expansion (e.g. `$(cat ...)`) is required.
   *
   * @param promptFilePath - In-container path to the finalized prompt file
   *   that the Stage 5 handoff helper has written. Typically
   *   {@link PROMPT_PATH}.
   * @returns argv array suitable for passing positionally to `docker run`.
   */
  buildEntrypoint(promptFilePath: string): string[];
}

/**
 * Hardcoded Claude Code backend used by Feature 2. The single source of
 * truth for the entrypoint command — verbatim from
 * `spawn-dispatch.contracts.md` → "Claude Code Implementation (Feature 2)".
 *
 * The shell wrapper (`sh -c`) is required because Docker's exec form does
 * not invoke a shell, and the entrypoint relies on `$(cat ...)` shell
 * expansion to inline the prompt without exposing it on the argv (which
 * would otherwise show up in `docker inspect` output and process listings
 * inside the container).
 *
 * Feature 3 will:
 *   1. Add a Gemini implementation with its own `buildEntrypoint` and
 *      `requiredEnvVars`.
 *   2. Add a backend selection mechanism (CLI flag or configuration).
 *   3. May extend {@link SpawnBackend} with additional methods (e.g.,
 *      `parseExitCode`, `validateAuth`).
 */
export const claudeCodeBackend: SpawnBackend = {
  name: "claude-code",
  baseImage: BASE_IMAGE,
  requiredEnvVars: ["ANTHROPIC_API_KEY"],
  buildEntrypoint(promptFilePath: string): string[] {
    return [
      "sh",
      "-c",
      `claude -p "$(cat ${promptFilePath})" --output-format json --dangerously-skip-permissions --bare --no-session-persistence`,
    ];
  },
};
