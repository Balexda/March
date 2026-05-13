import { CONTAINER_WORKDIR } from "./spawn-config.js";

/**
 * Pure finalization helper for `march spawn dispatch`.
 *
 * Takes the operator's raw prompt (resolved by `resolveRawPrompt` in
 * `prompt-source.ts`) plus the spawn context (spawn ID and container
 * working directory) and returns the finalized prompt string the
 * backend CLI will see via its `-p` flag.
 *
 * The format is pinned by SD-001 of the US6 slice 1 tasks file:
 *
 * ```
 * Spawn ID: <spawnId>
 * Working Directory: <workingDirectory>
 *
 * <rawPrompt verbatim>
 * ```
 *
 * The container working directory is sourced from
 * {@link CONTAINER_WORKDIR} in `spawn-config.ts` — the same constant
 * `writeSpawnDockerfile` uses for the `COPY` destination and `WORKDIR`
 * line — so the Dockerfile and the finalized prompt header cannot
 * drift apart.
 *
 * Out of scope: this module does not write the finalized prompt
 * anywhere (Task 4 owns Stage 5 handoff into the running container)
 * and is not wired into the dispatch action in `src/cli.ts` in this
 * slice — Story 5 owns the wiring that calls `finalizePrompt` and
 * then the Stage 5 handoff helper between Stage 4 Launch and Stage 6
 * Wait.
 */

/**
 * Inputs to {@link finalizePrompt}.
 */
export interface FinalizePromptInput {
  /**
   * Operator's raw prompt (the verbatim string produced by
   * `resolveRawPrompt` from `--prompt-file`, `--prompt`, or stdin).
   * Appears verbatim after the 2-line header and blank separator.
   */
  readonly rawPrompt: string;
  /**
   * SpawnId (e.g. `"20260411-a1b2c3"`). Surfaced in the
   * `Spawn ID: <id>` header line so the backend has the same
   * spawn identifier present in the SpawnRecord, branch name, and
   * image tag — satisfies the spawn-context portion of AS 6.3.
   */
  readonly spawnId: string;
  /**
   * Container working directory referenced in the
   * `Working Directory: <path>` header line. Defaults to
   * {@link CONTAINER_WORKDIR} — production callers always rely on
   * the default so the value cannot drift from the Dockerfile's
   * WORKDIR. Exposed as a parameter purely so the unit tests can
   * pass an arbitrary value to assert the override flows through.
   */
  readonly workingDirectory?: string;
}

/**
 * Build the finalized prompt the backend CLI will receive.
 *
 * Pure: no filesystem, network, or clock side effects beyond its
 * inputs. Composes cleanly with `resolveRawPrompt` (Task 1) and the
 * Stage 5 handoff helper (Task 4) — calling twice with identical
 * input returns the exact same string.
 *
 * Format (verbatim from SD-001):
 *
 * ```
 * Spawn ID: <spawnId>
 * Working Directory: <workingDirectory>
 *
 * <rawPrompt>
 * ```
 *
 * An empty `rawPrompt` still produces the 2-line header plus the
 * blank separator line; the rawPrompt portion is just empty. The
 * helper does NOT trim, escape, or otherwise transform the raw
 * prompt — multiline prompts, leading/trailing whitespace, and
 * shell-special characters all pass through verbatim. (SD-007
 * flags the shell-special concern as a downstream contract
 * question, not a US6 sanitization responsibility.)
 */
export function finalizePrompt(input: FinalizePromptInput): string {
  const workdir = input.workingDirectory ?? CONTAINER_WORKDIR;
  return (
    `Spawn ID: ${input.spawnId}\n` +
    `Working Directory: ${workdir}\n` +
    `\n` +
    input.rawPrompt
  );
}
