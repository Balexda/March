/**
 * Castra wire types and error model.
 *
 * Castra ("the legion's fortified camp") is the March service that owns the one
 * tmux server / agent-deck install and exposes an HTTP API over it. These types
 * are the JSON shapes that cross the API boundary plus the typed errors the
 * adapter throws so the HTTP layer can map each to the right status code.
 */

/**
 * An interactive session as surfaced over the Castra API. Mirrors the
 * snapshot agent-deck reports for a session (the shape used internally by the
 * Hatchery handoff path), narrowed to the fields consumers need.
 */
export interface CastraSession {
  readonly sessionId: string;
  readonly title: string;
  readonly group: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly createdAt: string;
  /**
   * agent-deck's session lifecycle status (waiting/running/idle/error/stopped/…).
   * Consumers like the legate loop's babysit logic gate behavior on it; `""` when
   * agent-deck doesn't report one.
   */
  readonly status: string;
  /**
   * Queryable session metadata stamped at launch (#214) — at minimum `sliceId`,
   * plus `spawnId`. Castra owns this map (agent-deck has no arbitrary-metadata
   * store), populated at launch and re-attached on `list`/`show`, so Herald's
   * pull path can reconcile a session to its slice by exact id rather than the
   * brittle worktree/title heuristic. Absent for sessions launched without it.
   */
  readonly metadata?: Record<string, string>;
}

/** Stable error codes returned in the API error envelope. */
export type CastraErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "agent_deck_error"
  | "internal";

/** Uniform error envelope returned on every non-2xx response. */
export interface CastraErrorBody {
  readonly error: {
    readonly code: CastraErrorCode;
    readonly message: string;
  };
}

/**
 * agent-deck exited non-zero (or produced unparseable output) for a reason that
 * isn't a missing session or a launch race. Maps to HTTP 502.
 */
export class CastraAgentDeckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastraAgentDeckError";
  }
}

/** The requested session does not exist. Maps to HTTP 404. */
export class CastraNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastraNotFoundError";
  }
}

/**
 * A launch attached to (or would attach to) the wrong worktree — the
 * concurrent-launch race guarded against in the Hatchery handoff path. Maps to
 * HTTP 409 so the caller can re-dispatch on the next tick rather than treating
 * it as a hard failure.
 */
export class CastraConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastraConflictError";
  }
}

/** A request was malformed (bad field, invalid profile/id). Maps to HTTP 400. */
export class CastraValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastraValidationError";
  }
}
