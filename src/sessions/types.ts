/**
 * `march sessions` — unified in-flight view across Brood / Castra / Herald.
 *
 * These are the wire-agnostic shapes the command joins the three services into.
 * A {@link UnifiedSession} is one cross-service *unit of work* — a slice and the
 * spawn/steward/Castra session realizing it — with the divergence between the
 * three sources flagged inline.
 *
 * CRITICAL: this whole subsystem talks ONLY to the service HTTP APIs (Brood,
 * Castra, Herald), so it works from a plain `npm i -g march` install with no
 * source checkout. Nothing here reads repo files, compose files, or the source
 * tree at runtime.
 */

/**
 * Which of the three sources observed this unit of work. The divergence
 * classification is a pure function of this triple plus the Brood record kind.
 */
export interface SessionPresence {
  /** Present in Herald's folded system state (a tracked slice). */
  readonly herald: boolean;
  /** A live Castra/agent-deck session exists. */
  readonly castra: boolean;
  /** An active (non-torndown) Brood spawn/steward record tracks it. */
  readonly brood: boolean;
}

/**
 * Cross-service divergence for one unit of work:
 *   - `castra-only` — live in Castra but untracked in Brood (leak candidate).
 *   - `brood-only`  — tracked in Brood but no live Castra session (dead orphan).
 *   - `fold-only`   — in the Herald fold but neither Castra nor Brood (stale
 *                     projection).
 *   - `ok`          — corroborated by the sources that should see it.
 */
export type Divergence = "ok" | "castra-only" | "brood-only" | "fold-only";

/**
 * The operator-meaningful lifecycle state of a unit of work, derived from the
 * Herald slice stage (falling back to the live Castra/Brood status when the
 * fold has no slice). `unknown` when no source carries enough to classify.
 */
export type SessionState =
  | "dispatched"
  | "in-steward"
  | "waiting-on-approval"
  | "waiting-for-merge"
  | "errored"
  | "archived"
  | "unknown";

/** One joined cross-service unit of work — the row the table/JSON renders. */
export interface UnifiedSession {
  /** Deterministic slice id (Herald fold / Castra `metadata.sliceId`). */
  readonly sliceId?: string;
  /** Owning profile (Herald/Castra/Brood agree per-unit). */
  readonly profile: string;
  readonly state: SessionState;
  /** Raw Herald lifecycle stage, when a slice is in the fold (e.g. `pr-open`). */
  readonly stage?: string;
  /** PR number from the folded PR snapshot, when known. */
  readonly pr?: number;
  readonly branch?: string;
  readonly worktreePath?: string;
  /** Docker container id (from the Brood spawn record), when known. */
  readonly containerId?: string;
  /** Castra/agent-deck session id. The live Castra session's id when one is
   *  attached; otherwise falls back to the tracked steward record's agent-deck
   *  session id (a Brood-only orphan still surfaces an addressable id). */
  readonly castraSessionId?: string;
  /** Brood lifecycle status (steward record preferred, else spawn), when tracked. */
  readonly broodStatus?: string;
  /** Brood record kind backing this row (`steward`/`spawn`), when tracked. */
  readonly broodKind?: string;
  /** Session age in ms (from the earliest known createdAt), when derivable. */
  readonly ageMs?: number;
  readonly presence: SessionPresence;
  readonly divergence: Divergence;
  /** Escalation reason when the slice is escalated (`errored`). */
  readonly escalatedReason?: string;
}

/** A source whose query failed — surfaced so a partial view is never silent. */
export interface SourceError {
  readonly source: "brood" | "castra" | "herald" | "profiles";
  /** Profile scope for a per-profile Castra failure; absent for whole-source. */
  readonly profile?: string;
  readonly message: string;
}
