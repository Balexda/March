/**
 * Break-glass admin endpoint (#265) — shared request shape + CLI body builder.
 *
 * `POST /admin/events` lets an operator author a corrective event into Herald's
 * fold through the normal pipeline (validated against the discriminated union,
 * sequenced by Herald's single sequencer, audited), instead of hand-editing the
 * sqlite log or growing dead auto-heal code in the legate loop. This module holds
 * the wire shape and the CLI's body construction so the latter is unit-testable
 * without shelling out.
 */

/** The `POST /admin/events` request body. */
export interface AdminEventRequest {
  /** Owning profile the corrective event is folded into. */
  readonly profile: string;
  /** The inner event — validated against the same union `POST /events` uses. */
  readonly event: Record<string, unknown>;
  /** Who authored it (audit). */
  readonly operator: string;
  /** Why (audit). */
  readonly note: string;
}

/** Flags the `march herald admin event` CLI collects. */
export interface AdminEventFlags {
  readonly profile?: string;
  readonly type?: string;
  readonly note?: string;
  readonly operator?: string;
  // Type-specific event fields (v1 covers `slice.steward.attached`; adding a new
  // event type is just adding flags here + a mapping entry below).
  readonly sliceId?: string;
  readonly sessionId?: string;
  readonly worktreePath?: string;
  readonly branch?: string;
}

/**
 * Map a CLI flag name to the event-body field it populates. Only fields present
 * here are forwarded; everything else the server-side validator enforces. New
 * event types extend this map (and the {@link AdminEventFlags} surface) — the
 * inner event is otherwise built generically, so wiring a new type is trivial.
 */
const EVENT_FIELD_FLAGS: ReadonlyArray<readonly [keyof AdminEventFlags, string]> = [
  ["sliceId", "sliceId"],
  ["sessionId", "sessionId"],
  ["worktreePath", "worktreePath"],
  ["branch", "branch"],
];

/**
 * Build the `POST /admin/events` body from CLI flags. Throws on the universally
 * required flags (`--profile`, `--type`, `--note`, resolved `operator`); the
 * inner event's own required fields (e.g. `slice.steward.attached` needs
 * `--slice-id`/`--session-id`) are left to the server-side union validator so
 * there is exactly one source of truth for event shape.
 */
export function buildAdminEventBody(flags: AdminEventFlags): AdminEventRequest {
  const profile = flags.profile?.trim();
  const type = flags.type?.trim();
  const note = flags.note?.trim();
  const operator = flags.operator?.trim();
  if (!profile) throw new Error("--profile is required.");
  if (!type) throw new Error("--type is required.");
  if (!note) throw new Error("--note is required.");
  if (!operator) throw new Error("--operator is required (defaults to $USER).");

  const event: Record<string, unknown> = { type };
  for (const [flag, field] of EVENT_FIELD_FLAGS) {
    const value = flags[flag];
    if (typeof value === "string" && value.length > 0) event[field] = value;
  }

  return { profile, event, operator, note };
}
