import { BroodClient, BroodNotFoundError } from "../../../brood/service/client.js";
import type { RegisterSessionInput, SessionRecord } from "../../../brood/service/types.js";

/**
 * The legate loop's seam to Brood — the session-state + teardown authority
 * (Balexda/March#164). Brood runs as a service, so this calls it over HTTP via
 * the async {@link BroodClient} (set `MARCH_BROOD_URL`). The client is injectable
 * so handlers/tests don't hit the network.
 */

/** Minimal slice of {@link BroodClient} these helpers use — lets tests stub it. */
export interface BroodSeam {
  teardown(
    id: string,
    request?: { force?: boolean; kill?: boolean; reason?: string },
  ): Promise<{ id: string; status: string; warnings?: string[] }>;
  list(filter?: { kind?: SessionRecord["kind"]; status?: SessionRecord["status"] }): Promise<SessionRecord[]>;
  register(input: RegisterSessionInput): Promise<SessionRecord>;
}

let _client: BroodClient | undefined;
function defaultClient(): BroodClient {
  return (_client ??= new BroodClient());
}

export interface BroodTeardownOptions {
  readonly force?: boolean;
  readonly kill?: boolean;
  readonly reason?: string;
}

export interface BroodTeardownResult {
  /** Teardown confirmed (HTTP 200). */
  readonly ok: boolean;
  /**
   * Brood has no record of the session (HTTP 404). NOT success: the caller should
   * defer + retry rather than archive over an orphaned steward/worktree (#155).
   */
  readonly notTracked: boolean;
  readonly detail: string;
}

function summarizeTeardown(res: { id: string; status: string; warnings?: string[] }): string {
  const warn = res.warnings && res.warnings.length > 0 ? ` (warnings: ${res.warnings.join("; ")})` : "";
  return `teardown ${res.id}: ${res.status}${warn}`;
}

/**
 * Request teardown of a session via Brood. Returns `ok:true` only on a confirmed
 * teardown; a 404 (not-tracked) or any transport/server error yields `ok:false`
 * so cleanup defers instead of archiving over an orphan.
 */
export async function broodTeardown(
  sessionId: string,
  opts: BroodTeardownOptions = {},
  client: BroodSeam = defaultClient(),
): Promise<BroodTeardownResult> {
  try {
    const res = await client.teardown(sessionId, { force: opts.force, kill: opts.kill, reason: opts.reason });
    return { ok: true, notTracked: false, detail: summarizeTeardown(res) };
  } catch (err) {
    if (err instanceof BroodNotFoundError) {
      return { ok: false, notTracked: true, detail: err.message };
    }
    return { ok: false, notTracked: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export interface BroodRegisterResult {
  /** The session is now in Brood's registry (idempotent upsert succeeded). */
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Back-fill a live-but-untracked session into Brood's registry. Used to
 * reconcile an orphaned steward (one Brood never learned about — predating or
 * bypassing the Hatchery push, #218) from the Castra observation so Brood owns
 * its teardown by exact path (#155, #225). Idempotent (Brood upserts on `id`);
 * any failure yields `ok:false` so the caller can defer rather than archive over
 * an orphan it couldn't register.
 */
export async function broodRegister(
  input: RegisterSessionInput,
  client: BroodSeam = defaultClient(),
): Promise<BroodRegisterResult> {
  try {
    const rec = await client.register(input);
    return { ok: true, detail: `registered ${rec.id} (${rec.kind})` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List the sessions Brood tracks. Returns `[]` on any failure (the caller falls
 * back to its other state sources).
 */
export async function broodListSessions(
  filter: { kind?: SessionRecord["kind"]; status?: SessionRecord["status"] } = {},
  client: BroodSeam = defaultClient(),
): Promise<SessionRecord[]> {
  try {
    return await client.list(filter);
  } catch {
    return [];
  }
}
