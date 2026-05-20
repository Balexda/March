import { execText } from "./exec.js";

/**
 * Smithy client. `--pending` (= --status in-progress,not-started) filters out
 * done records up front; layer 0 of the returned graph still means "ready to
 * dispatch now". I/O seam — the pure readiness/dependency reasoning over the
 * returned status lives in pure/smithy-graph.ts.
 */
export function readSmithyStatus(repoPath: string): any {
  const out = execText("smithy", ["status", "--format", "json", "--pending"], { cwd: repoPath });
  return JSON.parse(out);
}
