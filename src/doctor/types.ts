/**
 * Shared types for `march doctor` — the read-only stack-consistency battery.
 *
 * `march status` answers "are the services up and reachable?"; `doctor` answers
 * "is the system internally consistent and unwedged?" Each check emits one or
 * more {@link Finding}s rated pass / warn / fail, and — when not passing — names
 * the existing remedy command an operator would run. Doctor never mutates; the
 * remedy is text, not an action.
 */

/** Outcome rating for a single finding. */
export type Severity = "pass" | "warn" | "fail";

/** The diagnostic check categories the battery runs. */
export type CheckId =
  | "token-wiring"
  | "session-consistency"
  | "dispatch-health"
  | "worktree-hygiene"
  | "sync-health";

/** A single diagnosed fact. */
export interface Finding {
  /** Category this finding belongs to. */
  readonly check: CheckId;
  /** Short label (e.g. the profile or service the finding is about). */
  readonly title: string;
  readonly severity: Severity;
  /** One-line human-readable description of what was observed. */
  readonly detail: string;
  /**
   * The existing remedy command to run (e.g. `march brood sweep`). Omitted on a
   * pass, or on a warn that is purely informational. Doctor never runs it.
   */
  readonly remedy?: string;
}

/** All findings produced by one check category. */
export interface CheckResult {
  readonly check: CheckId;
  readonly findings: readonly Finding[];
}

/** Aggregate severity tallies across a report. */
export interface SeverityCounts {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
}

/** The full diagnostic report. */
export interface DoctorReport {
  /** Profile the run was scoped to (`--profile`), or undefined for all. */
  readonly profile?: string;
  readonly checks: readonly CheckResult[];
  /** Every finding, flattened in check order. */
  readonly findings: readonly Finding[];
  readonly counts: SeverityCounts;
  /** True when no finding is a `fail` (the non-zero-exit gate). */
  readonly ok: boolean;
}
