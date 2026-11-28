/**
 * Low-cardinality reason codes for a failed Hatchery spawn dispatch.
 *
 * The code is a metric label (`march_hatchery_dispatches_total{reason}`), the
 * `/readyz` `spawns.last_error`, and what the legate surfaces in its judgement
 * log line — so it must stay a small, bounded vocabulary. Never echo raw error
 * text: a {@link HatcheryGitHubError} code (`tessera:unconfigured`, …) is passed
 * through only when it is one of the known codes below (an unknown one is
 * `"other"`), a handful of known failure classes map to fixed codes, and
 * everything else is `"other"`.
 *
 * Spawns run in a worker thread, so the error the service sees is a plain
 * `Error` carrying only the message — the GitHub code is recovered from the
 * `Hatchery GitHub read failed (<code>)` message shape, not `instanceof`.
 */

/** The success value of the dispatch counter's `reason` label. */
export const DISPATCH_REASON_NONE = "none";

const GITHUB_CODE = /Hatchery GitHub read failed \(([a-z0-9_:-]{1,64})\)/i;

/** Hatchery's own GitHub-read failure codes (`HatcheryGitHubError`). */
const LOCAL_GITHUB_CODES = new Set([
  "branch_lookup_failed", "remote_check_failed", "invalid_pr_lookup", "invalid_repo_lookup", "origin_lookup_failed",
  "unsupported_origin", "incomplete_lookup", "lookup_failed", "fetch_failed",
]);

/** The Tessera client's local codes, plus Tessera's wire protocol codes; carried as `tessera:<code>`. */
const TESSERA_CODES = new Set([
  "unconfigured", "unreachable", "invalid_request", "invalid_response",
  "unauthorized", "policy_denied", "repo_not_installed", "provider_unconfigured", "credential_invalid", "provider_unavailable", "mint_failed",
]);

/** A known GitHub code, lowercased, or undefined: an unknown suffix must not become a new metric label. */
function knownGitHubCode(code: string): string | undefined {
  const lower = code.toLowerCase();
  if (LOCAL_GITHUB_CODES.has(lower)) return lower;
  if (lower.startsWith("tessera:") && TESSERA_CODES.has(lower.slice("tessera:".length))) return lower;
  return undefined;
}

const FIXED: ReadonlyArray<readonly [RegExp, string]> = [
  [/spawn worker exited/i, "worker_exit"],
  // The worker scaffold's "real no-op" (`src/spawn/backends.ts`): exit 3, no commit.
  [/worker produced no commit|Spawn \S+ exited 3;/i, "agent_declined"],
  [/already exists in index|corrupt patch|patch does not apply|git apply/i, "patch_apply_failed"],
  [/branch .*already exists|already exists.*branch|already checked out/i, "branch_collision"],
  [/Steward publication failed \(commit_failed\)/i, "commit_failed"],
  [/Steward publication failed \(push_failed\)/i, "push_failed"],
  [/castra/i, "castra_error"],
  [/docker/i, "docker_error"],
  [/timed out|timeout/i, "timeout"],
];

/** Extract the Hatchery GitHub code from error text, if it carries one. */
export function hatcheryGitHubCode(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const match = GITHUB_CODE.exec(text);
  return match ? knownGitHubCode(match[1]) : undefined;
}

/** Map a dispatch error (Error, string, or anything) to its bounded reason code. */
export function dispatchReasonCode(err: unknown): string {
  const code = (err as { name?: unknown; code?: unknown } | null)?.name === "HatcheryGitHubError"
    && typeof (err as { code?: unknown }).code === "string"
    ? ((err as { code: string }).code)
    : undefined;
  if (code !== undefined) return knownGitHubCode(code) ?? "other";
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (GITHUB_CODE.test(text)) return hatcheryGitHubCode(text) ?? "other";
  for (const [pattern, reason] of FIXED) if (pattern.test(text)) return reason;
  return "other";
}
