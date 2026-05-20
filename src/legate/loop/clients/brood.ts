import { execFileSync } from "node:child_process";
import type { SessionRecord } from "../../../brood/service/types.js";

/**
 * The legate loop's seam to Brood — the session-state + teardown authority
 * (Balexda/March#164). The loop's tick is synchronous, and #164 designed the
 * loop→Brood path as the `march brood` CLI (the baked-in `march` shells to the
 * BroodClient which hits the service), so this wraps `march brood teardown|list`
 * via execFileSync rather than introducing a sync HTTP client.
 *
 * The runner is injectable so handlers/tests don't shell out for real.
 */

export interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CliRunner = (args: string[]) => CliResult;

/** Default runner: invoke the baked-in `march` CLI, capturing exit + streams. */
export const defaultMarchRunner: CliRunner = (args) => {
  try {
    const stdout = execFileSync("march", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : e.message ?? "",
    };
  }
};

export interface BroodTeardownOptions {
  readonly force?: boolean;
  readonly kill?: boolean;
  readonly reason?: string;
}

export interface BroodTeardownResult {
  /** Teardown confirmed (CLI exit 0). */
  readonly ok: boolean;
  /**
   * Brood has no record of the session (CLI 404). NOT success: the caller should
   * defer + retry rather than archive over an orphaned steward/worktree.
   */
  readonly notTracked: boolean;
  readonly detail: string;
}

/**
 * Request teardown of a session via `march brood teardown <id>`. Returns
 * `ok:true` only on a confirmed teardown; a non-zero exit (incl. the 404
 * "not tracked") yields `ok:false` so cleanup defers instead of archiving.
 */
export function broodTeardown(
  sessionId: string,
  opts: BroodTeardownOptions = {},
  run: CliRunner = defaultMarchRunner,
): BroodTeardownResult {
  const args = ["brood", "teardown", sessionId];
  if (opts.force) args.push("--force");
  if (opts.kill) args.push("--kill");
  if (opts.reason) args.push("--reason", opts.reason);
  const res = run(args);
  if (res.status === 0) {
    return { ok: true, notTracked: false, detail: res.stdout.trim() };
  }
  const detail = (res.stderr || res.stdout || "").trim();
  return { ok: false, notTracked: /not tracked by Brood/i.test(detail), detail };
}

export interface BroodListFilter {
  readonly kind?: SessionRecord["kind"];
  readonly status?: SessionRecord["status"];
}

/**
 * List the sessions Brood tracks via `march brood list --json`. Returns `[]` on
 * any failure (the caller falls back to its other state sources).
 */
export function broodListSessions(
  filter: BroodListFilter = {},
  run: CliRunner = defaultMarchRunner,
): SessionRecord[] {
  const args = ["brood", "list", "--json"];
  if (filter.kind) args.push("--kind", filter.kind);
  if (filter.status) args.push("--status", filter.status);
  const res = run(args);
  if (res.status !== 0 || !res.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? (parsed as SessionRecord[]) : [];
  } catch {
    return [];
  }
}
