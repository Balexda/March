import { BroodClient, BroodNotFoundError } from "../../../brood/service/client.js";
import type { RegisterSessionInput, SessionRecord, UpdateSessionInput } from "../../../brood/service/types.js";
import {
  buildTraceparent,
  spanIdForDispatch,
  traceIdForDispatch,
} from "../../../observability/trace-ids.js";

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
  update(id: string, changes: UpdateSessionInput): Promise<SessionRecord>;
}

let _client: BroodClient | undefined;
function defaultClient(): BroodClient {
  return (_client ??= new BroodClient());
}

export interface BroodTeardownOptions {
  readonly force?: boolean;
  readonly kill?: boolean;
  readonly reason?: string;
  /**
   * Trace key identifying the trace this teardown belongs to — the slice id for a
   * terminal-PR cleanup, the session id for a ghost-steward cleanup. Translated to
   * a W3C `traceparent` (via the deterministic per-key ids shared across
   * processes, AGENTS.md) so brood.teardown's spans nest under the same trace as
   * the legate.cleanup / legate.ghost-cleanup action span instead of orphaning a
   * root (#234). Ignored when `traceparent` is set directly.
   */
  readonly traceKey?: string;
  /** Explicit W3C traceparent; wins over {@link traceKey} when both are present. */
  readonly traceparent?: string;
}

/**
 * Resolve the W3C traceparent for a teardown: an explicit `traceparent` wins,
 * else it is derived from `traceKey` using the same deterministic trace/span ids
 * (`traceIdForDispatch` / `spanIdForDispatch`) that the loop's action spans and
 * the dispatch path's castra.launch use, so brood.teardown joins the slice's
 * trace under its dispatch anchor (#234). Returns undefined when neither is set.
 */
function teardownTraceparent(opts: BroodTeardownOptions): string | undefined {
  if (opts.traceparent) return opts.traceparent;
  if (opts.traceKey) {
    return buildTraceparent(
      traceIdForDispatch(opts.traceKey),
      spanIdForDispatch(opts.traceKey),
    );
  }
  return undefined;
}

/**
 * Pick the Brood client for a teardown: a fresh traceparent-bearing client when
 * the caller supplied a trace key/parent (so brood's spans join the trace), else
 * the shared default client. A caller-injected client (tests) always wins.
 */
function teardownClient(opts: BroodTeardownOptions): BroodSeam {
  const traceparent = teardownTraceparent(opts);
  return traceparent ? new BroodClient({ traceparent }) : defaultClient();
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
  client?: BroodSeam,
): Promise<BroodTeardownResult> {
  // Default client carries the slice/session traceparent so brood's teardown
  // spans nest under the action span's trace (#234); a caller-injected client
  // (tests) is used as-is.
  const c = client ?? teardownClient(opts);
  try {
    const res = await c.teardown(sessionId, { force: opts.force, kill: opts.kill, reason: opts.reason });
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

export interface BroodRetireResult {
  /** The prior row is now retired (status torndown) — no longer an active row. */
  readonly ok: boolean;
  /** Brood has no record of the session (HTTP 404) — nothing to retire. */
  readonly notTracked: boolean;
  readonly detail: string;
}

/**
 * Retire a prior steward's Brood row WITHOUT a worktree-pruning teardown (#308).
 * Used on a same-worktree relaunch: the prior session vanished but its tracked
 * worktree is now the LIVE session's, so a teardown — which resolves the steward
 * by exact worktree (#304) — would reap the live one. A status-only PATCH to
 * `torndown` retires the stale duplicate so exactly one ACTIVE row remains for
 * that worktree, never touching the checkout. Idempotent; a 404 means the row is
 * already gone (nothing to retire). Best-effort: any failure yields `ok:false`.
 */
export async function broodRetire(
  sessionId: string,
  client: BroodSeam = defaultClient(),
): Promise<BroodRetireResult> {
  try {
    const rec = await client.update(sessionId, {
      status: "torndown",
      torndownAt: new Date().toISOString(),
    });
    return { ok: true, notTracked: false, detail: `retired ${rec.id} (status ${rec.status})` };
  } catch (err) {
    if (err instanceof BroodNotFoundError) {
      return { ok: false, notTracked: true, detail: err.message };
    }
    return { ok: false, notTracked: false, detail: err instanceof Error ? err.message : String(err) };
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
