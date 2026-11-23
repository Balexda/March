/**
 * Low-cardinality reason codes for a failed Hatchery spawn dispatch.
 *
 * The code is a metric label (`march_hatchery_dispatches_total{reason}`), the
 * `/readyz` `spawns.last_error`, and what the legate surfaces in its judgement
 * log line — so it must stay a small, bounded vocabulary. Never echo raw error
 * text: a {@link HatcheryGitHubError} code (`tessera:unconfigured`, …) is passed
 * through (its codes are already a closed protocol set), a handful of known
 * failure classes map to fixed codes, and everything else is `"other"`.
 *
 * Spawns run in a worker thread, so the error the service sees is a plain
 * `Error` carrying only the message — the GitHub code is recovered from the
 * `Hatchery GitHub read failed (<code>)` message shape, not `instanceof`.
 */

/** The success value of the dispatch counter's `reason` label. */
export const DISPATCH_REASON_NONE = "none";

const GITHUB_CODE = /Hatchery GitHub read failed \(([a-z0-9_:-]{1,64})\)/i;

const FIXED: ReadonlyArray<readonly [RegExp, string]> = [
  [/spawn worker exited/i, "worker_exit"],
  [/already exists in index|corrupt patch|patch does not apply|git apply/i, "patch_apply_failed"],
  [/branch .*already exists|already exists.*branch|already checked out/i, "branch_collision"],
  [/castra/i, "castra_error"],
  [/docker/i, "docker_error"],
  [/timed out|timeout/i, "timeout"],
];

/** Extract the Hatchery GitHub code from error text, if it carries one. */
export function hatcheryGitHubCode(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const match = GITHUB_CODE.exec(text);
  return match ? match[1].toLowerCase() : undefined;
}

/** Map a dispatch error (Error, string, or anything) to its bounded reason code. */
export function dispatchReasonCode(err: unknown): string {
  const code = (err as { name?: unknown; code?: unknown } | null)?.name === "HatcheryGitHubError"
    && typeof (err as { code?: unknown }).code === "string"
    ? ((err as { code: string }).code)
    : undefined;
  if (code && /^[a-z0-9_:-]{1,64}$/i.test(code)) return code.toLowerCase();
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const fromText = hatcheryGitHubCode(text);
  if (fromText) return fromText;
  for (const [pattern, reason] of FIXED) if (pattern.test(text)) return reason;
  return "other";
}
