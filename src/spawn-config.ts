/**
 * Centralised spawn-time configuration constants shared across the dispatch
 * pipeline. Modules from later stages (snapshot build, container launch)
 * import the base image tag from here so future Story 3 / Feature 3
 * refactors only need to change a single location.
 *
 * Today this is a small file with a single constant; over time it will grow
 * to hold the SpawnBackend interface's hardcoded Claude Code defaults
 * (memory/CPU limits, env-var allowlists) per the Spawn Dispatch contracts.
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
