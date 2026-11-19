import { KNOWN_TASK_TYPES, resolveMergeRequirements } from "./merge-policy.js";

/**
 * The smithy verb that keys a slice's per-task-type merge policy (e.g. "cut").
 * Tries, in order: the dispatch-time `command`; the fold-durable branch
 * (`smithy/<verb>/…`); the sliceId suffix (`…-<verb>`). Undefined for
 * non-smithy / unrecognized shapes → {@link resolveMergeRequirements} falls back
 * to all-required. Legate's merge gate and metrics share the resolver with
 * Herald's review state projection.
 */
export function taskTypeForSlice(
  sliceId: string,
  slice: { command?: string; actual_branch?: string; branch?: string } | undefined,
): string | undefined {
  const fromCommand = String(slice?.command || "").match(/^smithy\.([a-z0-9_-]+)/i);
  if (fromCommand) return fromCommand[1].toLowerCase();
  const branch = String(slice?.actual_branch || slice?.branch || "");
  const fromBranch = branch.match(/(?:^|\/)smithy\/([a-z0-9_-]+)\//i);
  if (fromBranch) return fromBranch[1].toLowerCase();
  const id = sliceId.toLowerCase();
  return KNOWN_TASK_TYPES.find((verb) => id.endsWith(`-${verb}`));
}
