/**
 * End-to-end budgets for Castra's mutating operations, shared by the server
 * (which never runs past them) and {@link CastraClient} (which waits a margin
 * longer, so a caller sees Castra's own answer instead of its own timeout).
 *
 * Each budget covers the whole operation: waiting in Castra's per-session send
 * queue, the agent-deck/tmux steps, inspections, and the one retry after a
 * trust dialog is answered. A mutating step (launch, send, remove) starts only
 * when its full step timeout still fits in what is left, so Castra never kills
 * a mutation part-way because the budget ran short; read-only follow-ups get
 * whatever is left.
 *
 * A caller that stops waiting does not cancel anything: a step that has started
 * runs to completion (or its own timeout) on the server. A client timeout
 * therefore means "unknown", and the caller re-reads (`GET /v1/sessions`)
 * before retrying.
 */

/** `POST /v1/sessions`: the 180s launch subprocess plus the session lookup and auto-mode set. */
export const CASTRA_LAUNCH_BUDGET_MS = 240_000;
/**
 * `POST /v1/sessions/:id/send`: queue wait, the 45s send, the refusal
 * inspection and trust-dialog answer, and one 45s retry.
 */
export const CASTRA_SEND_BUDGET_MS = 100_000;
/** `DELETE /v1/sessions/:id`: the 10s `session remove` (#717). */
export const CASTRA_REMOVE_BUDGET_MS = 10_000;
/** How much longer than the server's budget the client waits. */
export const CASTRA_CLIENT_MARGIN_MS = 15_000;
